/**
 * 内容管理 批量操作 (POST /api/contents/batch) + 分区 tabs (GET /api/contents?status=<csv> with byStatus) against the
 * real API, DB, task centre (BullMQ) and media processing. No mocks.
 * - Two users A/B with one Instagram account each (no device needed: tasks are scheduled a day ahead and cancelled
 *   before they run). Admin distributes one of A's contents to B's account too (publish task owned by B).
 * - Actions: archive / unarchive / set-category / add-tags / remove-tags / cancel-publish / delete: successes, per-row
 *   skips with codes, RBAC (an invisible id anywhere → whole batch 404, nothing changed), admin behaviour,
 *   validation (empty / > 200 ids, missing categoryId / tags), audit rows (action + ids/counts, no texts).
 * - cancel-publish: only tasks the caller owns (users) are cancelled, task-centre tasks end cancelled, content status
 *   refreshed. One DB fixture, stated in the output: a publish task is set to `running` directly to see the
 *   "running tasks are skipped" path (no worker is involved), then set back and cancelled normally.
 * - List: csv status filter, legacy single status, byStatus counts exact per viewer (A never sees B's), unaffected by
 *   the status filter but following the other filters.
 * - 批量发布 (action publish): each content to its own default targets (content_targets) at one time; dryRun creates
 *   nothing; skips with codes (draft unless includeDrafts, archived, no targets, unfinished tasks, published on any
 *   account = publish.content_published (DB fixture: a task set to published directly), banned word of the account persona); RBAC 404; audit without texts.
 * Usage (from apps/api, API running): E2E_API=http://127.0.0.1:3000 npx tsx --env-file=../../.env scripts/content-batch-check.ts
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { ilike, inArray } from 'drizzle-orm';
import sharp from 'sharp';
import { db, schema, sqlClient } from '../src/db/index.js';
import { withCaptcha } from './lib/login.js';

const API = process.env.E2E_API ?? 'http://127.0.0.1:3000';
const results: [string, boolean][] = [];
const check = (name: string, ok: boolean, detail = '') => { results.push([name, ok]); console.log(`${ok ? '✓' : '✗'} ${name}${detail && !ok ? ` — ${detail}` : ''}`); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function http<T = any>(method: string, p: string, token: string, body?: unknown) {
  const res = await fetch(API + p, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body !== undefined && !(body instanceof FormData) ? { 'content-type': 'application/json' } : {}) },
    body: body instanceof FormData ? body : body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* 204 */ }
  return { status: res.status, body: json as T, text };
}
async function login(username: string, password: string): Promise<string> {
  const r = await fetch(`${API}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(await withCaptcha(API, { username, password })) });
  return (await r.json()).token;
}

const T = await login(process.env.ADMIN_USERNAME!, process.env.ADMIN_PASSWORD!);
const tag = randomBytes(3).toString('hex');
const pw = randomBytes(12).toString('hex');
const userIds: string[] = [];
const contentIds: string[] = [];
const t0 = new Date((await sqlClient`select now() as now`)[0]!.now as Date);
const C = schema.contents;
const PT = schema.publishTasks;

try {
  // ---------------------------------------------------------------- setup
  const mk = async (name: string) => {
    const r = await http('POST', '/api/users', T, { username: name, password: pw, role: 'user' });
    const id = r.body.user?.id ?? r.body.id; userIds.push(id);
    return { id: id as string, token: await login(name, pw) };
  };
  const A = await mk(`cba${tag}`);
  const B = await mk(`cbb${tag}`);
  const acc = async (token: string) => {
    const r = await http('POST', '/api/social/accounts', token, { platform: 'instagram', handle: `cb_${tag}_${randomBytes(2).toString('hex')}`, loginStatus: 'logged_in' });
    if (r.status !== 201) throw new Error(`account ${r.status} ${r.text}`);
    return r.body.account.id as string;
  };
  const igA = await acc(A.token);
  const igB = await acc(B.token);
  const upload = async (token: string, name: string) => {
    const fd = new FormData();
    fd.append('scope', 'mine');
    fd.append('file', new Blob([new Uint8Array(await sharp({ create: { width: 320, height: 320, channels: 3, background: '#2a7' } }).jpeg().toBuffer())], { type: 'image/jpeg' }), name);
    const r = await http('POST', '/api/media/upload', token, fd);
    if (r.status !== 201) throw new Error(`upload ${r.status} ${r.text}`);
    const id: string = r.body.item.id;
    for (let i = 0; i < 120; i++) { if ((await http('GET', `/api/media/${id}`, token)).body.item.status === 'ready') return id; await sleep(500); }
    throw new Error('media not ready');
  };
  const imgA = await upload(A.token, `cb-a-${tag}.jpg`);
  const imgB = await upload(B.token, `cb-b-${tag}.jpg`);
  const newContent = async (token: string, title: string, extra: Record<string, unknown> = {}) => {
    const r = await http('POST', '/api/contents', token, { title: `cb-${tag} ${title}`, body: `SECRET-BODY-${tag}`, ...extra });
    if (r.status !== 201) throw new Error(`content ${r.status} ${r.text}`);
    contentIds.push(r.body.content.id);
    return r.body.content.id as string;
  };
  const tomorrow = new Date(Date.now() + 86400_000).toISOString();
  const distribute = async (token: string, id: string, accountIds: string[]) => {
    const r = await http('POST', `/api/contents/${id}/distribute`, token, { targets: accountIds.map((accountId) => ({ accountId, scheduledAt: tomorrow })) });
    if (r.status !== 201) throw new Error(`distribute ${r.status} ${r.text}`);
    return (r.body.created as any[]).map((x) => x.id as string);
  };
  const a1 = await newContent(A.token, 'a1', { tags: ['x'] });
  const a2 = await newContent(A.token, 'a2');
  const a3 = await newContent(A.token, 'a3');
  const aPub = await newContent(A.token, 'aPub', { mediaIds: [imgA] });
  const aMix = await newContent(A.token, 'aMix', { mediaIds: [imgA] });
  const b1 = await newContent(B.token, 'b1');
  const bPub = await newContent(B.token, 'bPub', { mediaIds: [imgB] });
  const t1 = await newContent(T, 't1');
  const [ptAPub] = await distribute(A.token, aPub, [igA]);
  const [ptMixA, ptMixB] = await distribute(T, aMix, [igA, igB]); // admin: A's content to A's and B's account
  const [ptBPub] = await distribute(B.token, bPub, [igB]);
  const mixRows = await db.select({ id: PT.id, userId: PT.userId }).from(PT).where(inArray(PT.id, [ptMixA!, ptMixB!]));
  check('setup: 2 users, 2 IG accounts, 8 contents, 4 publish tasks scheduled for tomorrow (admin put one of A\'s contents on B\'s account)',
    mixRows.find((x) => x.id === ptMixB)?.userId === B.id && mixRows.find((x) => x.id === ptMixA)?.userId === A.id && !!ptAPub && !!ptBPub);

  const batch = (token: string, body: Record<string, unknown>) => http('POST', '/api/contents/batch', token, body);
  const get = async (token: string, id: string) => (await http('GET', `/api/contents/${id}`, token)).body?.content;
  const skipOf = (r: any, id: string) => (r.body.skipped as any[]).find((x) => x.id === id);
  const sameSet = (a: string[], b: string[]) => [...a].sort().join() === [...b].sort().join();

  // ---------------------------------------------------------------- list: tabs (csv status + byStatus)
  const zero = { draft: 0, ready: 0, scheduled: 0, partially_published: 0, published: 0, failed: 0, archived: 0 };
  const counts = (r: any) => JSON.stringify(r.body.byStatus);
  let r = await http('GET', '/api/contents', A.token);
  check('byStatus (A): exactly its own 3 draft + 2 scheduled', counts(r) === JSON.stringify({ ...zero, draft: 3, scheduled: 2 }) && r.body.total === 5, counts(r));
  r = await http('GET', '/api/contents', B.token);
  check('byStatus (B): 1 draft + 1 scheduled, none of A\'s', counts(r) === JSON.stringify({ ...zero, draft: 1, scheduled: 1 }) && r.body.total === 2, counts(r));
  r = await http('GET', `/api/contents?ownerId=${A.id}`, T);
  check('byStatus (admin, ownerId=A) = A\'s counts', counts(r) === JSON.stringify({ ...zero, draft: 3, scheduled: 2 }), counts(r));
  r = await http('GET', '/api/contents?status=ready,scheduled', A.token);
  check('status=ready,scheduled (csv): the 2 scheduled contents; byStatus ignores the status filter',
    r.status === 200 && r.body.total === 2 && sameSet(r.body.items.map((x: any) => x.id), [aPub, aMix]) && r.body.byStatus.draft === 3, `${r.status} ${counts(r)}`);
  r = await http('GET', '/api/contents?status=draft', A.token);
  check('legacy single status=draft still works', r.status === 200 && r.body.total === 3 && sameSet(r.body.items.map((x: any) => x.id), [a1, a2, a3]));
  r = await http('GET', `/api/contents?q=${encodeURIComponent(`cb-${tag} a1`)}&status=published,partially_published`, A.token);
  check('byStatus follows the other filters (q → only a1 counted); empty tab → 0 items', r.body.total === 0 && counts(r) === JSON.stringify({ ...zero, draft: 1 }), counts(r));
  r = await http('GET', '/api/contents?status=draft,bogus', A.token);
  check('unknown status in csv → 400', r.status === 400);

  // ---------------------------------------------------------------- validation
  r = await batch(A.token, { ids: [], action: 'archive' });
  check('empty ids → 400', r.status === 400);
  r = await batch(A.token, { ids: Array.from({ length: 201 }, () => randomUUID()), action: 'archive' });
  check('201 ids → 400 (limit 200)', r.status === 400);
  r = await batch(A.token, { ids: [a1], action: 'bogus' });
  check('unknown action → 400', r.status === 400);
  r = await batch(A.token, { ids: [a1], action: 'set-category' });
  check('set-category without categoryId → 400 content.batch_category_required', r.status === 400 && r.body.code === 'content.batch_category_required', r.text);
  r = await batch(A.token, { ids: [a1], action: 'add-tags', tags: [] });
  check('add-tags without tags → 400 content.batch_tags_required', r.status === 400 && r.body.code === 'content.batch_tags_required', r.text);
  r = await batch(A.token, { ids: [a1], action: 'set-category', categoryId: randomUUID() });
  check('unknown category → 400 content_category.not_allowed', r.status === 400 && r.body.code === 'content_category.not_allowed', r.text);

  // ---------------------------------------------------------------- RBAC
  r = await batch(A.token, { ids: [a1, b1], action: 'archive' });
  check("A with B's content in the batch → 404 content.not_found", r.status === 404 && r.body.code === 'content.not_found');
  check('… and nothing changed (a1 still draft)', (await get(A.token, a1)).stage === 'draft');
  r = await batch(A.token, { ids: [a2, t1], action: 'delete' });
  check("A with admin's content → 404, a2 not deleted", r.status === 404 && (await get(A.token, a2))?.id === a2);
  r = await batch(A.token, { ids: [a2, randomUUID()], action: 'add-tags', tags: ['z'] });
  check('unknown id → 404', r.status === 404 && (await get(A.token, a2)).tags.length === 0);
  r = await batch(B.token, { ids: [aMix], action: 'cancel-publish' });
  check("B cannot cancel via A's content even though one of its tasks is B's (404)", r.status === 404);

  // ---------------------------------------------------------------- archive / unarchive
  r = await batch(A.token, { ids: [a1, aPub, a1], action: 'archive' });
  check('archive [a1, aPub]: ids deduped, a1 ok, aPub skipped content.archive_unfinished {count:1}',
    r.status === 200 && r.body.count === 2 && sameSet(r.body.ok, [a1]) && r.body.changed === 1 && skipOf(r, aPub)?.code === 'content.archive_unfinished' && skipOf(r, aPub)?.params?.count === 1, r.text);
  check('a1 stage + status archived; aPub unchanged (scheduled)', (await get(A.token, a1)).status === 'archived' && (await get(A.token, aPub)).status === 'scheduled');
  r = await batch(A.token, { ids: [a1], action: 'archive' });
  check('archive again: ok, changed 0', r.body.ok.length === 1 && r.body.changed === 0);
  r = await http('GET', '/api/contents?status=archived', A.token);
  check('tab 已归档 (status=archived): a1; byStatus archived 1, draft 2', r.body.total === 1 && r.body.items[0].id === a1 && r.body.byStatus.archived === 1 && r.body.byStatus.draft === 2, counts(r));
  r = await batch(A.token, { ids: [a1, a2], action: 'unarchive' });
  const a1u = await get(A.token, a1);
  check('unarchive [a1, a2]: both ok, 1 changed; a1 back to ready (like the row action)', r.body.ok.length === 2 && r.body.changed === 1 && a1u.stage === 'ready' && a1u.status === 'ready', r.text);

  // ---------------------------------------------------------------- set-category
  const catA = (await http('POST', '/api/content-categories', A.token, { scope: 'mine', name: `cbA ${tag}` })).body.category;
  const catB = (await http('POST', '/api/content-categories', B.token, { scope: 'mine', name: `cbB ${tag}` })).body.category;
  const catP = (await http('POST', '/api/content-categories', T, { scope: 'public', name: `cbP ${tag}` })).body.category;
  r = await batch(A.token, { ids: [a1, a2], action: 'set-category', categoryId: catA.id });
  check("set-category (A's own category): 2 changed", r.body.changed === 2 && (await get(A.token, a2)).category?.id === catA.id, r.text);
  r = await batch(A.token, { ids: [a1, a2], action: 'set-category', categoryId: catB.id });
  check("set-category with B's category: both skipped content_category.not_allowed, unchanged",
    r.body.ok.length === 0 && r.body.skipped.length === 2 && r.body.skipped.every((x: any) => x.code === 'content_category.not_allowed') && (await get(A.token, a1)).category?.id === catA.id, r.text);
  r = await batch(T, { ids: [a1, t1], action: 'set-category', categoryId: catA.id });
  check("admin: A's personal category fits a1 (no change), skipped for admin's own t1", sameSet(r.body.ok, [a1]) && skipOf(r, t1)?.code === 'content_category.not_allowed', r.text);
  r = await batch(T, { ids: [a1, t1], action: 'set-category', categoryId: catP.id });
  check('admin: public category on A\'s and admin\'s content → 2 changed', r.body.changed === 2 && (await get(T, t1)).category?.id === catP.id, r.text);
  r = await batch(A.token, { ids: [a1], action: 'set-category', categoryId: null });
  check('set-category null clears', r.body.changed === 1 && (await get(A.token, a1)).category === null);

  // ---------------------------------------------------------------- tags
  r = await batch(A.token, { ids: [a1, a2], action: 'add-tags', tags: ['X', 'y'] });
  // Tag names are shared case-insensitively: the stored spelling "x" wins (same as PUT /api/contents/:id).
  check('add-tags [X, y]: a1 keeps its "x" (no duplicate) + y, a2 gets the stored spelling x + y', r.body.changed === 2
    && (await get(A.token, a1)).tags.join() === 'x,y' && (await get(A.token, a2)).tags.join() === 'x,y', JSON.stringify([(await get(A.token, a1)).tags, (await get(A.token, a2)).tags]));
  r = await batch(A.token, { ids: [a1, a2, a3], action: 'remove-tags', tags: ['x'] });
  check('remove-tags [x]: 2 changed, a3 ok without change', r.body.ok.length === 3 && r.body.changed === 2 && (await get(A.token, a1)).tags.join() === 'y' && (await get(A.token, a2)).tags.join() === 'y', r.text);

  // ---------------------------------------------------------------- cancel-publish
  r = await batch(A.token, { ids: [a3, aPub, aMix], action: 'cancel-publish' });
  check('A cancel-publish [a3, aPub, aMix]: aPub + aMix ok, a3 skipped content.no_unfinished_publish, 2 tasks cancelled',
    sameSet(r.body.ok, [aPub, aMix]) && skipOf(r, a3)?.code === 'content.no_unfinished_publish' && r.body.cancelledTasks === 2, r.text);
  const pts = await db.select().from(PT).where(inArray(PT.id, [ptAPub!, ptMixA!, ptMixB!]));
  const st = (id: string) => pts.find((x) => x.id === id)?.status;
  check("A's tasks cancelled, B's task on A's content untouched (scheduled)", st(ptAPub!) === 'cancelled' && st(ptMixA!) === 'cancelled' && st(ptMixB!) === 'scheduled', JSON.stringify(pts.map((x) => x.status)));
  const tTasks = await db.select().from(schema.tasks).where(inArray(schema.tasks.id, pts.map((x) => x.taskId!).filter(Boolean)));
  const tst = (ptId: string) => tTasks.find((x) => x.id === pts.find((p) => p.id === ptId)?.taskId)?.status;
  check('task-centre tasks: cancelled for A\'s, still scheduled for B\'s', tst(ptAPub!) === 'cancelled' && tst(ptMixA!) === 'cancelled' && tst(ptMixB!) === 'scheduled', JSON.stringify(tTasks.map((x) => x.status)));
  check('content status refreshed: aPub ready (no live tasks), aMix still scheduled (B\'s task)', (await get(A.token, aPub)).status === 'ready' && (await get(A.token, aMix)).status === 'scheduled');
  // DB fixture: the task is marked running directly (no worker), to see that running tasks are not cancelled.
  console.log('  (fixture: publish task of bPub set to running directly in the DB, then set back)');
  await sqlClient`update publish_tasks set status = 'running' where id = ${ptBPub!}`;
  r = await batch(B.token, { ids: [bPub], action: 'cancel-publish' });
  check('running task: skipped publish.bad_status {status: running, cancelled 0/1}', r.body.ok.length === 0 && skipOf(r, bPub)?.code === 'publish.bad_status'
    && skipOf(r, bPub)?.params?.status === 'running' && skipOf(r, bPub)?.params?.total === 1 && r.body.cancelledTasks === 0, r.text);
  await sqlClient`update publish_tasks set status = 'scheduled' where id = ${ptBPub!}`;
  r = await batch(B.token, { ids: [bPub], action: 'cancel-publish' });
  check('after set back: B cancels its own → ok, content bPub ready', r.body.ok.length === 1 && r.body.cancelledTasks === 1 && (await get(B.token, bPub)).status === 'ready', r.text);
  r = await batch(T, { ids: [aMix], action: 'cancel-publish' });
  check("admin cancel-publish aMix: B's task cancelled, aMix → ready", r.body.cancelledTasks === 1 && (await db.select().from(PT).where(inArray(PT.id, [ptMixB!])))[0]?.status === 'cancelled'
    && (await get(A.token, aMix)).status === 'ready', r.text);

  // ---------------------------------------------------------------- delete
  const aBusy = await newContent(A.token, 'aBusy', { mediaIds: [imgA] });
  const [ptBusy] = await distribute(A.token, aBusy, [igA]);
  r = await batch(A.token, { ids: [a3, aBusy], action: 'delete' });
  check('delete [a3, aBusy]: a3 deleted, aBusy skipped content.has_unfinished_publish', sameSet(r.body.ok, [a3]) && skipOf(r, aBusy)?.code === 'content.has_unfinished_publish'
    && (await http('GET', `/api/contents/${a3}`, A.token)).status === 404 && (await get(A.token, aBusy))?.id === aBusy, r.text);
  await http('POST', `/api/publish/tasks/${ptBusy}/cancel`, A.token);
  r = await batch(T, { ids: [aBusy, aPub, t1], action: 'delete' });
  check("admin deletes A's (now cancelled) and its own contents: 3 ok, history gone", r.body.ok.length === 3
    && (await db.select().from(C).where(inArray(C.id, [aBusy, aPub, t1]))).length === 0 && (await db.select().from(PT).where(inArray(PT.id, [ptBusy!, ptAPub!]))).length === 0, r.text);
  r = await http('GET', '/api/contents', A.token);
  check('byStatus (A) at the end: ready 2 (a1 unarchived, aMix cancelled), draft 1 (a2)', counts(r) === JSON.stringify({ ...zero, draft: 1, ready: 2 }) && r.body.total === 3, counts(r));

  // ---------------------------------------------------------------- 批量发布 (action publish)
  {
    const pubAt = new Date(Date.now() + 86400_000 + 3600_000); pubAt.setUTCSeconds(0, 0);
    const igA2 = await acc(A.token);
    const pReady = await newContent(A.token, 'pReady', { mediaIds: [imgA], targetIds: [igA, igA2], stage: 'ready' });
    const pDraft = await newContent(A.token, 'pDraft', { mediaIds: [imgA], targetIds: [igA] });
    const pArch = await newContent(A.token, 'pArch', { mediaIds: [imgA], targetIds: [igA], stage: 'ready' });
    await http('PUT', `/api/contents/${pArch}`, A.token, { stage: 'archived' });
    const pNoT = await newContent(A.token, 'pNoT', { mediaIds: [imgA], stage: 'ready' });
    const pDone = await newContent(A.token, 'pDone', { mediaIds: [imgA], targetIds: [igA, igA2], stage: 'ready' });
    const pBan = await newContent(A.token, 'pBan', { mediaIds: [imgA], targetIds: [igA2], stage: 'ready', body: `BANWORD${tag} SECRET-BODY-${tag}` });
    // pDone: published to igA before, igA2 not yet (DB fixture: its distributed task is cancelled, then marked published directly)
    const [ptDone] = await distribute(A.token, pDone, [igA]);
    await http('POST', `/api/publish/tasks/${ptDone}/cancel`, A.token);
    console.log('  (fixture: publish task of pDone set to published directly in the DB)');
    await sqlClient`update publish_tasks set status = 'published', published_at = now() where id = ${ptDone!}`;
    // 发布后不能再发: the single 分发 refuses a published content for every account, also with an older page's `republish: true`
    r = await http('POST', `/api/contents/${pDone}/distribute`, A.token, { targets: [{ accountId: igA }], republish: true });
    check('single distribute to the published pair (even with republish: true) → 409 publish.content_published', r.status === 409 && r.body.code === 'publish.content_published' && r.body.params?.count === 1, r.text);
    r = await http('POST', `/api/contents/${pDone}/distribute`, A.token, { targets: [{ accountId: igA2 }] });
    check('single distribute of the published content to a not yet published account → 409 publish.content_published', r.status === 409 && r.body.code === 'publish.content_published', r.text);
    // banned word: A's personal persona with a banned word, set on igA2 AFTER the content was saved (saving would refuse it)
    const pers = await http('POST', '/api/personas', A.token, { scope: 'mine', name: `cbper ${tag}`, style: { bannedWords: [`BANWORD${tag}`] } });
    const persSet = await http('PUT', `/api/social/accounts/${igA2}`, A.token, { personaId: pers.body.persona?.id });
    check('setup 批量发布: 6 contents, persona with banned word on igA2', pers.status === 201 && persSet.status === 200, `${pers.status} ${persSet.status}`);
    const ptCount = async () => (await db.select({ id: PT.id }).from(PT).where(inArray(PT.contentId, [pReady, pDraft, pArch, pNoT, pDone, pBan]))).length;
    const before = await ptCount();
    const ids6 = [pReady, pDraft, pArch, pNoT, pDone, pBan];
    const pub = (token: string, extra: Record<string, unknown> = {}) => batch(token, { ids: ids6, action: 'publish', scheduledAt: pubAt.toISOString(), ...extra });

    r = await pub(A.token, { dryRun: true });
    const item = (x: any, id: string) => (x.body.publish?.items as any[] | undefined)?.find((i) => i.id === id);
    check('dryRun: pReady (2 accounts) and pBan (1) would publish; draft/archived/no targets/published skipped with codes; tasks=3, changed 0',
      r.status === 200 && sameSet(r.body.ok, [pReady, pBan]) && item(r, pReady)?.accounts === 2 && r.body.publish.tasks === 3 && r.body.changed === 0
      && skipOf(r, pDraft)?.code === 'content.batch_publish_draft' && skipOf(r, pArch)?.code === 'content.archived'
      && skipOf(r, pNoT)?.code === 'content.batch_publish_no_targets' && skipOf(r, pDone)?.code === 'publish.content_published' && skipOf(r, pDone)?.params?.count === 1, r.text);
    check('dryRun created no publish task', (await ptCount()) === before);

    r = await pub(B.token);
    check("B with A's contents → 404 content.not_found, nothing created", r.status === 404 && r.body.code === 'content.not_found' && (await ptCount()) === before);
    r = await batch(A.token, { ids: [pReady], action: 'publish', scheduledAt: new Date(Date.now() + 400 * 86400_000).toISOString() });
    check('scheduledAt > 1 year → 400 publish.too_far', r.status === 400 && r.body.code === 'publish.too_far', r.text);
    r = await batch(A.token, { ids: [pReady], action: 'publish', scheduledAt: 'tomorrow' });
    check('bad scheduledAt → 400', r.status === 400);

    r = await pub(A.token);
    check('publish: pReady ok (2 tasks), pBan skipped persona.banned_word, others skipped as in the preview; changed 1, tasks 2',
      r.status === 200 && sameSet(r.body.ok, [pReady]) && r.body.changed === 1 && r.body.publish.tasks === 2 && item(r, pReady)?.accounts === 2
      && skipOf(r, pBan)?.code === 'persona.banned_word' && skipOf(r, pDraft)?.code === 'content.batch_publish_draft', r.text);
    const created = await db.select().from(PT).where(inArray(PT.contentId, [pReady]));
    const ctasks = await db.select().from(schema.tasks).where(inArray(schema.tasks.id, created.map((x) => x.taskId!).filter(Boolean)));
    check('pReady: 2 scheduled publish tasks (igA, igA2) at the chosen time, feed', created.length === 2 && created.every((x) => x.status === 'scheduled' && x.postType === 'feed' && x.scheduledAt.getTime() === pubAt.getTime())
      && sameSet(created.map((x) => x.accountId), [igA, igA2]), JSON.stringify(created.map((x) => [x.status, x.scheduledAt])));
    check('task-centre tasks exist, scheduled, runAt = scheduledAt', ctasks.length === 2 && ctasks.every((x) => x.status === 'scheduled' && x.type === 'publish' && x.runAt?.getTime() === pubAt.getTime()),
      JSON.stringify(ctasks.map((x) => [x.status, x.runAt])));
    check('pBan: nothing created (banned word refused the whole content)', (await db.select().from(PT).where(inArray(PT.contentId, [pBan]))).length === 0);

    r = await batch(A.token, { ids: [pReady], action: 'publish', scheduledAt: pubAt.toISOString() });
    check('again: pReady skipped content.batch_publish_unfinished {n: 2}', skipOf(r, pReady)?.code === 'content.batch_publish_unfinished' && skipOf(r, pReady)?.params?.n === 2 && r.body.changed === 0, r.text);

    r = await batch(A.token, { ids: [pDraft], action: 'publish', includeDrafts: true, scheduledAt: pubAt.toISOString() });
    const dTasks = await db.select().from(PT).where(inArray(PT.contentId, [pDraft]));
    check('includeDrafts: draft published (1 scheduled task) and stage → ready', r.body.changed === 1 && dTasks.length === 1 && dTasks[0]!.status === 'scheduled'
      && (await get(A.token, pDraft)).stage === 'ready', `${r.text} ${dTasks[0]?.status}`);

    await sleep(500);
    const arows = await sqlClient`select action, user_id, status, detail from audit_logs where at >= ${t0.toISOString()}::timestamptz and action = 'content.batch.publish'`;
    const real = arows.filter((x) => x.user_id === A.id && x.status === 200);
    check('audit: content.batch.publish rows (no dryRun row: previews are not recorded)', real.length === 3 && !real.some((x) => x.detail?.dryRun) && real.some((x) => x.detail?.tasks === 2 && x.detail?.scheduledAt === pubAt.toISOString()),
      JSON.stringify(real.map((x) => x.detail)));
    check('audit 批量发布: no titles, bodies or banned words', !JSON.stringify(arows.map((x) => x.detail)).includes('SECRET-BODY') && !JSON.stringify(arows.map((x) => x.detail)).includes(`cb-${tag}`) && !JSON.stringify(arows.map((x) => x.detail)).includes('BANWORD'));
    // the created tasks are cancelled by the cleanup below (scheduled/pending ones)
    for (const x of [...created, ...dTasks]) if (['pending', 'scheduled', 'awaiting_operator'].includes(x.status)) await http('POST', `/api/publish/tasks/${x.id}/cancel`, A.token);
    await db.delete(schema.personas).where(ilike(schema.personas.name, `%${tag}%`));
  }

  // ---------------------------------------------------------------- audit
  await sleep(500);
  const rows = await sqlClient`select action, user_id, status, detail from audit_logs where at >= ${t0.toISOString()}::timestamptz and action like 'content.batch.%'`;
  const have = new Set(rows.filter((x) => x.status === 200).map((x) => x.action as string));
  const want = ['archive', 'unarchive', 'set-category', 'add-tags', 'remove-tags', 'cancel-publish', 'delete'].map((a) => `content.batch.${a}`);
  check('audit: content.batch.<action> recorded for every action', want.every((x) => have.has(x)), [...have].join());
  const cancelRow = rows.find((x) => x.action === 'content.batch.cancel-publish' && x.user_id === A.id && x.status === 200);
  check('audit detail: action, ids, count, ok/skipped/changed counts, cancelledTasks', cancelRow?.detail?.action === 'cancel-publish' && cancelRow.detail.count === 3
    && cancelRow.detail.ok === 2 && cancelRow.detail.skipped === 1 && cancelRow.detail.cancelledTasks === 2 && sameSet(cancelRow.detail.ids, [a3, aPub, aMix]), JSON.stringify(cancelRow?.detail));
  check('audit: refused batch (404) recorded as failed', rows.some((x) => x.status === 404 && x.user_id === A.id));
  check('audit: no titles or bodies in batch details', !JSON.stringify(rows.map((x) => x.detail)).includes('SECRET-BODY') && !JSON.stringify(rows.map((x) => x.detail)).includes(`cb-${tag}`));
} catch (err) {
  check(`unexpected error: ${(err as Error).message}`, false);
} finally {
  // Cancel whatever is still waiting (so no delayed job fires tomorrow), then remove the test data.
  const left = contentIds.length ? await db.select().from(PT).where(inArray(PT.contentId, contentIds)) : [];
  for (const p of left.filter((x) => ['pending', 'scheduled', 'awaiting_operator'].includes(x.status))) await http('POST', `/api/publish/tasks/${p.id}/cancel`, T);
  if (contentIds.length) await db.delete(C).where(inArray(C.id, contentIds));
  for (const id of userIds) await http('DELETE', `/api/users/${id}`, T);
  await db.delete(schema.contentCategories).where(ilike(schema.contentCategories.name, `%${tag}%`));
  const leftC = contentIds.length ? await db.select().from(C).where(inArray(C.id, contentIds)) : [];
  check('cleanup: test contents, users and categories removed', leftC.length === 0);
  await sqlClient.end();
  const failed = results.filter((x) => !x[1]).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}
