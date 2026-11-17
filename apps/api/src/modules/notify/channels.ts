import { eq, sql } from 'drizzle-orm';
import { db, schema } from '../../db/index.js';
import type { AlertChannel } from '../../db/schema.js';
import { badRequest, HttpError } from '../../lib/errors.js';
import { openConfig, publicConfig, sealConfig } from '../../lib/secret-config.js';
import { createTask, registerTaskHandler } from '../tasks/core.js';
import { ChannelFinalError, type AlertMessage, type ChannelDriver } from './channel-driver.js';
import { notify, recover } from './notify.js';
import { ALERT_KINDS, type AlertKind } from './rules.js';
import { telegramDriver } from './telegram.js';

/**
 * Alert channels (告警通道): any number of external destinations (rows in `alert_channels`), each of a type
 * from the registry below. One alert fans out to one `notify-<type>` task per matching enabled channel; the
 * payload names the channel and the alert (kind + short params), never a secret. The task reads the channel
 * when it runs (deleted / disabled meanwhile → not sent). A final failure sets `lastResult` and raises the
 * in-app `channel.failed` alert to admins (never through a channel); the next success recovers it.
 */
const DRIVERS = { telegram: telegramDriver } satisfies Record<string, ChannelDriver<any>>;
export type ChannelType = keyof typeof DRIVERS;
export const CHANNEL_TYPES = Object.keys(DRIVERS) as [ChannelType, ...ChannelType[]];
export const channelTaskType = (type: string) => `notify-${type}`;
const driverFor = (type: string): ChannelDriver<any> | undefined => (DRIVERS as Record<string, ChannelDriver<any>>)[type];

const C = schema.alertChannels;
const SEVERITY_RANK = { info: 0, warning: 1, error: 2 } as const;

export async function getChannel(id: string): Promise<AlertChannel | undefined> {
  const [row] = await db.select().from(C).where(eq(C.id, id));
  return row;
}

/** API form: secrets only as `<field>Set`. */
export function publicChannel(ch: AlertChannel) {
  const driver = driverFor(ch.type);
  return {
    id: ch.id, name: ch.name, type: ch.type, enabled: ch.enabled, kinds: ch.kinds, minSeverity: ch.minSeverity,
    config: driver ? publicConfig(driver, ch.config) : {}, lastResult: ch.lastResult, createdAt: ch.createdAt, updatedAt: ch.updatedAt,
  };
}

/**
 * Validates a channel config for its type and returns the stored form (secrets sealed). On edits the input
 * is merged over the stored config: omitted fields keep their value, and an omitted / empty / null secret
 * keeps the stored one (secrets are required, so they are replaced, never cleared).
 */
export function validChannelConfig(type: string, input: Record<string, unknown>, stored?: unknown): Record<string, unknown> {
  const driver = driverFor(type);
  if (!driver) throw badRequest(`unknown channel type ${type}`, 'alerts.channel_unknown_type', { type });
  const merged: Record<string, unknown> = { ...(stored ? openConfig(driver, stored) : {}), ...input };
  for (const f of driver.secrets) if (stored && (input[f] === undefined || input[f] === null || input[f] === '')) merged[f] = openConfig(driver, stored)[f];
  const parsed = driver.config.safeParse(merged);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const error = `${issue?.path.join('.') ?? ''}: ${issue?.message ?? ''}`;
    throw badRequest(`通道配置不正确：${error}`, 'alerts.channel_invalid_config', { error });
  }
  return sealConfig(driver, parsed.data);
}

/** Enabled channels that receive this kind (kinds filter: empty = all channel kinds; severity floor). */
export async function matchingChannels(kind: AlertKind): Promise<AlertChannel[]> {
  const def = ALERT_KINDS[kind];
  if (!def.channel) return [];
  const rows = await db.select().from(C).where(eq(C.enabled, true));
  return rows.filter((ch) => driverFor(ch.type)
    && (!ch.kinds.length || ch.kinds.includes(kind))
    && (!ch.minSeverity || SEVERITY_RANK[def.severity] >= SEVERITY_RANK[ch.minSeverity]));
}

export interface ChannelPayload extends AlertMessage { channelId: string }

/** One task per channel; the caller never waits for the delivery. */
export async function enqueueChannels(channels: AlertChannel[], msg: AlertMessage): Promise<void> {
  for (const ch of channels) {
    const payload: ChannelPayload = { channelId: ch.id, ...msg };
    await createTask({
      type: channelTaskType(ch.type), label: `${ch.name} · ${msg.kind}${msg.recovered ? ' · recovered' : ''}`,
      refType: 'alert', refId: msg.refId, payload: payload as unknown as Record<string, unknown>,
    });
  }
}

async function setResult(ch: Pick<AlertChannel, 'id'>, r: { ok: boolean; test?: boolean; code?: string | null }): Promise<void> {
  // Plain update: lastResult only, so updatedAt keeps meaning "config last changed".
  await db.update(C).set({ lastResult: { ...r, at: new Date().toISOString() }, updatedAt: sql`${C.updatedAt}` }).where(eq(C.id, ch.id));
}

function configOf(ch: AlertChannel): { driver: ChannelDriver<any>; cfg: Record<string, unknown> } {
  const driver = driverFor(ch.type);
  if (!driver) throw new ChannelFinalError('alerts.channel_unknown_type', `unknown channel type ${ch.type}`, { type: ch.type });
  const parsed = driver.config.safeParse(openConfig(driver, ch.config));
  if (!parsed.success) throw new ChannelFinalError('alerts.channel_invalid_config', 'stored channel config is invalid', { error: parsed.error.issues[0]?.message ?? '' });
  return { driver, cfg: parsed.data };
}

const delivered = (ch: AlertChannel) => recover({ kind: 'channel.failed', refId: ch.id, params: { name: ch.name } });

/** "Send test message" (admin): synchronous, also while disabled. Telegram's refusal is a coded 400. */
export async function testChannel(ch: AlertChannel): Promise<{ ok: true }> {
  try {
    const { driver, cfg } = configOf(ch);
    await driver.send(cfg, { test: true });
  } catch (err) {
    await setResult(ch, { ok: false, test: true, code: (err as { code?: string }).code ?? null });
    if (err instanceof ChannelFinalError) throw new HttpError(400, err.message, err.code, err.params);
    throw err;
  }
  await setResult(ch, { ok: true, test: true });
  await delivered(ch);
  return { ok: true };
}

for (const type of CHANNEL_TYPES) {
  registerTaskHandler<ChannelPayload>(channelTaskType(type), {
    queue: 'task-ops',
    maxAttempts: 4,
    backoffMs: 10_000,
    timeoutMs: 60_000,
    async run(ctx) {
      const p = ctx.payload;
      const ch = await getChannel(p.channelId);
      if (!ch) { await ctx.log('info', 'alert channel deleted: not sent'); return { sent: false }; }
      if (!ch.enabled) { await ctx.log('info', 'alert channel disabled: not sent'); return { sent: false }; }
      if (!ALERT_KINDS[p.kind]) throw new ChannelFinalError('alerts.unknown_kind', `unknown alert kind ${p.kind}`);
      const { driver, cfg } = configOf(ch);
      await driver.send(cfg, { kind: p.kind, recovered: p.recovered, params: p.params, refType: p.refType, refId: p.refId }, ctx.signal);
      await setResult(ch, { ok: true });
      await ctx.log('info', 'alert message sent');
      await delivered(ch);
      return { sent: true };
    },
    async onFailure(task) {
      if (task.status !== 'failed') return;
      const ch = await getChannel(String((task.payload as Partial<ChannelPayload>).channelId ?? '')).catch(() => undefined);
      if (!ch) return;
      await setResult(ch, { ok: false, code: task.errorCode });
      await notify({ kind: 'channel.failed', refId: ch.id, params: { name: ch.name, code: task.errorCode }, inAppOnly: true });
    },
  });
}
