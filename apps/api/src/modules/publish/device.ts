import { Readable } from 'node:stream';
import { and, eq, gte, ne, sql } from 'drizzle-orm';
import { db, schema } from '../../db/index.js';
import type { Instance, PublishTask, ReplyEvidence } from '../../db/schema.js';
import { isPlatformEnabled } from '../../lib/platforms-enabled.js';
import { getInstance } from '../instances/repo.js';
import { recordRiskEvent } from '../risk/events.js';
import { activeStorage } from '../settings/storage.js';
import { platformById } from '../social/platforms.js';
import { TaskError } from '../tasks/core.js';
import { CollectorDefer, deviceHalt, haltDevice, lockFor, withDevice } from '../tracked/collector.js';
import { getDevicePublishRules } from './device-rules.js';
import { publishOnIg, PublishDeviceError } from './ig-publish.js';
import { DEVICE_METHOD, PublishCheckError, registerPublishMethod, type PublishInput, type PublishMethodResult, type PublishRunContext } from './methods.js';

/**
 * 云手机发帖 (method `device`, owner decision 2026-11-18): the account's own cloud phone publishes the post in the
 * Instagram app (ig-publish.ts) at the scheduled time; `manual` stays the fallback.
 *
 * Available for an Instagram account linked to a phone, with media, as 帖子 (images; a carousel adds items 2..N in
 * the app's gallery), Reels (1 video) or 快拍 (1 image / video). Else the run goes to the operator with the reason
 * (`publish.device_*`). Rules (风控 → 云手机发帖, device-rules.ts): per account ≤ postsPerDay device runs (that reached 分享) per rolling
 * 24 h and ≥ minGapMin between two; over them → a new round at the allowed time. The
 * phone work runs under `withDevice` (one operation per phone, shared pace with collection / checks / comments,
 * nobody watching); busy / paced → a new round. A halted phone (风控) parks the run (scheduled, no task) until an
 * admin resumes it; a verification / rate-limit screen halts it (alert + 风控记录). No test mode (removed
 * 2026-11-18): a run exists only because a person distributed the content, so it shares for real; the screenshot
 * before 分享 stays on the task as evidence. After 分享 without confirmation →
 * `publish.send_uncertain`, handed to the operator, never re-sent automatically.
 */
const pt = schema.publishTasks;
const DAY_MS = 86_400_000;
/** Codes written to 风控记录 (besides challenges). */
const RISKY = new Set(['publish.device_wrong_account', 'publish.device_logged_out', 'publish.send_uncertain', 'publish.device_text_mismatch',
  'publish.device_discard_failed', 'publish.device_media_not_found']);

async function storeEvidence(row: PublishTask, shot: Buffer | null, inputText: string, excerpt: string): Promise<ReplyEvidence> {
  const ev: ReplyEvidence = { at: new Date().toISOString(), inputText: inputText.slice(0, 2200), excerpt };
  if (!shot) return ev;
  try {
    const storage = await activeStorage();
    const key = `evidence/publish/${row.id}-r${row.attemptNo}.png`;
    await storage.put(key, Readable.from([shot]), shot.length, 'image/png');
    return { ...ev, storage: storage.kind, key };
  } catch { return ev; }
}

/**
 * Reserves this run against the account's daily cap / minimum gap (per-account advisory lock): sets
 * device_run_at = now, or says when the next run may start. Returns the previous value to undo the reservation
 * when the run ends without 分享 having been tapped (owner decision 2026-11-18: a phone that never started, and any
 * failure before 分享 (text mismatch, push failed, timeout, wrong account, logged out, media not found, discard
 * failed, a challenge screen, a cancel / task timeout) does not count toward postsPerDay / minGapMin; published,
 * `publish.send_uncertain` and every error after 分享 keep it).
 */
async function reserve(row: PublishTask, rules: { postsPerDay: number; minGapMin: number }):
  Promise<{ ok: true; prev: Date | null } | { ok: false; at: Date; code: string; message: string; data: Record<string, unknown> }> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`publish-device:${row.accountId}`}, 0))`);
    const now = Date.now();
    const runs = await tx.select({ at: pt.deviceRunAt }).from(pt)
      .where(and(eq(pt.accountId, row.accountId), ne(pt.id, row.id), gte(pt.deviceRunAt, new Date(now - DAY_MS))));
    const times = runs.map((r) => r.at!.getTime()).sort((a, b) => a - b);
    if (times.length >= rules.postsPerDay) {
      const at = new Date(Math.max(times[times.length - rules.postsPerDay]! + DAY_MS, now) + 5_000);
      return { ok: false as const, at, code: 'publish.daily_limited', message: `daily limit reached (${times.length}/${rules.postsPerDay} per 24 h)`, data: { limit: rules.postsPerDay } };
    }
    const last = times[times.length - 1];
    if (rules.minGapMin > 0 && last && now - last < rules.minGapMin * 60_000) {
      return { ok: false as const, at: new Date(last + rules.minGapMin * 60_000 + 1_000), code: 'publish.min_gap', message: `minimum gap between two posts not reached (${rules.minGapMin} min)`, data: { minGapMin: rules.minGapMin } };
    }
    const [cur] = await tx.select({ prev: pt.deviceRunAt }).from(pt).where(eq(pt.id, row.id));
    await tx.update(pt).set({ deviceRunAt: new Date(now) }).where(eq(pt.id, row.id));
    return { ok: true as const, prev: cur?.prev ?? null };
  });
}
const unreserve = (row: PublishTask, prev: Date | null) => db.update(pt).set({ deviceRunAt: prev }).where(eq(pt.id, row.id));

/** What a run needs from the phone side; replaceable only by scripts/device-publish-check.ts (no phone there). */
export interface DeviceRunDeps { withDevice: typeof withDevice; flow: typeof publishOnIg }
const realDeps: DeviceRunDeps = { withDevice, flow: publishOnIg };

export async function runDevicePublish(input: PublishInput, ctx: PublishRunContext, deps: DeviceRunDeps = realDeps): Promise<PublishMethodResult> {
  const { row, log } = ctx;
  const acc = input.account;
  const inst: Instance | undefined = acc.instanceId ? await getInstance(acc.instanceId) : undefined;
  if (!inst) throw new PublishCheckError('publish.no_device', 'the linked device no longer exists');
  if (await deviceHalt(inst.id)) return { state: 'parked', code: 'publish.device_halted', device: inst.name };
  const rules = await getDevicePublishRules();
  const r = await reserve(row, rules);
  if (!r.ok) return { state: 'deferred', at: r.at, code: r.code, message: r.message, data: r.data };
  await log('info', 'cloud phone: live (shares the post)', { device: inst.name });
  const offline = () => new TaskError('publish.device_offline', `device ${inst.name} is offline`);
  let started = false;
  /** 分享 was tapped (set by the flow right before the tap): from then on the run counts, whatever happens. */
  let shared = false;
  try {
    const res = await deps.withDevice(inst, ctx.task.log, offline, (dev) => {
      started = true;
      return deps.flow(dev, {
        publishTaskId: row.id, round: row.attemptNo, postType: input.postType, handle: acc.handle, externalId: acc.externalId,
        media: input.media, text: input.postType === 'story' ? '' : input.text, log: ctx.task.log, signal: ctx.task.signal,
        onShare: () => { shared = true; },
      });
    }, { lockMs: lockFor(ctx.task.task.timeoutMs, 12 * 60_000), weight: 6, what: 'publish' });
    const evidence = await storeEvidence(row, res.screenshot, res.inputText, res.excerpt);
    return { state: 'published', externalId: res.externalId ?? null, url: res.url ?? null, publishedAt: res.publishedAt ?? null, evidence, data: { device: inst.name, screens: res.screens } };
  } catch (err) {
    if (!shared) {
      await unreserve(row, r.prev);
      if (started) await log('info', 'failed before 分享: not counted toward the daily cap / minimum gap');
    }
    // adb doesn't see the phone although the device row says online: an operator takes it (like comments).
    if (!started && err instanceof TaskError && err.code === 'publish.device_offline') return { state: 'unavailable', reason: 'publish.device_offline' };
    if (err instanceof CollectorDefer) return { state: 'deferred', at: err.runAt, code: err.code, message: `device busy or paced (${err.code})` };
    if (err instanceof PublishDeviceError) {
      const code = err.code ?? 'publish.device_failed';
      if (err.opts.challenge || RISKY.has(code)) {
        await recordRiskEvent({ instance: inst, socialAccountId: acc.id, source: 'publish', code: err.opts.challenge ? 'publish.device_challenge' : code, detail: err.opts.excerpt ?? `@${acc.handle}`, userId: row.createdBy });
      }
      if (err.opts.excerpt) await log('warn', 'device screen excerpt', { excerpt: err.opts.excerpt });
      // A screenshot of the failing screen (e.g. the caption that didn't match) stays on the task as evidence.
      if (err.opts.shot) await db.update(pt).set({ evidence: await storeEvidence(row, err.opts.shot, '', err.opts.excerpt ?? '') }).where(eq(pt.id, row.id));
      if (err.opts.challenge) {
        await haltDevice(inst, { code: 'publish.device_challenge', source: 'publish', platform: acc.platform, socialAccountId: acc.id });
        if (!err.opts.afterSend) return { state: 'parked', code: 'publish.device_halted', device: inst.name };
      }
      if (err.opts.afterSend) return { state: 'awaiting_operator', code, message: err.message };
      throw new PublishCheckError(code, err.message);
    }
    throw err;
  }
}

registerPublishMethod({
  id: DEVICE_METHOD,
  priority: 10,
  async unavailable(input) {
    if (!platformById(input.platform)?.deviceCheck || !isPlatformEnabled(input.platform)) return 'publish.device_unsupported_platform';
    if (!input.account.instanceId) return 'publish.device_no_device';
    if (!input.media.length) return 'publish.device_no_media';
    // A single video as 帖子 becomes a Reel in the app, and video items in a carousel were not probed: by hand.
    if (input.postType === 'feed' && input.media.some((m) => m.fileType !== 'image')) return 'publish.device_feed_video';
    return null;
  },
  run: (input, ctx) => runDevicePublish(input, ctx),
});
