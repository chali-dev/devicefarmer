/**
 * 评论追踪账号的帖子 on a real cloud phone (owner decision 2026-11-18): an own Instagram account comments on / replies
 * under a tracked account's post, sent by that account's cloud phone. Real API, DB, BullMQ, adb, STF and the real
 * Instagram app on the BitBrowser phone bit-ins-02 (no mocks). TEST MODE ONLY: the script refuses to start when the
 * comment rules say testMode=false; nothing is ever posted (paste → read back → clear → back).
 *
 *   E2E_API=http://127.0.0.1:<port> API_PORT=<port> npx tsx --env-file=../../.env scripts/tracked-comment-device-check.ts
 *
 * Device access like feed-device-check: an inert external device row in THIS API's DB on the adb port the main API's
 * tunnel keeps open (BIT_ADB_PORT, default 5700); its source config is invalid, so this API never powers the phone or
 * opens a second tunnel. It does NOT take the main API's device lock (never touches the main Redis): check that the
 * main API has nothing scheduled on the phone before running. A scrcpy viewer on the phone stops the script.
 *
 * Budget: 4 Instagram visits (deep links): natgeo collected as a tracked account with 1 post (profile + the post;
 * plus the grid tap that reveals the media ids), then 1. 「评论」 rehearsal on that post with the own account
 * (post → own account check via the session id → comments → field → paste → read back → clear → back) and 2. 「回复」
 * rehearsal on its first comment (… → the comment's 回复 → paste → read back → clear → cancel → back). Both end
 * dry_run. End: launcher, no dump left, the clipboard overwritten with a space (the test text doesn't stay on it).
 */
import { randomBytes } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db, schema, sqlClient } from '../src/db/index.js';
import { activeStorage } from '../src/modules/settings/storage.js';
import { adb, stf } from '../src/services.js';
import { withCaptcha } from './lib/login.js';
import { linkAccount } from './lib/social-link.js';

const API = process.env.E2E_API ?? `http://127.0.0.1:${process.env.API_PORT ?? 3000}`;
const BIT_PORT = Number(process.env.BIT_ADB_PORT ?? 5700);
const OWN_HANDLE = process.env.OWN_HANDLE ?? 'conchadoroperto650';
const OWN_ID = process.env.OWN_EXTERNAL_ID ?? '78090361572';
const TRACKED = process.env.TRACKED_HANDLE ?? 'natgeo';
const MAX_VISITS = 4;
const results: [string, boolean][] = [];
const check = (name: string, ok: boolean, detail = '') => { results.push([name, ok]); console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`); };
async function http<T = any>(method: string, path: string, token: string | null, body?: unknown) {
  const res = await fetch(API + path, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const buf = Buffer.from(await res.arrayBuffer());
  let json: any = null;
  try { json = JSON.parse(buf.toString('utf8')); } catch { /* binary */ }
  return { status: res.status, body: json as T, text: buf.toString('utf8').slice(0, 400), buf, type: res.headers.get('content-type') ?? '' };
}
async function login(username: string, password: string): Promise<string> {
  const r = await fetch(`${API}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(await withCaptcha(API, { username, password })) });
  return (await r.json()).token;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const T = schema.tasks;
async function waitTask(type: string, refId: string, since: Date, ms = 600_000) {
  const t0 = Date.now();
  for (;;) {
    const rows = await db.select().from(T).where(and(eq(T.type, type), eq(T.refId, refId), sql`${T.createdAt} >= ${since.toISOString()}::timestamptz`));
    const open = rows.filter((r) => !['success', 'failed', 'cancelled'].includes(r.status));
    const done = rows.filter((r) => r.status === 'failed' || (r.status === 'success' && (r.result as any)?.outcome !== 'deferred' && !(r.result as any)?.deferred));
    if (!open.length && done.length) return { final: done[done.length - 1]!, all: rows };
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${type} of ${refId}`);
    await sleep(1500);
  }
}
const logsOf = async (taskIds: string[]) => (taskIds.length ? db.select().from(schema.taskLogs).where(inArray(schema.taskLogs.taskId, taskIds)) : []);
let visits = 0;
let screens = 0;

const admin = await login(process.env.ADMIN_USERNAME!, process.env.ADMIN_PASSWORD!);
const tag = randomBytes(3).toString('hex');
const pw = randomBytes(12).toString('base64url');
const settingKeys = ['risk.device', 'social.limits', 'comments.rules', 'tracked.collectors', 'risk.halts'];
const savedSettings = await db.select().from(schema.settings).where(inArray(schema.settings.key, settingKeys));
const t0 = new Date();
const userIds: string[] = [];
const extRows: { source: string; instance: string }[] = [];
const evidenceKeys: string[] = [];
let touched = false;

try {
  // ---------------------------------------------------------------- preconditions (read only)
  const serial = adb.serialFor(BIT_PORT);
  if ((await adb.states()).get(serial) !== 'device') throw new Error(`${serial} is not attached: bit-ins-02 is off or the main API's tunnel is down — stopping before anything touches it`);
  const rules = (await http('GET', '/api/comments/settings', admin)).body.rules;
  if (rules?.testMode !== true) throw new Error('comment rules say testMode=false: this script only runs in test mode');
  check('test mode is ON (nothing will be posted)', true);
  const procs = await adb.shell(BIT_PORT, 'ps -A -o ARGS | grep -c "[s]crcpy"; dumpsys activity activities | grep " ResumedActivity"');
  if (Number(procs.trim().split('\n')[0]) > 0) throw new Error('a scrcpy viewer is on the phone (someone is watching it): stopping');
  console.log(`   phone before: ${procs.trim().split('\n')[1]?.trim().slice(0, 140)}`);

  // ---------------------------------------------------------------- setup: user, inert device row, accounts
  const u = await http('POST', '/api/users', admin, { username: `tcd${tag}`, password: pw, role: 'user' });
  userIds.push(u.body.user?.id ?? u.body.id);
  const U = await login(`tcd${tag}`, pw);
  const [src] = await db.insert(schema.deviceSources).values({ type: 'bitbrowser', name: `tcchk-src-${tag}`, config: { apiUrl: 'not a url' } }).returning();
  const [phone] = await db.insert(schema.instances).values({
    name: `tcchk-bit-${tag}`, engine: 'bitbrowser', sourceId: src!.id, externalId: `tcchk-${tag}`, profile: 'bitbrowser', image: '',
    adbPort: BIT_PORT, status: 'running', adbState: 'device', bootCompleted: true, spec: { width: 1080, height: 2374, dpi: 480 },
  }).returning();
  extRows.push({ source: src!.id, instance: phone!.id });
  await db.insert(schema.instanceGrants).values({ userId: userIds[0]!, instanceId: phone!.id }).onConflictDoNothing();
  check('pace 10 s, schedules off, 1 post / 5 comments, no gap between the two rehearsals, collector = the phone', (await Promise.all([
    http('PUT', '/api/risk/settings', admin, { minIntervalSec: 10, maxPerHour: 60, accountCheckHours: null, feedCollectHours: null, feedPosts: 1, feedCommentsPerPost: 5 }),
    http('PUT', '/api/comments/settings', admin, { minGapSec: 0 }),
    http('PUT', '/api/settings/tracked-collectors/instagram', admin, { instanceId: phone!.id }),
  ])).every((x) => x.status === 200));
  const tr = await http('POST', '/api/tracked-accounts', U, { input: TRACKED, platform: 'instagram', refreshIntervalHours: null });
  if (tr.status !== 201) throw new Error(`tracked create: ${tr.text}`);
  const tracked = tr.body.account;
  const sa = await http('POST', '/api/social/accounts', admin, { platform: 'instagram', handle: OWN_HANDLE, externalId: OWN_ID, ownerId: userIds[0] });
  // device link: read only in the API since 2026-11-18 (set by 从云手机同步); written with the sync's rules (lib/social-link.ts)
  if (sa.body?.account?.id) await linkAccount(sa.body.account.id, phone!.id);
  if (sa.status !== 201) throw new Error(`social create: ${sa.text}`);
  const own = sa.body.account;

  // ---------------------------------------------------------------- natgeo: newest post + its first comments (2 visits)
  let since = new Date(Date.now() - 2000);
  let r = await http('POST', `/api/tracked-accounts/${tracked.id}/collect`, U);
  touched = true;
  const run1 = await waitTask('feed-collect', tracked.id, since);
  const res1 = run1.final.result as any;
  screens += res1?.screens ?? 0;
  const l1 = await logsOf(run1.all.map((x) => x.id));
  visits += l1.filter((l) => l.message === 'feed: profile opened').length + l1.filter((l) => l.message === 'feed: post read' || l.message === 'feed: post did not show').length;
  console.log(`   collect: ${JSON.stringify(res1)}`);
  const [post] = await db.select().from(schema.trackedPosts).where(eq(schema.trackedPosts.trackedAccountId, tracked.id));
  const comments = post ? await db.select().from(schema.trackedPostComments).where(eq(schema.trackedPostComments.trackedPostId, post.id)) : [];
  const first = comments.filter((c) => !!c.authorHandle).sort((a, b) => (a.position ?? 99) - (b.position ?? 99))[0];
  check(`natgeo collected: 1 post (${post?.url}), ${comments.length} comments`, run1.final.status === 'success' && !!post && !!first, `${run1.final.status} ${run1.final.errorCode}`);
  if (!post || !first) throw new Error('collection failed: stopping before the rehearsals');

  // ---------------------------------------------------------------- account choice
  r = await http('GET', `/api/tracked-accounts/${tracked.id}/reply-accounts`, U);
  check(`account choice offers @${OWN_HANDLE} on the phone`, r.body.items?.length === 1 && r.body.items[0].id === own.id && r.body.items[0].instance.id === phone!.id, r.text);

  // ---------------------------------------------------------------- 1. 「评论」 rehearsal on the tracked post (1 visit)
  const text1 = `测试评论 tracked ✨ ${tag}`;
  since = new Date(Date.now() - 2000);
  r = await http('POST', `/api/tracked-accounts/${tracked.id}/posts/${post.id}/comments`, U, { accountId: own.id, text: text1 });
  check('评论 scheduled (now)', r.status === 201 && r.body.reply.status === 'scheduled', r.text);
  const id1 = r.body.reply?.id;
  const run2 = await waitTask('comment-reply', id1, since);
  const [rep1] = await db.select().from(schema.commentTasks).where(eq(schema.commentTasks.id, id1));
  const l2 = await logsOf(run2.all.map((x) => x.id));
  visits += l2.filter((l) => l.message === 'reply: post opened').length;
  if (rep1?.evidence?.key) evidenceKeys.push(rep1.evidence.key);
  for (const l of l2) console.log(`     · ${l.level} ${l.message}`);
  check('评论 → dry_run (method device), read back = the text exactly, field cleared, not sent', rep1?.status === 'dry_run' && rep1.method === 'device' && rep1.sentAt === null
    && rep1.evidence?.inputText === text1 && l2.some((l) => l.message === 'reply: test mode, not sent; field cleared'), `${rep1?.status} ${rep1?.errorCode} ${rep1?.error} "${rep1?.evidence?.inputText}"`);
  if (rep1?.status !== 'dry_run') throw new Error('comment rehearsal failed: stopping before the reply');

  // ---------------------------------------------------------------- 2. 「回复」 rehearsal on its first comment (1 visit)
  const text2 = `测试回复 tracked 🙂 ${tag}`;
  since = new Date(Date.now() - 2000);
  r = await http('POST', `/api/tracked-accounts/${tracked.id}/posts/${post.id}/comments/${first.id}/replies`, U, { accountId: own.id, text: text2 });
  check(`回复 @${first.authorHandle} scheduled (now)`, r.status === 201 && r.body.reply.status === 'scheduled', r.text);
  const id2 = r.body.reply?.id;
  const run3 = await waitTask('comment-reply', id2, since);
  const [rep2] = await db.select().from(schema.commentTasks).where(eq(schema.commentTasks.id, id2));
  const l3 = await logsOf(run3.all.map((x) => x.id));
  visits += l3.filter((l) => l.message === 'reply: post opened').length;
  if (rep2?.evidence?.key) evidenceKeys.push(rep2.evidence.key);
  for (const l of l3) console.log(`     · ${l.level} ${l.message}`);
  check('回复 → dry_run, read back = "@author " + the text, replying to that comment, field cleared', rep2?.status === 'dry_run' && rep2.method === 'device'
    && (rep2.evidence?.inputText ?? '').endsWith(text2) && (rep2.evidence?.inputText ?? '').toLowerCase().startsWith(`@${first.authorHandle!.toLowerCase()}`)
    && ['reply: replying to the comment', 'reply: text pasted and read back', 'reply: test mode, not sent; field cleared'].every((m) => l3.some((l) => l.message === m)),
  `${rep2?.status} ${rep2?.errorCode} ${rep2?.error} "${rep2?.evidence?.inputText}"`);
  const ev = await http('GET', `/api/comment-replies/${id2}/evidence`, U);
  check('screenshot evidence stored (PNG)', ev.status === 200 && ev.type.startsWith('image/png'), `${ev.status} ${ev.buf.length} bytes`);

  // ---------------------------------------------------------------- records on both sides
  r = await http('GET', `/api/comment-replies?trackedAccountId=${tracked.id}`, U);
  const r2 = await http('GET', `/api/comment-replies?accountId=${own.id}`, U);
  check('回复记录: both dry runs in the tracked account\'s list and in the own account\'s list', r.body.total === 2 && r2.body.items?.filter((x: any) => x.trackedPost?.handle === TRACKED).length === 2, `${r.body.total} ${r2.body.total}`);
} catch (err) {
  check(`stopped: ${(err as Error).message}`, false);
} finally {
  if (touched) {
    // ---------------------------------------------------------------- the phone afterwards
    check(`Instagram visits (deep links) by this run: ${visits} (≤ ${MAX_VISITS}); collection screens incl. the grid tap: ${screens}`, visits <= MAX_VISITS);
    const after = await adb.shell(BIT_PORT, 'dumpsys activity activities | grep " ResumedActivity"; dumpsys input_method | grep -c "mInputShown=true"; ls /data/local/tmp').catch((e) => String(e));
    const lines = after.trim().split('\n');
    check('phone back on the launcher, keyboard hidden, no dump file left', /Launcher/i.test(lines[0] ?? '') && lines[1]?.trim() === '0' && !/cp-ig-.*\.xml/.test(after), lines.slice(0, 2).join(' | ').slice(0, 200));
    // The test text stays on the device clipboard after STF's paste: overwrite it with a space while the launcher is
    // in front and no field is focused (the paste key then goes nowhere).
    if (/Launcher/i.test(lines[0] ?? '') && lines[1]?.trim() === '0') {
      const dev = await stf.getDevice(adb.serialFor(BIT_PORT)).catch(() => null);
      if (dev?.channel) {
        await stf.paste(dev.channel, ' ').then(() => check('clipboard overwritten with a space (test text no longer on it)', true)).catch((e) => check('clipboard overwrite', false, String(e)));
      } else check('clipboard overwrite: STF channel unavailable', false);
    }
  }
  await db.update(T).set({ status: 'cancelled', finishedAt: new Date() }).where(and(inArray(T.status, ['pending', 'scheduled']), sql`${T.createdAt} >= ${t0.toISOString()}::timestamptz`));
  for (const k of evidenceKeys) await (await activeStorage()).delete(k).catch(() => undefined);
  for (const id of userIds) await http('DELETE', `/api/users/${id}`, admin);
  for (const e of extRows) {
    await db.delete(schema.riskEvents).where(eq(schema.riskEvents.instanceId, e.instance));
    await db.delete(schema.instances).where(eq(schema.instances.id, e.instance));
    await db.delete(schema.deviceSources).where(eq(schema.deviceSources.id, e.source));
  }
  await db.delete(schema.settings).where(inArray(schema.settings.key, settingKeys));
  if (savedSettings.length) await db.insert(schema.settings).values(savedSettings);
  const failed = results.filter(([, ok]) => !ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  await sqlClient.end();
  process.exit(failed ? 1 : 0);
}
