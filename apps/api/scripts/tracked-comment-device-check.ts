/**
 * 评论追踪账号的帖子 on a real cloud phone (owner decision 2026-11-18): an own Instagram account comments on / replies
 * under a tracked account's post, sent by that account's cloud phone. Real API, DB, BullMQ, adb, STF and the real
 * Instagram app on the BitBrowser phone bit-ins-02 (no mocks). Since 2026-11-18 there is no test mode (draft first): a
 * scheduled comment is really posted, so this script only collects (read only) and then saves the 「评论」 / 「回复」 as
 * DRAFTS, checks what is shown before 排程 (account, phone, target, text), finds no send task and deletes the drafts.
 * Nothing is scheduled, nothing is pasted or posted. Live sending is tested by the owner himself, by hand.
 *
 *   E2E_API=http://127.0.0.1:<port> API_PORT=<port> npx tsx --env-file=../../.env scripts/tracked-comment-device-check.ts
 *
 * Device access like feed-device-check: an inert external device row in THIS API's DB on the adb port the main API's
 * tunnel keeps open (BIT_ADB_PORT, default 5700); its source config is invalid, so this API never powers the phone or
 * opens a second tunnel. It does NOT take the main API's device lock (never touches the main Redis): check that the
 * main API has nothing scheduled on the phone before running. A scrcpy viewer on the phone stops the script.
 *
 * Budget: 2 Instagram visits (deep links): natgeo collected as a tracked account with 1 post (profile + the post;
 * plus the grid tap that reveals the media ids). End: launcher, keyboard hidden, no dump left.
 */
import { randomBytes } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db, schema, sqlClient } from '../src/db/index.js';
import { activeStorage } from '../src/modules/settings/storage.js';
import { adb } from '../src/services.js';
import { withCaptcha } from './lib/login.js';
import { linkAccount } from './lib/social-link.js';

const API = process.env.E2E_API ?? `http://127.0.0.1:${process.env.API_PORT ?? 3000}`;
const BIT_PORT = Number(process.env.BIT_ADB_PORT ?? 5700);
const OWN_HANDLE = process.env.OWN_HANDLE ?? 'conchadoroperto650';
const OWN_ID = process.env.OWN_EXTERNAL_ID ?? '78090361572';
const TRACKED = process.env.TRACKED_HANDLE ?? 'natgeo';
const MAX_VISITS = 2;
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
const settingKeys = ['risk.device', 'social.limits', 'comments.rules', 'risk.halts'];
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
  const procs = await adb.shell(BIT_PORT, 'ps -A -o ARGS | grep -c "[s]crcpy"; dumpsys activity activities | grep " ResumedActivity"');
  if (Number(procs.trim().split('\n')[0]) > 0) throw new Error('a scrcpy viewer is on the phone (someone is watching it): stopping');
  console.log(`   phone before: ${procs.trim().split('\n')[1]?.trim().slice(0, 140)}`);

  // ---------------------------------------------------------------- setup: user, inert device row, accounts
  const u = await http('POST', '/api/users', admin, { username: `tcd${tag}`, password: pw, role: 'user' });
  userIds.push(u.body.user?.id ?? u.body.id);
  const U = await login(`tcd${tag}`, pw);
  const [src] = await db.insert(schema.deviceSources).values({ type: 'bitbrowser', name: `tcchk-src-${tag}`, config: { apiUrl: 'not a url' } }).returning();
  const [phone] = await db.insert(schema.instances).values({
    name: `tcchk-bit-${tag}`, engine: 'bitbrowser', sourceId: src!.id, externalId: `tcchk-${tag}`,
    adbPort: BIT_PORT, status: 'running', adbState: 'device', bootCompleted: true, spec: { width: 1080, height: 2374, dpi: 480 },
  }).returning();
  extRows.push({ source: src!.id, instance: phone!.id });
  await db.insert(schema.instanceGrants).values({ userId: userIds[0]!, instanceId: phone!.id }).onConflictDoNothing();
  check('pace 10 s, schedules off, 1 post / 5 comments', (await Promise.all([
    http('PUT', '/api/risk/settings', admin, { minIntervalSec: 10, maxPerHour: 60, accountCheckHours: null, feedCollectHours: null, feedPosts: 1, feedCommentsPerPost: 5 }),
  ])).every((x) => x.status === 200));
  // 采集手机 = the phone (granted to U, the account's owner)
  const tr = await http('POST', '/api/tracked-accounts', U, { input: TRACKED, platform: 'instagram', refreshIntervalHours: null, instanceId: phone!.id });
  if (tr.status !== 201 || tr.body.account.instanceId !== phone!.id) throw new Error(`tracked create: ${tr.text}`);
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
  if (!post || !first) throw new Error('collection failed: stopping before the drafts');

  // ---------------------------------------------------------------- account choice
  r = await http('GET', `/api/tracked-accounts/${tracked.id}/reply-accounts`, U);
  check(`account choice offers @${OWN_HANDLE} on the phone`, r.body.items?.length === 1 && r.body.items[0].id === own.id && r.body.items[0].instance.id === phone!.id, r.text);

  // ---------------------------------------------------------------- 1. 「评论」 / 「回复」 saved as drafts, checked before 排程 (no phone)
  // Draft first, no test mode (owner decision 2026-11-18): a scheduled comment would really be posted, so this script
  // never schedules (POST …/submit) anything. It checks what the person sees before 排程, then deletes the drafts.
  const text1 = `测试评论 tracked ✨ ${tag}`;
  r = await http('POST', `/api/tracked-accounts/${tracked.id}/posts/${post.id}/comments`, U, { accountId: own.id, text: text1 });
  const id1 = r.body.reply?.id;
  check('评论 saved as a draft (not scheduled)', r.status === 201 && r.body.reply.status === 'draft', r.text);
  const text2 = `测试回复 tracked 🙂 ${tag}`;
  r = await http('POST', `/api/tracked-accounts/${tracked.id}/posts/${post.id}/comments/${first.id}/replies`, U, { accountId: own.id, text: text2 });
  const id2 = r.body.reply?.id;
  check(`回复 @${first.authorHandle} saved as a draft (not scheduled)`, r.status === 201 && r.body.reply.status === 'draft', r.text);
  const tasks = await db.select().from(T).where(and(eq(T.type, 'comment-reply'), inArray(T.refId, [id1, id2].filter(Boolean))));
  check('no send task exists for either draft (nothing reaches the phone)', tasks.length === 0, String(tasks.length));
  // 排程前校验: what ReplyScheduleModal shows (account, phone, to whom / under which post, text)
  const [p1, p2] = await Promise.all([http('GET', `/api/comment-replies/${id1}`, U), http('GET', `/api/comment-replies/${id2}`, U)]);
  const a = p1.body.reply;
  const b = p2.body.reply;
  check('preview of the post comment: own account, its phone (online), the tracked post (handle + link), the text',
    a?.account?.handle === OWN_HANDLE && a.instance?.id === phone!.id && a.instance.online === true && a.trackedPost?.handle === TRACKED && a.trackedPost.permalink === post.url && a.text === text1 && a.canEdit === true,
    JSON.stringify(a).slice(0, 300));
  check('preview of the reply: the tracked comment replied to (author + text) and the text',
    b?.trackedComment?.authorHandle === first.authorHandle && b.trackedComment.text === first.text && b.text === text2 && b.instance?.id === phone!.id, JSON.stringify(b).slice(0, 300));
  r = await http('GET', `/api/comment-replies?trackedAccountId=${tracked.id}&status=draft`, U);
  check('回复记录 (tracked account, filter 草稿): both drafts', r.body.total === 2, r.text.slice(0, 200));
  const del = await Promise.all([http('DELETE', `/api/comment-replies/${id1}`, U), http('DELETE', `/api/comment-replies/${id2}`, U)]);
  check('both drafts deleted (204), never scheduled', del.every((x) => x.status === 204), del.map((x) => x.status).join(','));
} catch (err) {
  check(`stopped: ${(err as Error).message}`, false);
} finally {
  if (touched) {
    // ---------------------------------------------------------------- the phone afterwards
    check(`Instagram visits (deep links) by this run: ${visits} (≤ ${MAX_VISITS}); collection screens incl. the grid tap: ${screens}`, visits <= MAX_VISITS);
    const after = await adb.shell(BIT_PORT, 'dumpsys activity activities | grep " ResumedActivity"; dumpsys input_method | grep -c "mInputShown=true"; ls /data/local/tmp').catch((e) => String(e));
    const lines = after.trim().split('\n');
    check('phone back on the launcher, keyboard hidden, no dump file left', /Launcher/i.test(lines[0] ?? '') && lines[1]?.trim() === '0' && !/cp-ig-.*\.xml/.test(after), lines.slice(0, 2).join(' | ').slice(0, 200));
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
