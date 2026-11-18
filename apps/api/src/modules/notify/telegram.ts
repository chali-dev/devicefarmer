import { z } from 'zod';
import { config } from '../../config.js';
import { HttpError } from '../../lib/errors.js';
import { ChannelFinalError, type ChannelDriver } from './channel-driver.js';
import type { AlertKind } from './rules.js';

/** Replaces every secret (e.g. the bot token) in a text that may be stored or shown. */
function scrub(text: string, secrets: (string | null | undefined)[]): string {
  let out = text;
  for (const s of secrets) if (s && s.length >= 6) out = out.split(s).join('***');
  return out.slice(0, 300);
}

/**
 * Telegram alert channel type (告警通道 → Telegram bot): one driver for any number of channels
 * (alert_channels rows of type `telegram`). Config: bot token (secret: sealed, write-only), chat id,
 * optional forum topic (message thread) id, message language. Messages are plain text built here from a
 * template per kind (zh-CN / en). Sent by the `notify-telegram` task (channels.ts): retried on
 * 429/5xx/network, not on other 4xx. The token is only put in the request URL and scrubbed from any text
 * that is stored or returned.
 */
export const TELEGRAM_LANGS = ['zh-CN', 'en'] as const;
export type TelegramLang = (typeof TELEGRAM_LANGS)[number];

const TelegramConfig = z.object({
  /** BotFather token `<bot id>:<secret>`. */
  botToken: z.string({ error: 'bot token required' }).trim().regex(/^\d{3,20}:[A-Za-z0-9_-]{30,64}$/, 'invalid bot token'),
  /** Numeric chat id (groups/channels are negative) or @channelusername. */
  chatId: z.string({ error: 'chat id required' }).trim().regex(/^(-?\d{1,20}|@[A-Za-z][A-Za-z0-9_]{4,31})$/, 'invalid chat id'),
  /** Forum topic of a supergroup (message_thread_id); null = the general chat. */
  threadId: z.number().int().min(1).max(2 ** 31 - 1).nullable().default(null),
  language: z.enum(TELEGRAM_LANGS).default('zh-CN'),
}).strict();
type TelegramConfig = z.infer<typeof TelegramConfig>;

// ---------------------------------------------------------------- message text

type Tpl = { problem: string; recovered?: string };
const TEXT: Record<TelegramLang, { prefix: [string, string]; kinds: Record<AlertKind, Tpl>; words: Record<string, string>; open: string; test: string }> = {
  'zh-CN': {
    prefix: ['[告警]', '[恢复]'],
    kinds: {
      'device.down': { problem: '设备 {name} 异常：{status}（{reason}）', recovered: '设备 {name} 已恢复运行' },
      'account.problem': { problem: '{platform} 账号 @{handle} 状态异常：{reason}', recovered: '{platform} 账号 @{handle} 已恢复正常' },
      'publish.failed': { problem: '发布失败：{platform} @{handle}《{title}》' },
      'task.failed': { problem: '任务失败：{type}（{label}）' },
      'collector.blocked': { problem: '采集设备 {name} 遇到 {platform} 验证/限制页面，采集已停止，需人工处理', recovered: '采集设备 {name} 的 {platform} 采集已恢复' },
      'channel.failed': { problem: '告警通道 {name} 发送失败', recovered: '告警通道 {name} 已恢复' },
    },
    words: {
      error: '错误', stopped: '已停止', container_missing: '容器不存在', container_exited: '容器意外退出', sidecar_down: '网络边车未运行',
      powered_off: '手机在平台外关机', op_failed: '操作失败', logged_out: '已登出', wrong_account: '云手机上登录的是其他账号', needs_verification: '需要验证', limited: '受限',
      suspended: '封禁', disabled: '停用',
    },
    open: '查看',
    test: '云手机管理平台：Telegram 告警测试消息',
  },
  en: {
    prefix: ['[ALERT]', '[RECOVERED]'],
    kinds: {
      'device.down': { problem: 'Device {name} is down: {status} ({reason})', recovered: 'Device {name} is running again' },
      'account.problem': { problem: '{platform} account @{handle} has a problem: {reason}', recovered: '{platform} account @{handle} is back to normal' },
      'publish.failed': { problem: 'Publish failed: {platform} @{handle} "{title}"' },
      'task.failed': { problem: 'Task failed: {type} ({label})' },
      'collector.blocked': { problem: 'Collector device {name} hit a {platform} verification / limit screen: collection stopped, needs a person', recovered: '{platform} collection on device {name} works again' },
      'channel.failed': { problem: 'Alert channel {name} failed to deliver', recovered: 'Alert channel {name} works again' },
    },
    words: {
      error: 'error', stopped: 'stopped', container_missing: 'container missing', container_exited: 'container exited unexpectedly', sidecar_down: 'network sidecar not running',
      powered_off: 'phone powered off outside the platform', op_failed: 'operation failed', logged_out: 'logged out', wrong_account: 'another account is logged in on the phone', needs_verification: 'needs verification', limited: 'limited',
      suspended: 'suspended', disabled: 'disabled',
    },
    open: 'Open',
    test: 'Cloud phone platform: Telegram alert test message',
  },
};

/** Web path of the referenced object (shared with the UI's links). */
export function alertPath(refType: string | null, refId: string | null, params: Record<string, string | number>): string | null {
  if (!refId) return null;
  if (refType === 'instance') return `/instances/${refId}`;
  if (refType === 'social_account') return `/social?q=${encodeURIComponent(String(params.handle ?? ''))}`;
  if (refType === 'publish') return `/publish?task=${refId}`;
  if (refType === 'task') return `/tasks?task=${refId}`;
  if (refType === 'alert_channel') return '/alert-channels';
  return null;
}

export function alertText(lang: TelegramLang, kind: AlertKind, recovered: boolean, params: Record<string, string | number>, path: string | null): string {
  const L = TEXT[lang];
  const tpl = L.kinds[kind];
  const raw = (recovered ? tpl.recovered : undefined) ?? tpl.problem;
  const body = raw.replace(/\{(\w+)\}/g, (_m, k: string) => {
    const v = params[k];
    if (v === undefined || v === '') return '-';
    return L.words[String(v)] ?? String(v);
  });
  const lines = [`${L.prefix[recovered ? 1 : 0]} ${body}`];
  if (!recovered && typeof params.code === 'string' && params.code) lines.push(`code: ${params.code}`);
  if (path) lines.push(`${L.open}: ${(config.PUBLIC_BASE_URL ?? config.WEB_ORIGIN).replace(/\/$/, '')}${path}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------- sending

const transient = (status: number, code: string, message: string, params?: Record<string, string | number>) => new HttpError(status, message, code, params);

/** POST sendMessage. Throws HttpError (transient: 429/5xx/network) or ChannelFinalError (other 4xx). */
export async function sendTelegram(token: string, chatId: string, text: string, signal?: AbortSignal, threadId?: number | null): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${config.TELEGRAM_API_BASE.replace(/\/$/, '')}/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 4000), disable_web_page_preview: true, ...(threadId ? { message_thread_id: threadId } : {}) }),
      signal: AbortSignal.any([AbortSignal.timeout(15_000), ...(signal ? [signal] : [])]),
    });
  } catch (err) {
    if (signal?.aborted) throw signal.reason;
    throw transient(502, 'alerts.telegram_unreachable', `Telegram 无法访问：${(err as Error).name}`, { error: (err as Error).name });
  }
  const body = await res.json().catch(() => ({})) as { ok?: boolean; description?: string };
  if (res.ok && body.ok !== false) return;
  const desc = scrub(String(body.description ?? res.statusText), [token]).slice(0, 200);
  if (res.status === 429) throw transient(429, 'alerts.telegram_rate_limited', `Telegram 限流：${desc}`, { error: desc });
  if (res.status >= 500) throw transient(502, 'alerts.telegram_unavailable', `Telegram 服务异常（${res.status}）`, { status: res.status, error: desc });
  if (res.status === 401 || res.status === 404) throw new ChannelFinalError('alerts.telegram_unauthorized', `Telegram Bot Token 无效：${desc}`, { error: desc });
  if (/chat not found/i.test(desc)) throw new ChannelFinalError('alerts.telegram_chat_not_found', `Telegram Chat ID 不存在：${desc}`, { error: desc });
  if (res.status === 403) throw new ChannelFinalError('alerts.telegram_forbidden', `Bot 无权向该 Chat 发消息：${desc}`, { error: desc });
  throw new ChannelFinalError('alerts.telegram_rejected', `Telegram 拒绝了请求（${res.status}）：${desc}`, { status: res.status, error: desc });
}

export const telegramDriver: ChannelDriver<TelegramConfig> = {
  config: TelegramConfig as unknown as z.ZodType<TelegramConfig>,
  secrets: ['botToken'],
  async send(c, msg, signal) {
    const text = 'test' in msg ? TEXT[c.language].test : alertText(c.language, msg.kind, msg.recovered, msg.params, alertPath(msg.refType, msg.refId, msg.params));
    await sendTelegram(c.botToken, c.chatId, text, signal, c.threadId);
  },
};
