/**
 * 帖子与评论 (account feed) + 云手机发评论 without a phone (owner decision 2026-11-18): real API, DB, Redis and task
 * centre, no mocks. Device rows are placeholders (adb ports 5591–5593 that nothing listens on), so every device
 * operation meets an offline phone; the screens themselves are covered by feed-device-check.ts on bit-ins-02.
 * Posts / comments / stats / collection runs are seeded in the DB as the collector writes them.
 *
 * - feed API (social + tracked): exact numbers, newest-first paging of posts, first comments per post + total,
 *   comment paging, threads, activity (counter changes, new posts, collection runs, replies), RBAC (others 404);
 * - 立即采集: coded refusals (no device, in progress, device halted), the task on its own queue, offline result;
 *   the hourly schedule (key feed:<kind>:<id>:<slot>, idempotent, halted/stopped devices skipped, off = nothing);
 * - draft first, no test mode (owner decision 2026-11-18): every reply / post comment / tracked comment is created as a
 *   draft without a task (also with `submit: true` from an older page); 排程 (POST …/submit) queues it; a draft can be
 *   deleted; 回复记录 filters by status (draft / scheduled);
 * - replies without approval: 排程 → scheduled → (offline phone) awaiting_operator with the reason; a reply in
 *   the future keeps its time; a comment directly under a post (no parent comment) is scheduled the same way;
 * - 风控: device halted → the reply stays scheduled without a task (comment.device_halted), the feed says
 *   halted; 恢复 re-queues it; device rate rules (minimum gap, per day) defer to a new round (never dropped);
 *   settings validation + RBAC (no testMode in the rules; an older page's testMode is ignored); a legacy dry_run row
 *   does not block a real reply and no longer counts for the device pace;
 * - 评论追踪账号的帖子 (own account on a tracked post): account choice (own, same platform, on a phone; admins anyone's
 *   with the owner), RBAC (others' account / tracked account 404, no phone / wrong platform 400), comment + reply
 *   scheduled and handed over like the account's own posts (offline phone, unknown link, unknown author), one active
 *   reply per tracked comment (legacy dry_run doesn't block), minimum gap defers, 回复记录 on both sides (each filtered),
 *   tracked post deleted → the record stays; migration 0036 shape;
 * - evidence screenshot endpoint (owner 200 PNG, others 404); migration 0035 shape + db:migrate twice; audit;
 * - 人设禁用词: a post comment containing a word banned by the account's persona → 400 persona.banned_word.
 *
 *   E2E_API=http://127.0.0.1:<port> API_PORT=<port> npx tsx --env-file=../../.env scripts/feed-check.ts
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { and, eq, inArray, like, sql } from 'drizzle-orm';
import { db, schema, sqlClient } from '../src/db/index.js';
import { scheduleFeedCollects } from '../src/modules/feed/collect.js';
import { commentKey, permalinkOf } from '../src/modules/feed/ig-ui.js';
import { activeStorage } from '../src/modules/settings/storage.js';
import { haltDevice } from '../src/modules/tracked/collector.js';
import { withCaptcha } from './lib/login.js';

const API = process.env.E2E_API ?? `http://127.0.0.1:${process.env.API_PORT ?? 3000}`;
const results: [string, boolean][] = [];
const check = (name: string, ok: boolean, detail = '') => { results.push([name, ok]); console.log(`${ok ? '✓' : '✗'} ${name}${detail && !ok ? ` — ${detail}` : ''}`); };
async function http<T = any>(method: string, path: string, token: string | null, body?: unknown) {
  const res = await fetch(API + path, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const buf = Buffer.from(await res.arrayBuffer());
  const text = buf.toString('utf8');
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* 204 / binary */ }
  return { status: res.status, body: json as T, text, buf, type: res.headers.get('content-type') ?? '' };
}
async function login(username: string, password: string): Promise<string> {
  const r = await fetch(`${API}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(await withCaptcha(API, { username, password })) });
  return (await r.json()).token;
}
async function waitFor<T>(label: string, fn: () => Promise<T | null | false | undefined>, ms = 60_000): Promise<T> {
  const t0 = Date.now();
  for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() - t0 > ms) throw new Error(`timeout: ${label}`); await new Promise((r) => setTimeout(r, 300)); }
}
const R = schema.commentTasks;
const reply = async (id: string) => (await db.select().from(R).where(eq(R.id, id)))[0]!;
const taskOf = async (id: string | null) => (id ? (await db.select().from(schema.tasks).where(eq(schema.tasks.id, id)))[0] : undefined);
/**
 * Draft first: `created` is the response of a create call (reply / post comment / tracked comment). A created row must be
 * a draft without a task (counted in `notDrafts`); it is then scheduled (排程, POST …/submit, `at` = time or now) and the
 * create response is returned with the scheduled reply. Refused creates are returned as they are.
 */
let notDrafts = 0;
async function sch(created: Awaited<ReturnType<typeof http<any>>>, token: string, at: string | null = null): Promise<Awaited<ReturnType<typeof http<any>>>> {
  if (created.status !== 201) return created;
  const row = await reply(created.body.reply.id);
  if (row.status !== 'draft' || row.taskId) notDrafts++;
  const s = await http('POST', `/api/comment-replies/${row.id}/submit`, token, { scheduledAt: at });
  return { ...created, body: { reply: s.body?.reply ?? s.body, submitStatus: s.status }, text: s.text };
}

const T = await login(process.env.ADMIN_USERNAME!, process.env.ADMIN_PASSWORD!);
const tag = randomBytes(3).toString('hex');
const pw = randomBytes(12).toString('base64url');
const settingKeys = ['risk.device', 'social.limits', 'comments.rules', 'risk.halts', 'tracked.collectors'];
const savedSettings = await db.select().from(schema.settings).where(inArray(schema.settings.key, settingKeys));
const t0 = new Date((await sqlClient`select now() as now`)[0]!.now as Date);
const userIds: string[] = [];
const devIds: string[] = [];
const evidenceKeys: string[] = [];

try {
  // ---------------------------------------------------------------- settings (risk.device feed fields, comment rules)
  await db.delete(schema.settings).where(inArray(schema.settings.key, ['risk.device', 'comments.rules', 'risk.halts']));
  let r = await http('GET', '/api/risk/settings', T);
  check('风控 defaults: feed every 24 h, newest 3 posts, 30 comments per post', r.body.device.feedCollectHours === 24 && r.body.device.feedPosts === 3 && r.body.device.feedCommentsPerPost === 30, r.text);
  const bad = await Promise.all([{ feedPosts: 0 }, { feedPosts: 11 }, { feedCommentsPerPost: 101 }, { feedCollectHours: 0 }, { feedCommentsPerPost: 1.5 }].map((b) => http('PUT', '/api/risk/settings', T, b)));
  check('feed settings validation → 400', bad.every((x) => x.status === 400), bad.map((x) => x.status).join(','));
  r = await http('PUT', '/api/risk/settings', T, { feedCollectHours: null, feedCommentsPerPost: 20 });
  check('feed schedule off for the run, 20 comments per post stored', r.status === 200 && r.body.device.feedCollectHours === null && r.body.device.feedCommentsPerPost === 20 && r.body.device.feedPosts === 3, r.text);
  r = await http('GET', '/api/comments/settings', T);
  check('云手机发评论 defaults: 50/day, 60 s gap, no test mode any more', !('testMode' in r.body.rules) && r.body.rules.sendsPerDay === 50 && r.body.rules.minGapSec === 60, r.text);
  const badRules = await Promise.all([{ sendsPerDay: 0 }, { minGapSec: -1 }, { testMode: 'no' }].map((b) => http('PUT', '/api/comments/settings', T, b)));
  check('comment rule validation → 400', badRules.every((x) => x.status === 400), badRules.map((x) => x.status).join(','));

  for (const n of ['a', 'b']) {
    const u = await http('POST', '/api/users', T, { username: `fd${n}${tag}`, password: pw, role: 'user' });
    userIds.push(u.body.user?.id ?? u.body.id);
  }
  const [uA, uB] = userIds as [string, string];
  const A = await login(`fda${tag}`, pw);
  const B = await login(`fdb${tag}`, pw);
  r = await http('PUT', '/api/comments/settings', A, { testMode: false });
  check('user cannot change comment rules (403)', r.status === 403);

  const devs = await db.insert(schema.instances).values([1, 2, 3].map((n) => ({
    name: `feedchk-${tag}-${n}`, image: 'none', adbPort: 5590 + n, status: (n === 3 ? 'stopped' : 'running') as 'running' | 'stopped', adbState: n === 3 ? null : 'device',
    bootCompleted: n !== 3, spec: { width: 720, height: 1280, dpi: 320 },
  }))).returning();
  devIds.push(...devs.map((d) => d.id));
  const [d1, d2, d3] = devs as [typeof devs[0], typeof devs[0], typeof devs[0]];
  for (const [u, d] of [[uA, d1], [uB, d2], [uA, d3]] as const) await db.insert(schema.instanceGrants).values({ userId: u, instanceId: d.id }).onConflictDoNothing();
  const mk = async (owner: string, handle: string, instanceId: string | null, externalId?: string) => {
    const x = await http('POST', '/api/social/accounts', T, { platform: 'instagram', handle, ownerId: owner, instanceId, ...(externalId ? { externalId } : {}) });
    if (x.status !== 201) throw new Error(`account: ${x.text}`);
    return x.body.account as { id: string };
  };
  const accA = await mk(uA, `fd_a_${tag}`, d1.id, '1234567');
  const accB = await mk(uB, `fd_b_${tag}`, d2.id);
  const accN = await mk(uA, `fd_n_${tag}`, null);
  const accS = await mk(uA, `fd_s_${tag}`, d3.id);

  // ---------------------------------------------------------------- seed what a collection writes
  const base = 4032618345093327883n;
  const pks = Array.from({ length: 12 }, (_, i) => (base - BigInt(i) * 10_000_000_000n).toString());
  const now = Date.now();
  const posts = await db.insert(schema.socialAccountPosts).values(pks.map((pk, i) => ({
    socialAccountId: accA.id, platform: 'instagram', externalId: pk, source: 'device' as const, permalink: permalinkOf(pk), caption: `post ${i} ${tag}`,
    mediaType: i % 2 ? 'video' : 'photo', publishedAt: new Date(now - (i + 1) * 3600_000), likes: 100 + i, comments: i === 0 ? 15 : 0, approx: i === 1 ? ['likes'] : null,
  }))).returning();
  const p0 = posts.find((p) => p.externalId === pks[0])!;
  const comments = await db.insert(schema.comments).values(Array.from({ length: 15 }, (_, i) => ({
    userId: uA, accountId: accA.id, platform: 'instagram', source: 'device' as const, externalId: commentKey(pks[0]!, `fan${i}`, `nice ${i}`), externalPostId: pks[0]!,
    postUrl: permalinkOf(pks[0]!), authorName: `fan${i}`, authorHandle: `fan${i}`, text: `nice ${i}`, likeCount: i, publishedAt: new Date(now - i * 60_000),
  }))).returning();
  const c0 = comments.find((c) => c.authorHandle === 'fan0')!;
  await db.insert(schema.comments).values({ userId: uA, accountId: accA.id, platform: 'instagram', source: 'manual', externalId: `manual:${tag}`, parentExternalId: c0.externalId,
    externalPostId: pks[0]!, authorName: 'replier', text: 'thread child', publishedAt: new Date(now) });
  const day = (d: number) => new Date(now - d * 86_400_000).toISOString().slice(0, 10);
  await db.insert(schema.socialAccountStats).values([
    { socialAccountId: accA.id, day: day(2), source: 'device', followers: 100, following: 10, posts: 10, capturedAt: new Date(now - 2 * 86_400_000) },
    { socialAccountId: accA.id, day: day(1), source: 'device', followers: 110, following: 10, posts: 11, capturedAt: new Date(now - 86_400_000) },
    { socialAccountId: accA.id, day: day(0), source: 'device', followers: 107, following: 12, posts: 12, capturedAt: new Date(now - 60_000) },
  ]);
  const [run1] = await db.insert(schema.tasks).values({
    type: 'feed-collect', status: 'success', refType: 'social_account', refId: accA.id, createdBy: uA, finishedAt: new Date(now - 30_000), payload: { kind: 'social', accountId: accA.id },
    result: { outcome: 'collected', posts: 3, newPosts: 2, comments: 15, newComments: 15 },
  }).returning();
  const [tacc] = await db.insert(schema.trackedAccounts).values({ userId: uA, platform: 'instagram', handle: `fd_t_${tag}`, profileUrl: `https://www.instagram.com/fd_t_${tag}/` }).returning();
  const tposts = await db.insert(schema.trackedPosts).values([0, 1].map((i) => ({ trackedAccountId: tacc!.id, externalId: pks[i]!, source: 'device' as const, url: permalinkOf(pks[i]!), title: `t${i}`, publishedAt: new Date(now - i * 3600_000), likes: 5, comments: 3 })))
    .returning();
  await db.insert(schema.trackedPostComments).values([0, 1, 2, 3, 4].map((i) => ({ trackedPostId: tposts[0]!.id, trackedAccountId: tacc!.id, externalId: commentKey(pks[0]!, `t${i}`, `x${i}`), authorHandle: `t${i}`, text: `x${i}`, position: 4 - i })));
  await db.insert(schema.trackedAccountSnapshots).values([
    { trackedAccountId: tacc!.id, source: 'device', followers: 1000, capturedAt: new Date(now - 86_400_000) },
    { trackedAccountId: tacc!.id, source: 'device', followers: 1500, capturedAt: new Date(now - 1000) },
  ]);

  // ---------------------------------------------------------------- feed API: numbers, paging, RBAC
  r = await http('GET', `/api/social/accounts/${accA.id}/feed`, A);
  const f = r.body;
  check('social feed: 12 posts total, first page 10, newest first', r.status === 200 && f.posts.total === 12 && f.posts.items.length === 10 && f.posts.items[0].externalId === pks[0] && f.posts.items[9].externalId === pks[9], r.text.slice(0, 300));
  const fp0 = f.posts.items[0];
  check('post: permalink, counts, approx, 10 of 15 comments, newest first, thread child under its parent',
    fp0.permalink === permalinkOf(pks[0]!) && fp0.likes === 100 && fp0.comments === 15 && f.posts.items[1].approx.join() === 'likes' && fp0.commentRows.length === 10 && fp0.commentsTotal === 15
    && fp0.commentRows[0].authorHandle === 'fan0' && fp0.commentRows[0].children.length === 1 && fp0.commentRows[0].children[0].text === 'thread child', JSON.stringify(fp0).slice(0, 400));
  const stats = f.activity.filter((a: any) => a.type === 'stats');
  check('activity: 3 counter readings with exact changes (+10 / −3 followers, +2 following)', stats.length === 3 && stats[0].followers === 107 && stats[0].delta.followers === -3 && stats[0].delta.following === 2
    && stats[1].delta.followers === 10 && stats[2].delta.followers === null, JSON.stringify(stats));
  check('activity: new posts + the collection run (2 new posts, 15 new comments)', f.activity.filter((a: any) => a.type === 'post').length === 12
    && f.activity.some((a: any) => a.type === 'collect' && a.newPosts === 2 && a.newComments === 15), JSON.stringify(f.activity.filter((a: any) => a.type === 'collect')));
  check('collect state: last run, device not halted, settings, test mode on', f.collect.last?.taskId === run1!.id && f.collect.halted === false && f.collect.settings.posts === 3 && f.collect.settings.commentsPerPost === 20 && !('testMode' in f.send) && f.send.deviceCapable === true && f.collect.unsupported === null);
  r = await http('GET', `/api/social/accounts/${accA.id}/feed?offset=10&limit=10&comments=0`, A);
  check('page 2: 2 posts, no comment rows but the total', r.body.posts.items.length === 2 && r.body.posts.items[0].externalId === pks[10] && r.body.posts.items.every((p: any) => p.commentRows.length === 0), r.text.slice(0, 200));
  r = await http('GET', `/api/social/accounts/${accA.id}/posts/${p0.id}/comments?limit=5&offset=10`, A);
  check('comment paging: 5 of 15 at offset 10 (fan10…fan14)', r.body.total === 15 && r.body.items.length === 5 && r.body.items[0].authorHandle === 'fan10', r.text.slice(0, 200));
  const denied = await Promise.all([
    http('GET', `/api/social/accounts/${accA.id}/feed`, B), http('GET', `/api/social/accounts/${accA.id}/posts/${p0.id}/comments`, B),
    http('POST', `/api/social/accounts/${accA.id}/collect`, B), http('POST', `/api/social/accounts/${accA.id}/posts/${p0.id}/comments`, B, { text: 'x' }),
    http('GET', `/api/tracked-accounts/${tacc!.id}/feed`, B), http('GET', `/api/tracked-accounts/${tacc!.id}/posts/${tposts[0]!.id}/comments`, B),
  ]);
  check('RBAC: another user gets 404 on every feed endpoint', denied.every((x) => x.status === 404), denied.map((x) => x.status).join(','));
  r = await http('GET', `/api/social/accounts/${accA.id}/posts/${posts[0]!.id}/comments`, A);
  const other = await http('GET', `/api/social/accounts/${accB.id}/posts/${p0.id}/comments`, B);
  check('a post of another account → 404 feed.post_not_found', other.status === 404 && other.body.code === 'feed.post_not_found', other.text);
  r = await http('GET', `/api/social/accounts/${accA.id}/feed`, T);
  check('admin sees the feed', r.status === 200 && r.body.posts.total === 12);
  r = await http('GET', `/api/tracked-accounts/${tacc!.id}/feed`, A);
  check('tracked feed: 2 posts, comments in the app order (position), +500 followers, send block (Instagram: own accounts can comment, no test mode)',
    r.status === 200 && r.body.posts.total === 2 && r.body.posts.items[0].commentRows.map((c: any) => c.authorHandle).join() === 't4,t3,t2,t1,t0' && r.body.posts.items[0].commentsTotal === 5
    && r.body.activity.find((a: any) => a.type === 'stats').delta.followers === 500 && r.body.send?.deviceCapable === true && !('testMode' in r.body.send), r.text.slice(0, 300));
  r = await http('GET', `/api/tracked-accounts/${tacc!.id}/posts/${tposts[0]!.id}/comments?limit=2&offset=1`, A);
  check('tracked comment paging', r.body.total === 5 && r.body.items.map((c: any) => c.authorHandle).join() === 't3,t2', r.text);

  // ---------------------------------------------------------------- 立即采集
  r = await http('POST', `/api/social/accounts/${accN.id}/collect`, A);
  check('collect: account without a phone → 400 feed.no_device', r.status === 400 && r.body.code === 'feed.no_device', r.text);
  r = await http('POST', `/api/tracked-accounts/${tacc!.id}/collect`, A);
  check('tracked collect without a collector phone → 400 tracked.collector_unset', r.status === 400 && r.body.code === 'tracked.collector_unset', r.text);
  r = await http('POST', `/api/social/accounts/${accB.id}/collect`, B);
  const ct = r.body.task?.id;
  const r2 = await http('POST', `/api/social/accounts/${accB.id}/collect`, B);
  check('collect: 202 + task, a second request while queued → 409 feed.in_progress', r.status === 202 && !!ct && r2.status === 409 && r2.body.code === 'feed.in_progress', `${r.text} ${r2.text}`);
  const ctask = await waitFor('collect task done', async () => { const t = await taskOf(ct); return t && ['success', 'failed'].includes(t.status) ? t : null; });
  check('collect on an offline phone: task feed-collect fails feed.offline, nothing written', ctask.type === 'feed-collect' && ctask.status === 'failed' && ctask.errorCode === 'feed.offline'
    && (await db.select().from(schema.socialAccountPosts).where(eq(schema.socialAccountPosts.socialAccountId, accB.id))).length === 0, `${ctask.status} ${ctask.errorCode}`);

  // ---------------------------------------------------------------- replies without approval (offline phone → operator)
  r = await http('POST', `/api/comments/${c0.id}/replies`, A, { text: `Thanks ${tag}`, submit: true });
  const draft1 = r.body.reply;
  check('draft first: a reply (even with submit: true) is a draft, no task', r.status === 201 && draft1.status === 'draft' && !draft1.taskId
    && !(await db.select().from(schema.tasks).where(and(eq(schema.tasks.refType, 'comment_reply'), eq(schema.tasks.refId, draft1.id)))).length, r.text.slice(0, 200));
  r = await http('GET', `/api/comment-replies?accountId=${accA.id}&status=draft`, A);
  check('回复记录 status filter: the draft is listed under draft', r.status === 200 && r.body.items.some((x: any) => x.id === draft1.id) && r.body.items.every((x: any) => x.status === 'draft'), r.text.slice(0, 200));
  r = await http('POST', `/api/comment-replies/${draft1.id}/submit`, A, { scheduledAt: null });
  const rep1 = r.body.reply;
  check('排程 now → scheduled at once with a send task (no approval)', r.status === 200 && rep1.status === 'scheduled' && !!rep1.taskId, r.text.slice(0, 200));
  r = await http('GET', `/api/comment-replies?accountId=${accA.id}&status=scheduled,sending`, A);
  check('…listed under scheduled, no longer under draft', r.body.items.some((x: any) => x.id === rep1.id) || (await reply(rep1.id)).status !== 'scheduled', r.text.slice(0, 200));
  const done1 = await waitFor('reply handed over', async () => { const x = await reply(rep1.id); return x.status === 'awaiting_operator' ? x : null; });
  const l1 = await db.select().from(schema.commentLogs).where(and(eq(schema.commentLogs.commentTaskId, rep1.id), eq(schema.commentLogs.action, 'handed_over')));
  check('phone offline → handed to an operator (method manual, reason comment.device_offline)', done1.method === 'manual' && l1[0]?.code === 'comment.device_offline', JSON.stringify(l1[0]));
  const later = new Date(Date.now() + 3600_000);
  r = await sch(await http('POST', `/api/comments/${comments[1]!.id}/replies`, A, { text: `Later ${tag}` }), A, later.toISOString());
  const rep2 = r.body.reply;
  const t2 = await taskOf(rep2.taskId);
  check('reply at a chosen time: scheduled, task runAt = that time', rep2.status === 'scheduled' && t2?.status === 'scheduled' && t2.runAt?.getTime() === later.getTime(), JSON.stringify(t2?.runAt));
  await http('POST', `/api/comment-replies/${rep2.id}/cancel`, A);

  // direct comment under a post
  r = await http('POST', `/api/social/accounts/${accA.id}/posts/${p0.id}/comments`, A, { text: '   ' });
  check('post comment: empty text → 400', r.status === 400 && r.body.code === 'comment.text_empty', r.text);
  {
    // 人设禁用词: a comment under a post on an account whose persona bans a word is refused, nothing stored
    const pid = (await http('POST', '/api/personas', A, { scope: 'mine', name: `fd persona ${tag}`, style: { bannedWords: ['私信'] } })).body.persona?.id;
    await http('PUT', `/api/social/accounts/${accA.id}`, A, { personaId: pid });
    const before = (await db.select().from(schema.commentTasks).where(eq(schema.commentTasks.accountId, accA.id))).length;
    r = await http('POST', `/api/social/accounts/${accA.id}/posts/${p0.id}/comments`, A, { text: '详情请私信' });
    const after = (await db.select().from(schema.commentTasks).where(eq(schema.commentTasks.accountId, accA.id))).length;
    check('post comment with a word banned by the account\'s persona → 400 persona.banned_word (words), nothing stored',
      r.status === 400 && r.body.code === 'persona.banned_word' && r.body.params?.words === '私信' && before === after, `${r.status} ${r.text.slice(0, 200)}`);
    await http('DELETE', `/api/personas/${pid}`, A);
  }
  r = await http('POST', `/api/social/accounts/${accA.id}/posts/${posts[2]!.id}/comments`, A, { text: `Post note ${tag}`, scheduledAt: new Date().toISOString() });
  const pcDraft = await reply(r.body.reply?.id);
  check('comment directly under a post: 201 draft, no task (also with a time from an older page)', r.status === 201 && r.body.reply.status === 'draft' && pcDraft.taskId === null && pcDraft.status === 'draft', r.text);
  {
    const del = await http('POST', `/api/social/accounts/${accA.id}/posts/${posts[3]!.id}/comments`, A, { text: `Drop me ${tag}` });
    const dOther = await http('DELETE', `/api/comment-replies/${del.body.reply.id}`, B);
    const dOwn = await http('DELETE', `/api/comment-replies/${del.body.reply.id}`, A);
    const dl = await db.select().from(schema.commentLogs).where(and(eq(schema.commentLogs.accountId, accA.id), eq(schema.commentLogs.action, 'draft_deleted')));
    check('删除 a post-comment draft: another user 404, owner 204, row gone, logged on the account', dOther.status === 404 && dOwn.status === 204
      && !(await db.select().from(R).where(eq(R.id, del.body.reply.id))).length && dl.some((l) => (l.data as any)?.replyId === del.body.reply.id), `${dOther.status} ${dOwn.status}`);
  }
  r = await sch(r, A);
  const pc = r.body.reply;
  const pcRow = await reply(pc.id);
  check('…排程: scheduled now, no comment id, post linked', r.status === 201 && pc.status === 'scheduled' && pcRow.commentId === null && pcRow.postId === posts[2]!.id, r.text);
  await waitFor('post comment handed over', async () => (await reply(pc.id)).status === 'awaiting_operator');
  r = await http('GET', `/api/comment-replies?accountId=${accA.id}`, A);
  const pci = r.body.items.find((x: any) => x.id === pc.id);
  check('回复记录 lists it with the post (caption, permalink), comment null', pci?.post?.caption === `post 2 ${tag}` && pci.comment === null && pci.post.permalink === permalinkOf(pks[2]!), JSON.stringify(pci).slice(0, 300));
  r = await http('GET', `/api/social/accounts/${accA.id}/feed`, A);
  check('feed shows the post comment under its post', r.body.posts.items.find((p: any) => p.id === posts[2]!.id)?.postComments?.[0]?.id === pc.id);

  // ---------------------------------------------------------------- 评论追踪账号的帖子 with an own account
  const tp0 = tposts[0]!;
  const tcs = await db.select().from(schema.trackedPostComments).where(eq(schema.trackedPostComments.trackedPostId, tp0.id));
  const tc = (h: string) => tcs.find((c) => c.authorHandle === h)!;
  r = await http('GET', `/api/tracked-accounts/${tacc!.id}/reply-accounts`, A);
  const ra = (r.body.items ?? []) as any[];
  check('reply accounts (user): own Instagram accounts on a phone only (no phone / other user excluded), own=true, device shown',
    r.status === 200 && ra.map((x) => x.id).sort().join() === [accA.id, accS.id].sort().join() && ra.every((x) => x.own === true && x.instance?.name?.startsWith(`feedchk-${tag}`)), r.text.slice(0, 300));
  r = await http('GET', `/api/tracked-accounts/${tacc!.id}/reply-accounts`, T);
  const rb = (r.body.items ?? []) as any[];
  const rbB = rb.find((x) => x.id === accB.id);
  check('reply accounts (admin): any user\'s, with the owner name (own=false)', !!rbB && rbB.ownerName === `fdb${tag}` && rbB.own === false && !rb.some((x) => x.id === accN.id), JSON.stringify(rbB));
  r = await http('GET', `/api/tracked-accounts/${tacc!.id}/reply-accounts`, B);
  check('reply accounts of another user\'s tracked account → 404', r.status === 404 && r.body.code === 'tracked.not_found', r.text);
  const tpath = `/api/tracked-accounts/${tacc!.id}/posts/${tp0.id}/comments`;
  const refusals = await Promise.all([
    http('POST', tpath, A, { accountId: accB.id, text: 'x' }),
    http('POST', tpath, A, { accountId: accN.id, text: 'x' }),
    http('POST', tpath, B, { accountId: accB.id, text: 'x' }),
    http('POST', `${tpath}/${tc('t0').id}/replies`, B, { accountId: accB.id, text: 'x' }),
    http('POST', `/api/tracked-accounts/${tacc!.id}/posts/${tposts[1]!.id}/comments/${tc('t0').id}/replies`, A, { accountId: accA.id, text: 'x' }),
    http('POST', tpath, A, { accountId: accA.id, text: '   ' }),
  ]);
  check('refusals: another user\'s account 404 social.not_found, account without a phone 400 comment.account_no_device, another user\'s tracked account 404 (comment + reply), comment of another post 404, empty text 400',
    refusals[0]!.status === 404 && refusals[0]!.body.code === 'social.not_found' && refusals[1]!.status === 400 && refusals[1]!.body.code === 'comment.account_no_device'
    && refusals[2]!.status === 404 && refusals[2]!.body.code === 'tracked.not_found' && refusals[3]!.status === 404 && refusals[4]!.status === 404 && refusals[4]!.body.code === 'comment.not_found'
    && refusals[5]!.status === 400 && refusals[5]!.body.code === 'comment.text_empty', refusals.map((x) => `${x.status}:${x.body?.code}`).join(','));
  // a tracked YouTube account (seeded; the platform is disabled by default): an Instagram account doesn't fit
  const [ytAcc] = await db.insert(schema.trackedAccounts).values({ userId: uA, platform: 'youtube', handle: `@fdyt${tag}`, profileUrl: `https://www.youtube.com/@fdyt${tag}` }).returning();
  const [ytPost] = await db.insert(schema.trackedPosts).values({ trackedAccountId: ytAcc!.id, externalId: `yt${tag}`, source: 'api', url: `https://www.youtube.com/watch?v=yt${tag}`, title: 'yt' }).returning();
  r = await http('POST', `/api/tracked-accounts/${ytAcc!.id}/posts/${ytPost!.id}/comments`, A, { accountId: accA.id, text: 'x' });
  const ytList = await http('GET', `/api/tracked-accounts/${ytAcc!.id}/reply-accounts`, A);
  check('wrong platform: 400 comment.account_platform_mismatch; no account offered for a YouTube tracked account', r.status === 400 && r.body.code === 'comment.account_platform_mismatch' && ytList.body.items?.length === 0, `${r.text} ${ytList.text}`);

  r = await http('POST', tpath, A, { accountId: accA.id, text: `Tracked note ${tag}` });
  check('comment on a tracked post: a draft first (no task)', r.status === 201 && r.body.reply.status === 'draft' && (await reply(r.body.reply.id)).taskId === null, r.text);
  r = await sch(r, A);
  const tq = r.body.reply;
  const tqRow = tq ? await reply(tq.id) : null;
  check('comment on a tracked post: 201, scheduled at once, tracked post linked (no own post / comment), owner = the account\'s owner',
    r.status === 201 && tq.status === 'scheduled' && tqRow?.trackedPostId === tp0.id && tqRow.trackedCommentId === null && tqRow.postId === null && tqRow.commentId === null && tqRow.userId === uA && tqRow.accountId === accA.id, r.text);
  const tqDone = await waitFor('tracked comment handed over', async () => { const x = await reply(tq.id); return x.status === 'awaiting_operator' ? x : null; });
  const tql = await db.select().from(schema.commentLogs).where(and(eq(schema.commentLogs.commentTaskId, tq.id), eq(schema.commentLogs.action, 'handed_over')));
  check('…phone offline → operator (comment.device_offline): the device path was planned (link from the media pk)', tqDone.method === 'manual' && tql[0]?.code === 'comment.device_offline', JSON.stringify(tql[0]));
  r = await sch(await http('POST', `${tpath}/${tc('t0').id}/replies`, A, { accountId: accA.id, text: `Tracked reply ${tag}` }), A);
  const tr = r.body.reply;
  const trRow = tr ? await reply(tr.id) : null;
  const again = await http('POST', `${tpath}/${tc('t0').id}/replies`, A, { accountId: accS.id, text: `Second ${tag}` });
  check('reply to a tracked comment: 201 scheduled (tracked post + comment linked); a second reply (other own account) → 409 comment.already_replied',
    r.status === 201 && tr.status === 'scheduled' && trRow?.trackedCommentId === tc('t0').id && trRow.trackedPostId === tp0.id && again.status === 409 && again.body.code === 'comment.already_replied', `${r.text} ${again.text}`);
  await waitFor('tracked reply handed over', async () => (await reply(tr.id)).status === 'awaiting_operator');
  const trl = await db.select().from(schema.commentLogs).where(and(eq(schema.commentLogs.commentTaskId, tr.id), eq(schema.commentLogs.action, 'handed_over')));
  check('…reply planned for the phone (author + key known) → offline → operator', trl[0]?.code === 'comment.device_offline', JSON.stringify(trl[0]));
  // unknown link / unknown author → operator with the reason
  const [noLink] = await db.insert(schema.trackedPosts).values({ trackedAccountId: tacc!.id, externalId: `nolink${tag}`, source: 'manual', url: null, title: 'old manual row' }).returning();
  const [noAuthor] = await db.insert(schema.trackedPostComments).values({ trackedPostId: tp0.id, trackedAccountId: tacc!.id, externalId: `noauthor${tag}`, authorHandle: null, text: 'who', position: 9 }).returning();
  const nl = await sch(await http('POST', `/api/tracked-accounts/${tacc!.id}/posts/${noLink!.id}/comments`, A, { accountId: accA.id, text: `No link ${tag}` }), A);
  const na = await sch(await http('POST', `${tpath}/${noAuthor!.id}/replies`, A, { accountId: accA.id, text: `No author ${tag}` }), A);
  await waitFor('no-link / no-author handed over', async () => (await reply(nl.body.reply.id)).status === 'awaiting_operator' && (await reply(na.body.reply.id)).status === 'awaiting_operator');
  const reasons = await db.select({ id: schema.commentLogs.commentTaskId, code: schema.commentLogs.code }).from(schema.commentLogs)
    .where(and(inArray(schema.commentLogs.commentTaskId, [nl.body.reply.id, na.body.reply.id]), eq(schema.commentLogs.action, 'handed_over')));
  check('post link unknown → operator (comment.device_no_post_link); comment author unknown → operator (comment.device_no_author)',
    reasons.find((x) => x.id === nl.body.reply.id)?.code === 'comment.device_no_post_link' && reasons.find((x) => x.id === na.body.reply.id)?.code === 'comment.device_no_author', JSON.stringify(reasons));
  // a legacy dry_run (old colour's test mode) doesn't block a real reply and no longer counts for the pace; a device send
  // under the post 10 s ago does: the minimum gap applies to tracked targets too
  await db.insert(R).values({ userId: uA, accountId: accA.id, trackedPostId: tp0.id, trackedCommentId: tc('t1').id, platform: 'instagram', text: 'dry', textHash: 'td', status: 'dry_run', method: 'device', handedAt: new Date(Date.now() - 2_000), submittedAt: new Date() });
  await db.insert(R).values({ userId: uA, accountId: accA.id, trackedPostId: tp0.id, platform: 'instagram', text: 'sent under the post', textHash: 'ts', status: 'sent', method: 'device', sentAt: new Date(Date.now() - 10_000), submittedAt: new Date() });
  await http('PUT', '/api/comments/settings', T, { minGapSec: 120 });
  r = await sch(await http('POST', `${tpath}/${tc('t1').id}/replies`, A, { accountId: accA.id, text: `After dry tracked ${tag}` }), A);
  const tg = r.body.reply;
  const tgDef = tg ? await waitFor('tracked reply deferred by gap', async () => { const x = await reply(tg.id); return x.round === 2 ? x : null; }) : null;
  const tgt = await taskOf(tgDef?.taskId ?? null);
  check('a legacy dry_run on a tracked comment does not block a real reply; minimum gap (120 s from the device send, not the dry run) defers it to a new round',
    r.status === 201 && tgDef?.status === 'scheduled' && !!tgt && Math.abs(tgt.runAt!.getTime() - (Date.now() - 10_000 + 121_000)) < 15_000
    && (await db.select().from(schema.commentLogs).where(and(eq(schema.commentLogs.commentTaskId, tg.id), eq(schema.commentLogs.code, 'comment.min_gap')))).length === 1, `${r.text} ${JSON.stringify(tgt?.runAt)}`);
  await http('POST', `/api/comment-replies/${tg.id}/cancel`, A);
  await http('PUT', '/api/comments/settings', T, { minGapSec: 60 });
  // admin comments with user B's account on A's tracked post: A never sees B's account there
  r = await http('POST', tpath, T, { accountId: accB.id, text: `Admin via B ${tag}` });
  const ab = r.body.reply;
  check('admin may use any user\'s account (201; the row belongs to that account\'s owner)', r.status === 201 && (await reply(ab.id)).userId === uB, r.text);
  // 回复记录 on both sides
  r = await http('GET', `/api/comment-replies?accountId=${accA.id}&limit=100`, A);
  const ownRows = (r.body.items ?? []) as any[];
  const oq = ownRows.find((x) => x.id === tq.id);
  const orr = ownRows.find((x) => x.id === tr.id);
  check('社交号 回复记录: tracked comment + reply listed with the tracked post (handle, caption, link) and the tracked comment',
    oq?.trackedPost?.handle === `fd_t_${tag}` && oq.trackedPost.caption === 't0' && oq.trackedPost.permalink === permalinkOf(pks[0]!) && oq.trackedComment === null && oq.comment === null && oq.post === null
    && orr?.trackedComment?.authorHandle === 't0' && orr.trackedComment.text === 'x0', JSON.stringify({ oq, orr }).slice(0, 500));
  r = await http('GET', `/api/comment-replies?trackedAccountId=${tacc!.id}&limit=100`, A);
  const tRows = (r.body.items ?? []) as any[];
  check('追踪账号 回复记录 (A): only replies on this tracked account\'s posts, only A\'s accounts (not the admin\'s one via B)',
    r.status === 200 && tRows.length === r.body.total && tRows.every((x) => x.accountId === accA.id && x.trackedPost?.trackedAccountId === tacc!.id) && tRows.some((x) => x.id === tq.id) && tRows.some((x) => x.id === tr.id)
    && !tRows.some((x) => x.id === ab.id) && !tRows.some((x) => x.id === pc.id), JSON.stringify(tRows.map((x) => x.id)));
  const tAdmin = await http('GET', `/api/comment-replies?trackedAccountId=${tacc!.id}&limit=100`, T);
  const tB = await http('GET', `/api/comment-replies?trackedAccountId=${tacc!.id}`, B);
  check('…admin sees all of them (incl. via B); another user filtering by the tracked account → 404', tAdmin.body.items?.some((x: any) => x.id === ab.id) && tAdmin.body.total === r.body.total + 1 && tB.status === 404, `${tAdmin.body.total} ${r.body.total} ${tB.status}`);
  r = await http('GET', `/api/tracked-accounts/${tacc!.id}/feed`, A);
  const tf0 = r.body.posts?.items?.find((p: any) => p.id === tp0.id);
  check('tracked feed: the post shows A\'s comment (not the admin\'s via B), comment t0 shows its reply',
    tf0?.postComments?.some((x: any) => x.id === tq.id) && !tf0.postComments.some((x: any) => x.id === ab.id) && tf0.commentRows.find((c: any) => c.authorHandle === 't0')?.reply?.id === tr.id, JSON.stringify(tf0?.postComments));
  r = await http('GET', `/api/tracked-accounts/${tacc!.id}/feed`, T);
  check('…admin\'s tracked feed shows the one via B too', r.body.posts.items.find((p: any) => p.id === tp0.id)?.postComments?.some((x: any) => x.id === ab.id));
  r = await http('GET', `/api/tracked-accounts/${tacc!.id}/posts/${tp0.id}/comments?limit=10`, A);
  check('tracked comment paging carries the reply state', r.body.items.find((c: any) => c.authorHandle === 't0')?.reply?.id === tr.id);
  // the tracked post is deleted while a reply waits (parked on a halted phone): the record stays (tracked post null),
  // the reply keeps its comment id and fails comment.comment_gone when it runs (never turned into a post comment)
  const [tp1] = [tposts[1]!];
  const [tc1] = await db.insert(schema.trackedPostComments).values({ trackedPostId: tp1.id, trackedAccountId: tacc!.id, externalId: commentKey(pks[1]!, 'z', 'zz'), authorHandle: 'z', text: 'zz', position: 0 }).returning();
  await haltDevice(d1, { code: 'comment.device_challenge', source: 'reply', platform: 'instagram', socialAccountId: accA.id });
  const del1 = await sch(await http('POST', `/api/tracked-accounts/${tacc!.id}/posts/${tp1.id}/comments/${tc1!.id}/replies`, A, { accountId: accA.id, text: `Gone ${tag}` }), A);
  const parkedT = await waitFor('tracked reply parked on the halted phone', async () => { const x = await reply(del1.body.reply.id); return x.status === 'scheduled' && x.taskId === null && x.errorCode === 'comment.device_halted' ? x : null; });
  check('halted phone: a tracked reply is parked like any other (scheduled, no task, comment.device_halted)', !!parkedT);
  r = await http('DELETE', `/api/tracked-accounts/${tacc!.id}/posts/${tp1.id}`, A);
  const gone = await reply(del1.body.reply.id);
  check('tracked post deleted: the reply row stays (tracked post null, comment id kept)', [200, 204].includes(r.status) && gone.trackedPostId === null && gone.trackedCommentId === tc1!.id, `${r.status} ${JSON.stringify(gone)}`);
  await http('POST', `/api/risk/devices/${d1.id}/resume`, T);
  const goneDone = await waitFor('gone reply ran', async () => { const x = await reply(gone.id); return ['failed', 'awaiting_operator', 'sent', 'dry_run'].includes(x.status) ? x : null; });
  check('…恢复 → it runs and fails comment.comment_gone (no post comment, no hand-over)', goneDone.status === 'failed' && goneDone.errorCode === 'comment.comment_gone', JSON.stringify(goneDone));
  r = await http('GET', `/api/comment-replies?accountId=${accA.id}&limit=100`, A);
  const gi = r.body.items.find((x: any) => x.id === gone.id);
  check('…回复记录 still lists it (tracked post + comment null = gone)', !!gi && gi.trackedComment === null && gi.trackedPost === null && gi.trackedCommentId === tc1!.id, JSON.stringify(gi).slice(0, 300));
  const [idx36] = await sqlClient`select indexdef from pg_indexes where indexname = 'comment_tasks_tracked_one_active_idx'`;
  const [fk36] = await sqlClient`select confdeltype from pg_constraint where conname = 'comment_tasks_tracked_post_id_tracked_posts_id_fk'`;
  check('migration 0036: one active reply per tracked comment (dry_run ignored), tracked post FK on delete set null', /dry_run/.test(String(idx36?.indexdef)) && fk36?.confdeltype === 'n', `${idx36?.indexdef} ${fk36?.confdeltype}`);

  // ---------------------------------------------------------------- 风控: halted phone parks replies, 恢复 re-queues
  await haltDevice(d1, { code: 'comment.device_challenge', source: 'reply', platform: 'instagram', socialAccountId: accA.id });
  r = await http('GET', `/api/social/accounts/${accA.id}/feed?limit=1`, A);
  check('feed says the phone is halted (UI: 风控暂停中，恢复后发出)', r.body.collect.halted === true);
  r = await http('POST', `/api/social/accounts/${accA.id}/collect`, A);
  check('collect on a halted phone → 409 feed.device_halted', r.status === 409 && r.body.code === 'feed.device_halted', r.text);
  r = await sch(await http('POST', `/api/comments/${comments[2]!.id}/replies`, A, { text: `Halted ${tag}` }), A);
  const rep3 = r.body.reply;
  const parked = await waitFor('parked', async () => { const x = await reply(rep3.id); return x.status === 'scheduled' && x.taskId === null && x.errorCode === 'comment.device_halted' ? x : null; });
  check('halted phone: reply stays scheduled, no task, code comment.device_halted (not sent, not dropped)', parked.round === 1);
  r = await http('POST', `/api/risk/devices/${d1.id}/resume`, T);
  const resumed = await waitFor('re-queued after resume', async () => { const x = await reply(rep3.id); return x.taskId && x.round === 2 ? x : null; });
  check('恢复 → the parked reply gets a new round + task at once', r.status === 200 && r.body.resumed === true && !!resumed.taskId && resumed.errorCode === null, JSON.stringify(resumed));
  await waitFor('resumed reply ran', async () => (await reply(rep3.id)).status === 'awaiting_operator');
  check('…and then runs (offline phone → operator)', (await reply(rep3.id)).status === 'awaiting_operator');

  // ---------------------------------------------------------------- device rate rules: minimum gap, per day (deferred, never dropped)
  // A device send of this account 10 s ago (as the phone writes it): the next device send must wait minGapSec.
  await db.insert(R).values({ userId: uA, accountId: accA.id, commentId: comments[3]!.id, platform: 'instagram', text: 'earlier', textHash: 'x', status: 'sent', method: 'device', sentAt: new Date(Date.now() - 10_000), submittedAt: new Date() });
  await http('PUT', '/api/comments/settings', T, { minGapSec: 120 });
  r = await sch(await http('POST', `/api/comments/${comments[4]!.id}/replies`, A, { text: `Gap ${tag}` }), A);
  const rep4 = r.body.reply;
  const def4 = await waitFor('deferred by gap', async () => { const x = await reply(rep4.id); return x.round === 2 ? x : null; });
  const lg = await db.select().from(schema.commentLogs).where(and(eq(schema.commentLogs.commentTaskId, rep4.id), eq(schema.commentLogs.code, 'comment.min_gap')));
  const t4 = await taskOf(def4.taskId);
  check('minimum gap (120 s): deferred to a new round ≈ last send + 120 s, still scheduled', def4.status === 'scheduled' && lg.length === 1 && !!t4 && Math.abs(t4.runAt!.getTime() - (Date.now() - 10_000 + 121_000)) < 15_000, JSON.stringify({ runAt: t4?.runAt, st: def4.status }));
  await http('POST', `/api/comment-replies/${rep4.id}/cancel`, A);
  await http('PUT', '/api/comments/settings', T, { minGapSec: 0, sendsPerDay: 2 });
  const [dayRow] = await db.insert(R).values({ userId: uA, accountId: accA.id, commentId: comments[5]!.id, platform: 'instagram', text: 'earlier2', textHash: 'y', status: 'sent', method: 'device', sentAt: new Date(Date.now() - 5 * 3600_000), submittedAt: new Date() }).returning();
  // a legacy dry_run inside the 24 h doesn't count any more (else the cap would be reached at the 5 h old send)
  await db.insert(R).values({ userId: uA, accountId: accA.id, commentId: comments[7]!.id, platform: 'instagram', text: 'dry2', textHash: 'z', status: 'dry_run', method: 'device', handedAt: new Date(Date.now() - 6 * 3600_000), submittedAt: new Date() });
  r = await sch(await http('POST', `/api/comments/${comments[6]!.id}/replies`, A, { text: `Day ${tag}` }), A);
  const rep5 = r.body.reply;
  const def5 = await waitFor('deferred by day cap', async () => { const x = await reply(rep5.id); return x.round === 2 ? x : null; });
  const t5 = await taskOf(def5.taskId);
  check('per-day cap (2 device sends, legacy dry runs not counted): deferred to the oldest send + 24 h', !!t5 && Math.abs(t5.runAt!.getTime() - (Date.now() - 5 * 3600_000 + 86_400_000)) < 15_000
    && (await db.select().from(schema.commentLogs).where(and(eq(schema.commentLogs.commentTaskId, rep5.id), eq(schema.commentLogs.code, 'comment.daily_limited')))).length === 1, JSON.stringify(t5?.runAt));
  await http('POST', `/api/comment-replies/${rep5.id}/cancel`, A);
  await http('PUT', '/api/comments/settings', T, { minGapSec: 60, sendsPerDay: 50 });

  // a legacy dry_run does not block a real reply to the same comment
  r = await http('POST', `/api/comments/${comments[7]!.id}/replies`, A, { text: `After dry ${tag}` });
  check('a legacy dry_run (former test mode) reply does not block a real reply (draft) to the same comment', r.status === 201 && r.body.reply.status === 'draft', r.text);

  // ---------------------------------------------------------------- evidence screenshot
  const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
  const storage = await activeStorage();
  const ekey = `evidence/replies/feedchk-${tag}.png`;
  await storage.put(ekey, Readable.from([png]), png.length, 'image/png');
  evidenceKeys.push(ekey);
  const dr = dayRow; // a device send keeps its screenshot (taken before 发布) as evidence
  await db.update(R).set({ evidence: { at: new Date().toISOString(), storage: storage.kind, key: ekey, inputText: 'earlier2', excerpt: 'input: earlier2' } }).where(eq(R.id, dr!.id));
  const ev = await http('GET', `/api/comment-replies/${dr!.id}/evidence`, A);
  const evB = await http('GET', `/api/comment-replies/${dr!.id}/evidence`, B);
  const evNone = await http('GET', `/api/comment-replies/${rep1.id}/evidence`, A);
  check('evidence: owner gets the PNG, another user 404, no screenshot → 404 comment.no_evidence', ev.status === 200 && ev.type.startsWith('image/png') && ev.buf.equals(png) && evB.status === 404 && evNone.status === 404 && evNone.body.code === 'comment.no_evidence', `${ev.status} ${evB.status} ${evNone.status}`);
  r = await http('GET', `/api/comment-replies/${dr!.id}`, A);
  check('reply detail: hasEvidence, input text, storage key not exposed', r.body.reply.hasEvidence === true && r.body.reply.evidence.inputText === 'earlier2' && !('key' in r.body.reply.evidence), JSON.stringify(r.body.reply.evidence));

  // ---------------------------------------------------------------- hourly schedule
  await http('PUT', '/api/risk/settings', T, { feedCollectHours: 24 });
  await haltDevice(d2, { code: 'feed.challenge', source: 'feed', platform: 'instagram', socialAccountId: accB.id });
  // the monitor may have moved the placeholder (no container) away from running: set it as a running phone
  await db.update(schema.instances).set({ status: 'running', adbState: 'device' }).where(inArray(schema.instances.id, [d1.id, d2.id]));
  const s1 = await scheduleFeedCollects(new Date(), 25 * 3600_000);
  const s2 = await scheduleFeedCollects(new Date(), 25 * 3600_000);
  const sched = await db.select().from(schema.tasks).where(and(eq(schema.tasks.type, 'feed-collect'), inArray(schema.tasks.refId, [accA.id, accB.id, accS.id, accN.id]), like(schema.tasks.idempotencyKey, 'feed:%')));
  check('schedule (24 h): one slot per account on a running, not halted phone (halted + stopped skipped), key feed:social:<id>:<slot>',
    sched.length >= 1 && sched.every((t) => t.refId === accA.id && /^feed:social:[0-9a-f-]{36}:\d+$/.test(t.idempotencyKey ?? '') && (t.payload as any).scheduled === true) && s1.skipped >= 2,
    JSON.stringify({ s1, keys: sched.map((t) => t.idempotencyKey) }));
  check('schedule run twice → nothing new (idempotent)', s2.created === 0, JSON.stringify(s2));
  await db.update(schema.tasks).set({ status: 'cancelled', finishedAt: new Date() }).where(inArray(schema.tasks.id, sched.map((t) => t.id)));
  await http('PUT', '/api/risk/settings', T, { feedCollectHours: null });
  const s3 = await scheduleFeedCollects(new Date(), 25 * 3600_000);
  check('schedule off → nothing', s3.hours === null && s3.created === 0);
  await http('POST', `/api/risk/devices/${d2.id}/resume`, T);

  // ---------------------------------------------------------------- migration 0035 shape, run twice
  const [idx] = await sqlClient`select indexdef from pg_indexes where indexname = 'comment_tasks_one_active_idx'`;
  const [col] = await sqlClient`select is_nullable from information_schema.columns where table_name = 'comment_tasks' and column_name = 'comment_id'`;
  check('migration: comment_id nullable, one-active index ignores dry_run', col?.is_nullable === 'YES' && /dry_run/.test(String(idx?.indexdef)), `${col?.is_nullable} ${idx?.indexdef}`);
  const mig = () => execFileSync('npx', ['tsx', '--env-file=../../.env', 'src/db/migrate.ts'], { env: process.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const out1 = mig();
  const out2 = mig();
  const [cnt] = await sqlClient`select count(*)::int as n from drizzle.__drizzle_migrations`;
  check('db:migrate twice: both succeed, no new migration rows', /migrations applied/.test(out1) && /migrations applied/.test(out2) && Number(cnt?.n) >= 36, `${cnt?.n}`);

  // ---------------------------------------------------------------- audit
  await new Promise((res) => setTimeout(res, 500));
  const audits = (await db.select().from(schema.auditLogs).where(sql`${schema.auditLogs.at} >= ${t0.toISOString()}::timestamptz`));
  check('audit: feed.collect (202 + 409 + 404), comment.post_comment_create without the text, rules change refused 403, draft delete',
    audits.some((a) => a.action === 'feed.collect' && a.status === 202) && audits.some((a) => a.action === 'feed.collect' && a.status === 409)
    && audits.some((a) => a.action === 'comment.post_comment_create' && a.status === 201 && !JSON.stringify(a.detail ?? {}).includes('Post note'))
    && audits.some((a) => a.action === 'comment.rules_update' && a.status === 403 && !('testMode' in ((a.detail as object | null) ?? {})))
    && audits.some((a) => a.action === 'comment.reply_draft_delete' && a.status === 204) && audits.some((a) => a.action === 'comment.reply_submit' && a.status === 200)
    && audits.some((a) => a.action === 'comment.tracked_comment_create' && a.status === 201 && !!(a.detail as any)?.accountId && !JSON.stringify(a.detail ?? {}).includes('Tracked note'))
    && audits.some((a) => a.action === 'comment.tracked_comment_create' && a.status === 404)
    && audits.some((a) => a.action === 'comment.tracked_reply_create' && a.status === 201 && !!(a.detail as any)?.commentId && !JSON.stringify(a.detail ?? {}).includes('Tracked reply'))
    && audits.some((a) => a.action === 'comment.tracked_reply_create' && a.status === 409),
    audits.filter((a) => /feed|comment/.test(a.action)).map((a) => `${a.action}:${a.status}`).join(','));
} catch (err) {
  check(`unexpected error: ${(err as Error).stack}`, false);
} finally {
  await db.update(schema.tasks).set({ status: 'cancelled', finishedAt: new Date() }).where(and(inArray(schema.tasks.status, ['pending', 'scheduled']), sql`${schema.tasks.createdAt} >= ${t0.toISOString()}::timestamptz`));
  for (const k of evidenceKeys) await (await activeStorage()).delete(k).catch(() => undefined);
  for (const id of userIds) await http('DELETE', `/api/users/${id}`, T);
  if (devIds.length) {
    await db.delete(schema.riskEvents).where(inArray(schema.riskEvents.instanceId, devIds));
    await db.delete(schema.alertStates).where(inArray(schema.alertStates.key, devIds.map((id) => `${id}:instagram`)));
    await db.delete(schema.instances).where(inArray(schema.instances.id, devIds));
  }
  await db.delete(schema.settings).where(inArray(schema.settings.key, settingKeys));
  if (savedSettings.length) await db.insert(schema.settings).values(savedSettings);
  check('every created reply / comment started as a draft without a task', notDrafts === 0, String(notDrafts));
  const failed = results.filter(([, ok]) => !ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  await sqlClient.end();
  process.exit(failed ? 1 : 0);
}
