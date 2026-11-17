import { UnrecoverableError } from 'bullmq';
import { eq } from 'drizzle-orm';
import { config } from '../../config.js';
import { db, schema } from '../../db/index.js';
import { badRequest, HttpError } from '../../lib/errors.js';
import { openSecret, sealSecret } from '../../lib/secret-box.js';
import { scrub } from '../platforms/http.js';
import { registerTaskHandler } from '../tasks/core.js';
import { ALERT_KINDS, type AlertKind } from './rules.js';

/**
 * Telegram channel (告警通知 → Telegram bot). Admin settings in `settings` key `alerts.telegram`: bot token
 * secret-box sealed and write-only, chat id, enabled, message language. Messages are plain text built here
 * from a template per kind (zh-CN / en) and sent by the device-less `notify-telegram` task (retried on
 * 429/5xx/network, not on other 4xx), so the caller never waits for Telegram. The token is only put in the
 * request URL and scrubbed from any text that is stored or returned.
 */
export const TELEGRAM_TASK = 'notify-telegram';
export const TELEGRAM_LANGS = ['zh-CN', 'en'] as const;
export type TelegramLang = (typeof TELEGRAM_LANGS)[number];
const KEY = 'alerts.telegram';

interface Stored { enabled?: boolean; chatId?: string | null; tokenEnc?: string | null; language?: TelegramLang }
export interface TelegramSettings { enabled: boolean; chatId: string | null; tokenSet: boolean; language: TelegramLang; updatedAt: string | null }

async function load(): Promise<{ v: Stored; updatedAt: Date | null }> {
  const [row] = await db.select().from(schema.settings).where(eq(schema.settings.key, KEY));
  return { v: (row?.value as Stored | undefined) ?? {}, updatedAt: row?.updatedAt ?? null };
}

export async function getTelegramSettings(): Promise<TelegramSettings> {
  const { v, updatedAt } = await load();
  return { enabled: Boolean(v.enabled), chatId: v.chatId ?? null, tokenSet: Boolean(v.tokenEnc), language: v.language ?? 'zh-CN', updatedAt: updatedAt?.toISOString() ?? null };
}

/** Partial update; `token: null` clears the token (and disables the channel). Enabling needs token + chat id. */
export async function saveTelegramSettings(p: { enabled?: boolean; chatId?: string | null; token?: string | null; language?: TelegramLang }): Promise<TelegramSettings> {
  const { v } = await load();
  const next: Stored = {
    enabled: p.enabled ?? v.enabled ?? false,
    chatId: p.chatId !== undefined ? p.chatId : v.chatId ?? null,
    tokenEnc: p.token === null ? null : p.token ? sealSecret(p.token) : v.tokenEnc ?? null,
    language: p.language ?? v.language ?? 'zh-CN',
  };
  if (!next.tokenEnc || !next.chatId) {
    if (p.enabled) throw badRequest('启用 Telegram 需要先填写 Bot Token 和 Chat ID', 'alerts.telegram_incomplete');
    next.enabled = false;
  }
  await db.insert(schema.settings).values({ key: KEY, value: next })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value: next, updatedAt: new Date() } });
  return getTelegramSettings();
}

// ---------------------------------------------------------------- message text

type Tpl = { problem: string; recovered?: string };
const TEXT: Record<TelegramLang, { prefix: [string, string]; kinds: Record<AlertKind, Tpl>; words: Record<string, string>; open: string; test: string }> = {
  'zh-CN': {
    prefix: ['[告警]', '[恢复]'],
    kinds: {
      'device.down': { problem: '设备 {name} 异常：{status}（{reason}）', recovered: '设备 {name} 已恢复运行' },
      'account.problem': { problem: '{platform} 账号 @{handle} 状态异常：{reason}', recovered: '{platform} 账号 @{handle} 已恢复正常' },
      'connection.expired': { problem: '{platform} 账号 @{handle} 的官方接口授权失效：{status}', recovered: '{platform} 账号 @{handle} 的官方接口授权已恢复' },
      'publish.failed': { problem: '发布失败：{platform} @{handle}《{title}》' },
      'task.failed': { problem: '任务失败：{type}（{label}）' },
    },
    words: {
      error: '错误', stopped: '已停止', container_missing: '容器不存在', container_exited: '容器意外退出', sidecar_down: '网络边车未运行',
      powered_off: '手机在平台外关机', op_failed: '操作失败', logged_out: '已登出', needs_verification: '需要验证', limited: '受限',
      suspended: '封禁', disabled: '停用', check_failed: '检查失败', expired: '已过期', revoked: '已撤销',
    },
    open: '查看',
    test: '云手机管理平台：Telegram 告警测试消息',
  },
  en: {
    prefix: ['[ALERT]', '[RECOVERED]'],
    kinds: {
      'device.down': { problem: 'Device {name} is down: {status} ({reason})', recovered: 'Device {name} is running again' },
      'account.problem': { problem: '{platform} account @{handle} has a problem: {reason}', recovered: '{platform} account @{handle} is back to normal' },
      'connection.expired': { problem: 'Official API authorisation of {platform} account @{handle} is no longer valid: {status}', recovered: 'Official API authorisation of {platform} account @{handle} works again' },
      'publish.failed': { problem: 'Publish failed: {platform} @{handle} "{title}"' },
      'task.failed': { problem: 'Task failed: {type} ({label})' },
    },
    words: {
      error: 'error', stopped: 'stopped', container_missing: 'container missing', container_exited: 'container exited unexpectedly', sidecar_down: 'network sidecar not running',
      powered_off: 'phone powered off outside the platform', op_failed: 'operation failed', logged_out: 'logged out', needs_verification: 'needs verification', limited: 'limited',
      suspended: 'suspended', disabled: 'disabled', check_failed: 'check failed', expired: 'expired', revoked: 'revoked',
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

/** Telegram refused the request for good (bad token, chat not found, bot blocked…): never retried. */
class TelegramFinalError extends UnrecoverableError {
  constructor(readonly code: string, message: string, readonly params: Record<string, string | number> = {}) { super(message); }
}
const transient = (status: number, code: string, message: string, params?: Record<string, string | number>) => new HttpError(status, message, code, params);

/** POST sendMessage. Throws HttpError (transient: 429/5xx/network) or TelegramFinalError (other 4xx). */
export async function sendTelegram(token: string, chatId: string, text: string, signal?: AbortSignal): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${config.TELEGRAM_API_BASE.replace(/\/$/, '')}/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 4000), disable_web_page_preview: true }),
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
  if (res.status === 401 || res.status === 404) throw new TelegramFinalError('alerts.telegram_unauthorized', `Telegram Bot Token 无效：${desc}`, { error: desc });
  if (/chat not found/i.test(desc)) throw new TelegramFinalError('alerts.telegram_chat_not_found', `Telegram Chat ID 不存在：${desc}`, { error: desc });
  if (res.status === 403) throw new TelegramFinalError('alerts.telegram_forbidden', `Bot 无权向该 Chat 发消息：${desc}`, { error: desc });
  throw new TelegramFinalError('alerts.telegram_rejected', `Telegram 拒绝了请求（${res.status}）：${desc}`, { status: res.status, error: desc });
}

async function credentials(): Promise<{ token: string; chatId: string; language: TelegramLang } | null> {
  const { v } = await load();
  if (!v.tokenEnc || !v.chatId) return null;
  return { token: openSecret(v.tokenEnc), chatId: v.chatId, language: v.language ?? 'zh-CN' };
}

/** "Send test message" (admin): synchronous, uses the stored settings (even while disabled). Errors are coded 4xx/5xx. */
export async function sendTestMessage(): Promise<{ ok: true }> {
  const c = await credentials();
  if (!c) throw badRequest('请先保存 Bot Token 和 Chat ID', 'alerts.telegram_incomplete');
  try {
    await sendTelegram(c.token, c.chatId, TEXT[c.language].test);
  } catch (err) {
    if (err instanceof TelegramFinalError) throw new HttpError(400, err.message, err.code, err.params);
    throw err;
  }
  return { ok: true };
}

export interface TelegramPayload { kind: AlertKind; recovered: boolean; params: Record<string, string | number>; refType: string | null; refId: string | null }

registerTaskHandler<TelegramPayload>(TELEGRAM_TASK, {
  queue: 'task-ops',
  maxAttempts: 4,
  backoffMs: 10_000,
  timeoutMs: 60_000,
  async run(ctx) {
    const s = await getTelegramSettings();
    const c = s.enabled ? await credentials() : null;
    if (!c) { await ctx.log('info', 'telegram disabled: not sent'); return { sent: false }; }
    const p = ctx.payload;
    if (!ALERT_KINDS[p.kind]) throw new TelegramFinalError('alerts.unknown_kind', `unknown alert kind ${p.kind}`);
    await sendTelegram(c.token, c.chatId, alertText(c.language, p.kind, p.recovered, p.params, alertPath(p.refType, p.refId, p.params)), ctx.signal);
    await ctx.log('info', 'telegram message sent');
    return { sent: true };
  },
});
