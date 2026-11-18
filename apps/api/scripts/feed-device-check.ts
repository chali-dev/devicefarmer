/**
 * 帖子与评论 + 云手机发评论 on a real cloud phone (owner decision 2026-11-18): real API, DB, BullMQ, adb, STF and the
 * real Instagram app on the BitBrowser phone bit-ins-02 (no mocks). TEST MODE ONLY: the script refuses to start
 * when the comment rules say testMode=false, and nothing is ever posted (the flow stops after paste + read back,
 * clears the field and goes back). Navigation, screen reads, the taps/scrolls to open posts / comments / the
 * reply field, and the paste only: no likes, follows, DMs, profile edits, no power on/off, no installs.
 *
 *   E2E_API=http://127.0.0.1:<port> API_PORT=<port> [MAIN_LOCK_DEVICE=<id of bit-ins-02 in the main API>] \
 *     npx tsx --env-file=../../.env scripts/feed-device-check.ts
 *
 * Device access like account-device-check: an inert external device row in THIS API's DB on the adb port the main
 * API's tunnel keeps open (BIT_ADB_PORT, default 5700); its source config is invalid, so this API never powers the
 * phone or opens a second tunnel. MAIN_LOCK_DEVICE: holds the main API's per-device automation lock (Redis
 * MAIN_REDIS_URL, default REDIS_URL with db 0) for the run, so the main API's scheduled collector / checks defer
 * instead of opening screens in between. A scrcpy viewer on the phone (someone watching) stops the script.
 *
 * Screen budget: ≤ 12 Instagram screens (MAX_SCREENS; a screen = a deep link or a grid tap):
 *   1. natgeo as a tracked account, newest 3 posts + ≤ 30 comments each (5 screens): ids = media pks, permalinks,
 *      counts > 0, comments > 0, no duplicate comment per post;
 *   2. again with 1 post / 10 comments (3 screens): no new post row, no duplicate comments, first_seen kept;
 *   3. social account conchadoroperto650 on the phone (0 posts): profile only (1 screen), empty result;
 *   4. reply rehearsal in test mode on a natgeo comment just collected (1 screen): post → comments → the comment's
 *      回复 → paste (zh + emoji) → read back equal → screenshot → clear → back; reply ends dry_run;
 *   5. direct comment rehearsal in test mode on a natgeo post (1 screen): post → comments → field → paste → read
 *      back → clear → back; dry_run.
 * End: launcher, no dump left in /data/local/tmp.
 */
import { randomBytes } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { db, schema, sqlClient } from '../src/db/index.js';
import { pkTime, shortcodeOf } from '../src/modules/feed/ig-ui.js';
import { activeStorage } from '../src/modules/settings/storage.js';
import { adb } from '../src/services.js';
import { withCaptcha } from './lib/login.js';
import { linkAccount } from './lib/social-link.js';

const API = process.env.E2E_API ?? `http://127.0.0.1:${process.env.API_PORT ?? 3000}`;
const BIT_PORT = Number(process.env.BIT_ADB_PORT ?? 5700);
const OWN_HANDLE = process.env.OWN_HANDLE ?? 'conchadoroperto650';
const OWN_ID = process.env.OWN_EXTERNAL_ID ?? '78090361572';
const TRACKED = process.env.TRACKED_HANDLE ?? 'natgeo';
const MAX_SCREENS = 12;
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
/** Final task of a chain (pace deferrals re-create it) of `type` for `refId` created after `since`. */
async function waitTask(type: string, refId: string, since: Date, ms = 600_000) {
  const t0 = Date.now();
  for (;;) {
    const rows = await db.select().from(T).where(and(eq(T.type, type), eq(T.refId, refId), sql`${T.createdAt} >= ${since.toISOString()}::timestamptz`));
    const open = rows.filter((r) => !['success', 'failed', 'cancelled'].includes(r.status));
    const done = rows.filter((r) => r.status === 'failed' || (r.status === 'success' && !['deferred'].includes((r.result as any)?.outcome) && !(r.result as any)?.deferred));
    if (!open.length && done.length) return { final: done[done.length - 1]!, all: rows };
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${type} of ${refId}`);
    await sleep(1500);
  }
}
const logsOf = async (taskIds: string[]) => (taskIds.length ? db.select().from(schema.taskLogs).where(inArray(schema.taskLogs.taskId, taskIds)) : []);
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
let mainLock: { redis: Redis; key: string; token: string; timer: NodeJS.Timeout } | null = null;

try {
  // ---------------------------------------------------------------- preconditions (read only)
  const serial = adb.serialFor(BIT_PORT);
  if ((await adb.states()).get(serial) !== 'device') throw new Error(`${serial} is not attached: bit-ins-02 is off or the main API's tunnel is down — stopping before anything touches it`);
  const rules = (await http('GET', '/api/comments/settings', admin)).body.rules;
  if (rules?.testMode !== true) throw new Error('comment rules say testMode=false: this script only runs in test mode');
  check('test mode is ON (nothing will be posted)', true);
  if (process.env.MAIN_LOCK_DEVICE) {
    const redis = new Redis(process.env.MAIN_REDIS_URL ?? process.env.REDIS_URL!.replace(/\/\d+$/, '/0'), { maxRetriesPerRequest: 2 });
    const key = `tracked:collector:lock:${process.env.MAIN_LOCK_DEVICE}`;
    const token = `feed-device-check-${tag}`;
    for (let i = 0; ; i++) {
      if ((await redis.set(key, token, 'PX', 30 * 60_000, 'NX')) === 'OK') break;
      if (i > 120) throw new Error('the main API keeps the phone busy');
      await sleep(5000);
    }
    mainLock = { redis, key, token, timer: setInterval(() => { void redis.set(key, token, 'PX', 30 * 60_000, 'XX'); }, 5 * 60_000) };
    console.log('   main API lock held for the run');
  }
  const procs = await adb.shell(BIT_PORT, 'ps -A -o ARGS | grep -c "[s]crcpy"; dumpsys activity activities | grep " ResumedActivity"');
  if (Number(procs.trim().split('\n')[0]) > 0) throw new Error('a scrcpy viewer is on the phone (someone is watching it): stopping');
  console.log(`   phone before: ${procs.trim().split('\n')[1]?.trim().slice(0, 140)}`);

  // ---------------------------------------------------------------- setup: users, inert device row, accounts
  const u = await http('POST', '/api/users', admin, { username: `fdd${tag}`, password: pw, role: 'user' });
  userIds.push(u.body.user?.id ?? u.body.id);
  const U = await login(`fdd${tag}`, pw);
  const [src] = await db.insert(schema.deviceSources).values({ type: 'bitbrowser', name: `fdchk-src-${tag}`, config: { apiUrl: 'not a url' } }).returning();
  const [phone] = await db.insert(schema.instances).values({
    name: `fdchk-bit-${tag}`, engine: 'bitbrowser', sourceId: src!.id, externalId: `fdchk-${tag}`, profile: 'bitbrowser', image: '',
    adbPort: BIT_PORT, status: 'running', adbState: 'device', bootCompleted: true, spec: { width: 1080, height: 2374, dpi: 480 },
  }).returning();
  extRows.push({ source: src!.id, instance: phone!.id });
  await db.insert(schema.instanceGrants).values({ userId: userIds[0]!, instanceId: phone!.id }).onConflictDoNothing();
  check('pace 10 s, schedules off for the run, 3 posts / 30 comments, collector = the phone', (await Promise.all([
    http('PUT', '/api/risk/settings', admin, { minIntervalSec: 10, maxPerHour: 60, accountCheckHours: null, feedCollectHours: null, feedPosts: 3, feedCommentsPerPost: 30 }),
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

  // ---------------------------------------------------------------- 1. natgeo: newest 3 posts + comments (5 screens)
  let since = new Date(Date.now() - 2000);
  let r = await http('POST', `/api/tracked-accounts/${tracked.id}/collect`, U);
  check('tracked 立即采集 → 202', r.status === 202, r.text);
  const run1 = await waitTask('feed-collect', tracked.id, since);
  const res1 = run1.final.result as any;
  screens += res1?.screens ?? 0;
  console.log(`   run 1: ${JSON.stringify(res1)}`);
  const P = schema.trackedPosts;
  const K = schema.trackedPostComments;
  const posts1 = await db.select().from(P).where(eq(P.trackedAccountId, tracked.id));
  const comments1 = await db.select().from(K).where(eq(K.trackedAccountId, tracked.id));
  for (const p of posts1) console.log(`   post ${shortcodeOf(p.externalId)} ${p.publishedAt?.toISOString()} ${p.mediaType} likes=${p.likes} comments=${p.comments} read=${comments1.filter((c) => c.trackedPostId === p.id).length} · ${(p.title ?? '').slice(0, 60)}`);
  check(`collection ok: ${posts1.length} posts (≤ 3), source device, media pk ids, permalinks /p/<shortcode>/`, run1.final.status === 'success' && posts1.length >= 1 && posts1.length <= 3
    && posts1.every((p) => /^\d{15,}$/.test(p.externalId) && p.url === `https://www.instagram.com/p/${shortcodeOf(p.externalId)}/` && p.source === 'device'), `${run1.final.status} ${run1.final.errorCode}`);
  check('published time = the media pk time, newest first (the 3 largest pks)', posts1.every((p) => p.publishedAt?.getTime() === pkTime(p.externalId).getTime()));
  check('counts read: likes > 0 on every post, comment counts present', posts1.every((p) => (p.likes ?? 0) > 0 && p.comments !== null), JSON.stringify(posts1.map((p) => [p.likes, p.comments])));
  const perPost = posts1.map((p) => comments1.filter((c) => c.trackedPostId === p.id));
  check(`comments read: ${comments1.length} in total, > 0, ≤ 30 per post, authors + texts present`, comments1.length > 0 && perPost.every((cs) => cs.length <= 30)
    && comments1.every((c) => !!c.authorHandle && !!c.text), perPost.map((cs) => cs.length).join(','));
  check('no duplicate comment per post (unique stable ids)', perPost.every((cs) => new Set(cs.map((c) => c.externalId)).size === cs.length));
  if (run1.final.status !== 'success' || !posts1.length || !comments1.length) throw new Error('first collection failed: stopping before more screens');
  for (const c of comments1.slice(0, 3)) console.log(`   comment @${c.authorHandle}: ${c.text.slice(0, 50)} (likes ${c.likes}, ${c.publishedAt?.toISOString() ?? '?'})`);

  // ---------------------------------------------------------------- 2. again, 1 post / 10 comments (3 screens): no duplicates
  await http('PUT', '/api/risk/settings', admin, { feedPosts: 1, feedCommentsPerPost: 10 });
  since = new Date(Date.now() - 2000);
  r = await http('POST', `/api/tracked-accounts/${tracked.id}/collect`, U);
  const run2 = await waitTask('feed-collect', tracked.id, since);
  const res2 = run2.final.result as any;
  screens += res2?.screens ?? 0;
  console.log(`   run 2: ${JSON.stringify(res2)}`);
  const posts2 = await db.select().from(P).where(eq(P.trackedAccountId, tracked.id));
  const comments2 = await db.select().from(K).where(eq(K.trackedAccountId, tracked.id));
  const newest = posts1.sort((a, b) => (BigInt(b.externalId) > BigInt(a.externalId) ? 1 : -1))[0]!;
  const kept = posts2.find((p) => p.id === newest.id);
  check('re-collect: no new post row (same newest post), first_seen kept', run2.final.status === 'success' && res2.newPosts === 0 && posts2.length === posts1.length
    && kept?.firstSeenAt.getTime() === newest.firstSeenAt.getTime(), JSON.stringify(res2));
  check('re-collect: no duplicate comments (unique per post + stable id)', posts2.every((p) => { const cs = comments2.filter((c) => c.trackedPostId === p.id); return new Set(cs.map((c) => c.externalId)).size === cs.length; })
    && comments2.length >= comments1.length, `${comments1.length} → ${comments2.length}`);
  r = await http('GET', `/api/tracked-accounts/${tracked.id}/feed`, U);
  check('tracked feed API shows them (posts + first comments + collect activity)', r.body.posts.total === posts2.length && r.body.posts.items[0].commentRows.length > 0 && r.body.activity.some((a: any) => a.type === 'collect'));

  // ---------------------------------------------------------------- 3. own account with 0 posts (1 screen)
  await http('PUT', '/api/risk/settings', admin, { feedPosts: 3, feedCommentsPerPost: 30 });
  since = new Date(Date.now() - 2000);
  r = await http('POST', `/api/social/accounts/${own.id}/collect`, U);
  const run3 = await waitTask('feed-collect', own.id, since);
  const res3 = run3.final.result as any;
  screens += res3?.screens ?? 0;
  console.log(`   run 3: ${JSON.stringify(res3)}`);
  const ownPosts = await db.select().from(schema.socialAccountPosts).where(eq(schema.socialAccountPosts.socialAccountId, own.id));
  check(`@${OWN_HANDLE} (0 posts): success, postsOnProfile 0, no rows, only the profile opened`, run3.final.status === 'success' && res3.postsOnProfile === 0 && res3.posts === 0 && ownPosts.length === 0 && res3.screens === 1, JSON.stringify(res3));

  // ---------------------------------------------------------------- 4. reply rehearsal on a natgeo comment (test mode, 1 screen)
  // Fixture: the natgeo post + one of its comments as if they were under the own account (the device flow only needs
  // the post link and the comment's author + text); a top one so no long scrolling is needed.
  const target = comments2.filter((c) => c.trackedPostId === newest.id).sort((a, b) => (a.position ?? 99) - (b.position ?? 99))[0]!;
  const [fixPost] = await db.insert(schema.socialAccountPosts).values({ socialAccountId: own.id, platform: 'instagram', externalId: newest.externalId, source: 'device', permalink: newest.url, caption: newest.title }).returning();
  const [fixComment] = await db.insert(schema.comments).values({
    userId: userIds[0]!, accountId: own.id, platform: 'instagram', source: 'device', externalId: target.externalId, externalPostId: newest.externalId, postUrl: newest.url,
    authorName: target.authorHandle, authorHandle: target.authorHandle, text: target.text,
  }).returning();
  const text = `测试回复 rehearsal 🙂 ${tag}`;
  since = new Date(Date.now() - 2000);
  r = await http('POST', `/api/comments/${fixComment!.id}/replies`, U, { text, submit: true });
  check('reply submitted → scheduled (no approval)', r.status === 201 && r.body.reply.status === 'scheduled', r.text);
  const rid = r.body.reply.id;
  const run4 = await waitTask('comment-reply', rid, since);
  const [rep] = await db.select().from(schema.commentTasks).where(eq(schema.commentTasks.id, rid));
  const l4 = await logsOf(run4.all.map((x) => x.id));
  screens += l4.filter((l) => l.message === 'reply: post opened').length;
  console.log(`   reply: ${rep?.status} ${rep?.errorCode ?? ''} ${JSON.stringify(rep?.evidence)}`);
  for (const l of l4) console.log(`     · ${l.level} ${l.message}`);
  check('reply → dry_run (test mode, method device, not sent)', rep?.status === 'dry_run' && rep.method === 'device' && rep.sentAt === null, `${rep?.status} ${rep?.errorCode} ${rep?.error}`);
  check('field read back = "@author " + the text (zh + emoji intact)', (rep?.evidence?.inputText ?? '').endsWith(text) && (rep?.evidence?.inputText ?? '').toLowerCase().startsWith(`@${target.authorHandle!.toLowerCase()}`), rep?.evidence?.inputText ?? '');
  check('logged: comments opened → replying to the comment → pasted + read back → field cleared', ['reply: comments opened', 'reply: replying to the comment', 'reply: text pasted and read back', 'reply: test mode, not sent; field cleared'].every((m) => l4.some((l) => l.message === m)));
  if (rep?.status !== 'dry_run') throw new Error('reply rehearsal failed: stopping before more screens');
  const ev = await http('GET', `/api/comment-replies/${rid}/evidence`, U);
  if (rep?.evidence?.key) evidenceKeys.push(rep.evidence.key);
  check('screenshot evidence stored (PNG)', ev.status === 200 && ev.type.startsWith('image/png') && ev.buf.subarray(1, 4).toString() === 'PNG', `${ev.status} ${ev.buf.length} bytes`);

  // ---------------------------------------------------------------- 5. direct comment rehearsal on the post (test mode, 1 screen)
  const text2 = `测试评论 rehearsal ✨ ${tag}`;
  since = new Date(Date.now() - 2000);
  r = await http('POST', `/api/social/accounts/${own.id}/posts/${fixPost!.id}/comments`, U, { text: text2 });
  const pid = r.body.reply?.id;
  check('post comment submitted → scheduled', r.status === 201 && r.body.reply.status === 'scheduled', r.text);
  const run5 = await waitTask('comment-reply', pid, since);
  const [rep5] = await db.select().from(schema.commentTasks).where(eq(schema.commentTasks.id, pid));
  const l5 = await logsOf(run5.all.map((x) => x.id));
  screens += l5.filter((l) => l.message === 'reply: post opened').length;
  if (rep5?.evidence?.key) evidenceKeys.push(rep5.evidence.key);
  console.log(`   post comment: ${rep5?.status} ${rep5?.errorCode ?? ''} input="${rep5?.evidence?.inputText ?? ''}"`);
  check('post comment → dry_run, field read back = the text exactly, cleared', rep5?.status === 'dry_run' && rep5.evidence?.inputText === text2 && l5.some((l) => l.message === 'reply: test mode, not sent; field cleared'), `${rep5?.status} ${rep5?.errorCode} ${rep5?.error}`);

  // ---------------------------------------------------------------- the phone afterwards, budget
  check(`Instagram screens opened by this run: ${screens} (≤ ${MAX_SCREENS})`, screens >= 1 && screens <= MAX_SCREENS);
  const after = await adb.shell(BIT_PORT, 'dumpsys activity activities | grep " ResumedActivity"; ls /data/local/tmp');
  check('phone back on the launcher, no dump file left', /Launcher/.test(after) && !/cp-ig-.*\.xml/.test(after), after.split('\n')[0]?.trim().slice(0, 140));
  const halts = (await http('GET', '/api/risk/devices', admin)).body.devices?.find((d: any) => d.id === phone!.id);
  check('phone not halted, visits counted on the 风控 page', !!halts && !halts.halted && halts.visitsLastHour >= screens, JSON.stringify(halts));
} catch (err) {
  check(`stopped: ${(err as Error).message}`, false);
} finally {
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
  if (mainLock) {
    clearInterval(mainLock.timer);
    if ((await mainLock.redis.get(mainLock.key)) === mainLock.token) await mainLock.redis.del(mainLock.key);
    mainLock.redis.disconnect();
  }
  const failed = results.filter(([, ok]) => !ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  await sqlClient.end();
  process.exit(failed ? 1 : 0);
}
