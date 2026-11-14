/**
 * Comments & engagement (评论互动) test against the real API + DB + Redis + task centre (no mocks).
 * - Rules (admin-only settings), account read/reply modes, sync refused for manual-only platforms.
 * - Sync + reply jobs with placeholder OAuth connections holding fake tokens: the REAL YouTube / Instagram
 *   endpoints reject them → task fails with platform.auth_expired, nothing leaks the tokens.
 * - Manual comment entry (threads), list/detail/status/delete, publish-task link by external post id.
 * - Reply workflow end to end on the manual path: draft → review → approve → awaiting_operator → sent / failed;
 *   self-approval refused, reject with reason, batch approval, scheduled send + cancel, edit rules.
 * - Anti-abuse: one reply per comment (again allowed after failed / rejected / cancelled), duplicate-text
 *   limit (normalized), per-account send rate limit (deferred, not dropped), every block logged with its code.
 * - Idempotency of the reply job (same key → same task), RBAC/isolation (admin, user A, user B), templates, audit.
 * Creates two temporary users and removes everything afterwards.
 * Usage (from apps/api, API running): npx tsx --env-file=../../.env scripts/comments-check.ts
 */
import { randomBytes } from 'node:crypto';
import { and, eq, gte, inArray, like } from 'drizzle-orm';
import { db, schema, sqlClient } from '../src/db/index.js';
import { sealSecret } from '../src/lib/secret-box.js';
import { closeTaskQueues, createTask } from '../src/modules/tasks/core.js';
import '../src/modules/comments/comments.js'; // registers comment-sync / comment-reply (idempotency check below)

const API = `http://127.0.0.1:${process.env.API_PORT ?? 3000}`;
const results: [string, boolean][] = [];
const check = (name: string, ok: boolean, detail = '') => { results.push([name, ok]); console.log(`${ok ? '✓' : '✗'} ${name}${detail && !ok ? ` — ${detail}` : ''}`); };

async function http<T = any>(method: string, path: string, token: string | null, body?: unknown) {
  const res = await fetch(API + path, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* 204 */ }
  return { status: res.status, body: json as T, text };
}
async function login(username: string, password: string): Promise<string> {
  const r = await fetch(`${API}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) });
  return (await r.json()).token;
}
async function waitFor<T>(label: string, fn: () => Promise<T | null | false | undefined>, ms = 60_000): Promise<T> {
  const t0 = Date.now();
  for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() - t0 > ms) throw new Error(`timeout: ${label}`); await new Promise((r) => setTimeout(r, 300)); }
}
const replyRow = async (id: string) => (await db.select().from(schema.commentTasks).where(eq(schema.commentTasks.id, id)))[0]!;
const waitReply = (id: string, statuses: string[]) => waitFor(`reply ${statuses.join('/')}`, async () => { const r = await replyRow(id); return statuses.includes(r.status) ? r : null; });
const taskRow = async (id: string) => (await db.select().from(schema.tasks).where(eq(schema.tasks.id, id)))[0]!;
const waitTask = (id: string) => waitFor('task final', async () => { const t = await taskRow(id); return ['success', 'failed', 'cancelled'].includes(t.status) ? t : null; });

const T = await login(process.env.ADMIN_USERNAME!, process.env.ADMIN_PASSWORD!);
const tag = randomBytes(3).toString('hex');
const h = (s: string) => `cc_${tag}_${s}`;
const FAKE = { yt: `ya29.fake-${randomBytes(16).toString('hex')}`, ytR: `1//fake-${randomBytes(16).toString('hex')}`, ig: `IGfake${randomBytes(16).toString('hex')}` };
const SECRET = `cs-${randomBytes(12).toString('hex')}`;
const SECRETS = [SECRET, ...Object.values(FAKE)];
const leaks = (s: string) => SECRETS.filter((x) => s.includes(x));
const userIds: string[] = [];
const sharedTemplates: string[] = [];
const contentIds: string[] = [];
const [rulesBefore] = await db.select().from(schema.settings).where(eq(schema.settings.key, 'comments.rules'));
const [appsBefore] = await db.select().from(schema.settings).where(eq(schema.settings.key, 'platform.apps'));
const t0 = new Date();

try {
  // ---------------------------------------------------------------- setup
  await db.delete(schema.settings).where(eq(schema.settings.key, 'comments.rules'));
  await db.delete(schema.settings).where(eq(schema.settings.key, 'platform.apps'));
  const pw = randomBytes(12).toString('base64url');
  for (const n of ['a', 'b']) {
    const r = await http('POST', '/api/users', T, { username: `cc${n}${tag}`, password: pw, role: 'user' });
    userIds.push(r.body.user?.id ?? r.body.id);
  }
  const [uA] = userIds as [string, string];
  const A = await login(`cca${tag}`, pw);
  const B = await login(`ccb${tag}`, pw);
  const mk = async (token: string, platform: string, handle: string) => (await http('POST', '/api/social/accounts', token, { platform, handle })).body.account.id as string;
  const ya = await mk(A, 'youtube', h('ya'));
  const ia = await mk(A, 'instagram', h('ia'));
  const ta = await mk(A, 'tiktok', h('ta'));
  const ta2 = await mk(A, 'tiktok', h('ta2'));
  const tb = await mk(B, 'tiktok', h('tb'));

  // ---------------------------------------------------------------- rules
  let r = await http('GET', '/api/comments/settings', A);
  check('rules default: approval on, same text ≤ 3 / 24 h, 20 sends / h',
    r.status === 200 && r.body.rules.requireApproval === true && r.body.rules.duplicateMax === 3 && r.body.rules.duplicateWindowHours === 24 && r.body.rules.sendsPerHour === 20, r.text);
  r = await http('PUT', '/api/comments/settings', A, { sendsPerHour: 100 });
  check('user: PUT rules → 403 comment.admin_only', r.status === 403 && r.body.code === 'comment.admin_only', r.text);
  r = await http('PUT', '/api/comments/settings', T, { sendsPerHour: 0 });
  check('admin: invalid rule (0 sends/h) → 400', r.status === 400);
  r = await http('PUT', '/api/comments/settings', T, { duplicateMax: 3, sendsPerHour: 20, requireApproval: true });
  check('admin: PUT rules', r.status === 200 && r.body.rules.sendsPerHour === 20);

  // ---------------------------------------------------------------- accounts / modes / sync refusals
  r = await http('GET', '/api/comments/accounts', A);
  const accA = (id: string) => r.body.accounts.find((x: any) => x.id === id);
  check('user A: comment accounts = own 4 only', r.status === 200 && r.body.accounts.length === 4 && !accA(tb), r.text.slice(0, 300));
  check('TikTok: manual only (no comment API)', accA(ta)?.readMode === 'manual' && accA(ta)?.readReason === 'platform.capability_unsupported' && accA(ta)?.commentsRead === false);
  check('YouTube without app credentials: manual (platform.not_configured)', accA(ya)?.readMode === 'manual' && accA(ya)?.readReason === 'platform.not_configured' && accA(ya)?.commentsReply === true);
  r = await http('POST', `/api/comments/accounts/${ta}/sync`, A);
  check('sync TikTok → 409 comment.sync_unsupported', r.status === 409 && r.body.code === 'comment.sync_unsupported', r.text);
  r = await http('POST', `/api/comments/accounts/${ya}/sync`, A);
  check('sync YouTube without credentials → 409 platform.not_configured', r.status === 409 && r.body.code === 'platform.not_configured', r.text);
  r = await http('POST', `/api/comments/accounts/${ya}/sync`, B);
  check('user B: sync A\'s account → 404', r.status === 404);

  // placeholder app credentials + connections with fake tokens (like platforms-check)
  await http('PUT', '/api/settings/platforms/youtube', T, { clientId: `000000000000-${tag}dummy.apps.googleusercontent.com`, clientSecret: SECRET });
  await http('PUT', '/api/settings/platforms/instagram', T, { clientId: `9${Date.now()}`, clientSecret: SECRET });
  r = await http('POST', `/api/comments/accounts/${ya}/sync`, A);
  check('sync YouTube without a connection → 409 platform.not_connected', r.status === 409 && r.body.code === 'platform.not_connected', r.text);
  const conn = (accountId: string, platform: string, access: string, refresh: string | null, ext: string) => ({
    socialAccountId: accountId, userId: uA, platform, externalAccountId: ext, externalAccountName: `Fake ${platform}`, scopes: ['fake.scope'],
    accessTokenEnc: sealSecret(access), refreshTokenEnc: refresh ? sealSecret(refresh) : null, expiresAt: new Date(Date.now() + 3600_000), status: 'connected' as const, connectedBy: uA,
  });
  await db.insert(schema.platformConnections).values([conn(ya, 'youtube', FAKE.yt, FAKE.ytR, 'UCfake'), conn(ia, 'instagram', FAKE.ig, null, '17841400000000000')]);

  // ---------------------------------------------------------------- sync against the real platforms
  for (const [acc, name] of [[ya, 'YouTube'], [ia, 'Instagram']] as const) {
    r = await http('POST', `/api/comments/accounts/${acc}/sync`, A);
    check(`sync ${name} → 202 task-centre task comment-sync`, r.status === 202 && !!r.body.taskId, r.text);
    const again = await http('POST', `/api/comments/accounts/${acc}/sync`, A);
    check(`sync ${name} again while it runs → same task (created false) or a new one after it ended`,
      again.status === 202 && (again.body.taskId === r.body.taskId ? again.body.created === false : true), again.text);
    const task = await waitTask(r.body.taskId);
    check(`sync ${name}: the real API rejects the fake token → failed platform.auth_expired`, task.status === 'failed' && task.errorCode === 'platform.auth_expired', `${task.status} ${task.errorCode} ${task.error}`);
    if (again.body.taskId !== r.body.taskId) await waitTask(again.body.taskId);
    const [st] = await db.select().from(schema.commentSyncStates).where(eq(schema.commentSyncStates.accountId, acc));
    check(`sync ${name}: sync state records the error code`, st?.lastErrorCode === 'platform.auth_expired');
    const [cn] = await db.select().from(schema.platformConnections).where(eq(schema.platformConnections.socialAccountId, acc));
    check(`sync ${name}: connection marked expired`, cn?.status === 'expired');
  }
  r = await http('GET', '/api/comments/accounts', A);
  check('accounts: sync status (task failed + error code) shown, mode now manual (auth_expired)',
    accA(ya)?.sync?.task?.status === 'failed' && accA(ya)?.sync?.lastErrorCode === 'platform.auth_expired' && accA(ya)?.readReason === 'platform.auth_expired', JSON.stringify(accA(ya)));
  r = await http('GET', `/api/tasks?type=comment-sync`, A);
  check('user A sees the sync tasks in the task centre', r.status === 200 && r.body.tasks.filter((x: any) => [ya, ia].includes(x.refId)).length >= 2, r.text.slice(0, 200));

  // ---------------------------------------------------------------- manual comment entry
  const mc = async (token: string, accountId: string, i: number | string, extra: Record<string, unknown> = {}) =>
    http('POST', '/api/comments', token, { accountId, text: `comment ${i} ${tag}`, authorName: `Viewer ${i}`, authorHandle: `@viewer${i}`, externalPostId: 'vid-1', ...extra });
  r = await http('POST', '/api/comments', A, { accountId: ta, text: 'x' });
  check('manual entry without author → 400', r.status === 400);
  r = await mc(A, ta, 'bad', { postUrl: 'javascript:alert(1)' });
  check('manual entry with a non-http post URL → 400', r.status === 400);
  r = await mc(B, ta, 'b');
  check('user B: manual entry on A\'s account → 404', r.status === 404);
  // a published post of A's account with external id vid-1 (publish link)
  const [content] = await db.insert(schema.contents).values({ userId: uA, title: h('content') }).returning();
  contentIds.push(content!.id);
  const [pub] = await db.insert(schema.publishTasks).values({ userId: uA, contentId: content!.id, accountId: ta, platform: 'tiktok', status: 'published', externalId: 'vid-1', publishedAt: new Date() }).returning();
  const c: string[] = [];
  for (let i = 0; i < 12; i++) {
    const x = await mc(A, ta, i, i === 0 ? { externalId: 'tt-ext-0', postUrl: 'https://www.tiktok.com/@x/video/1' } : {});
    c.push(x.body.comment?.id);
  }
  check('A: 12 manual comments created (source manual, status new)', c.every(Boolean));
  const [c0] = await db.select().from(schema.comments).where(eq(schema.comments.id, c[0]!));
  check('manual comment: source manual, owner = account owner, linked to the published post', c0?.source === 'manual' && c0.userId === uA && c0.publishTaskId === pub!.id, JSON.stringify(c0));
  r = await mc(A, ta, 'dup', { externalId: 'tt-ext-0' });
  check('manual entry with an existing platform id → 409 comment.duplicate_external_id', r.status === 409 && r.body.code === 'comment.duplicate_external_id', r.text);
  r = await mc(A, ta, 'child', { parentId: c[0] });
  const child = r.body.comment?.id;
  check('manual reply-comment in a thread (parent external id set)', r.status === 201 && r.body.comment.parentExternalId === 'tt-ext-0', r.text);
  r = await mc(A, ta2, 'xparent', { parentId: c[0] });
  check('parent on another account → 400 comment.parent_not_found', r.status === 400 && r.body.code === 'comment.parent_not_found', r.text);
  const cr2: string[] = [];
  for (let i = 0; i < 4; i++) cr2.push((await mc(A, ta2, `r${i}`)).body.comment.id);
  const cb = (await mc(B, tb, 'b0')).body.comment.id as string;

  r = await http('GET', `/api/comments?accountId=${ta}&limit=50`, A);
  const root0 = r.body.items?.find((x: any) => x.id === c[0]);
  check('thread list: 12 top-level comments, the reply nested under its parent', r.status === 200 && r.body.total === 12 && root0?.children?.length === 1 && root0.children[0].id === child, r.text.slice(0, 300));
  check('thread list: published post linked (content title)', root0?.publishTask?.title === h('content'));
  r = await http('GET', `/api/comments?q=${encodeURIComponent(`comment child ${tag}`)}`, A);
  check('search matches the thread through a reply', r.status === 200 && r.body.items.length === 1 && r.body.items[0].id === c[0], r.text.slice(0, 200));
  r = await http('GET', '/api/comments?limit=200', B);
  check('user B: lists only own comments', r.status === 200 && r.body.items.length === 1 && r.body.items[0].id === cb);
  r = await http('GET', `/api/comments?ownerId=${uA}`, B);
  check('user B: ownerId filter of another user → 403', r.status === 403);
  r = await http('GET', `/api/comments?accountId=${ta}&limit=200`, T);
  check('admin: sees A\'s comments', r.status === 200 && r.body.total === 12);
  r = await http('GET', `/api/comments/${c[0]}`, B);
  check('user B: GET A\'s comment → 404', r.status === 404 && r.body.code === 'comment.not_found');
  r = await http('GET', `/api/comments/${c[0]}`, A);
  check('detail: thread (2 comments) + reply mode manual (TikTok)', r.status === 200 && r.body.thread.length === 2 && r.body.replyMode.mode === 'manual', r.text.slice(0, 300));
  r = await http('GET', `/api/comments/posts?accountId=${ta}`, A);
  check('posts filter: vid-1 with the content title', r.status === 200 && r.body.posts.some((p: any) => p.postId === 'vid-1' && p.title === h('content') && p.n === 13), r.text);
  r = await http('PATCH', `/api/comments/${c[11]}`, A, { status: 'hidden' });
  check('status → hidden (local only)', r.status === 200 && r.body.comment.status === 'hidden');
  r = await http('PATCH', `/api/comments/${c[11]}`, A, { status: 'replied' });
  check('status → replied by hand refused (400)', r.status === 400);
  r = await http('PATCH', `/api/comments/${c[11]}`, B, { status: 'read' });
  check('user B: PATCH A\'s comment → 404', r.status === 404);
  r = await http('GET', `/api/comments?accountId=${ta}&status=hidden`, A);
  check('status filter', r.status === 200 && r.body.total === 1 && r.body.items[0].id === c[11]);

  // ---------------------------------------------------------------- reply workflow (manual path)
  r = await http('POST', `/api/comment-replies`, A, { ids: c });
  check('no bulk "reply to all" endpoint (404)', r.status === 404);
  r = await http('POST', `/api/comments/${c[0]}/replies`, A, { text: '   ' });
  check('empty reply → 400 comment.text_empty', r.status === 400 && r.body.code === 'comment.text_empty', r.text);
  r = await http('POST', `/api/comments/${c[0]}/replies`, B, { text: 'hi' });
  check('user B: reply to A\'s comment → 404', r.status === 404);
  r = await http('POST', `/api/comments/${c[0]}/replies`, A, { text: `Thank you, Viewer 0! ${tag}`, submit: true });
  const r1 = r.body.reply?.id as string;
  check('A: reply submitted → pending_review (users need approval)', r.status === 201 && r.body.reply.status === 'pending_review' && r.body.reply.authorName === `cca${tag}`, r.text);
  r = await http('POST', `/api/comments/${c[0]}/replies`, A, { text: 'second reply' });
  check('second reply to the same comment → 409 comment.already_replied', r.status === 409 && r.body.code === 'comment.already_replied', r.text);
  r = await http('POST', `/api/comment-replies/${r1}/approve`, A);
  check('A approves own reply → 403 comment.self_approval', r.status === 403 && r.body.code === 'comment.self_approval', r.text);
  r = await http('POST', `/api/comment-replies/${r1}/approve`, B);
  check('user B: approve A\'s reply → 404', r.status === 404 && r.body.code === 'comment.reply_not_found');
  r = await http('GET', '/api/comment-replies?reviewable=true', A);
  check('review queue of A excludes own replies', r.status === 200 && !r.body.items.some((x: any) => x.id === r1));
  r = await http('GET', '/api/comment-replies?reviewable=true', T);
  check('admin review queue contains it (canReview)', r.status === 200 && r.body.items.some((x: any) => x.id === r1 && x.canReview));
  r = await http('PATCH', `/api/comment-replies/${r1}`, A, { text: `Thank you so much, Viewer 0! ${tag}` });
  check('author edits while pending review', r.status === 200 && r.body.reply.text.startsWith('Thank you so much'));
  r = await http('POST', `/api/comment-replies/${r1}/approve`, T, { note: 'ok' });
  check('admin approves → queued for sending', r.status === 200 && ['approved', 'scheduled', 'sending', 'awaiting_operator'].includes(r.body.reply.status) && r.body.reply.reviewerName === process.env.ADMIN_USERNAME, r.text);
  let row = await waitReply(r1, ['awaiting_operator', 'failed']);
  check('TikTok reply → awaiting_operator (manual method)', row.status === 'awaiting_operator' && row.method === 'manual' && !!row.handedAt, `${row.status} ${row.errorCode}`);
  const t1 = await taskRow(row.taskId!);
  check('reply job: task-centre task comment-reply, key comment-reply:<id>:1, success, owner = A',
    t1.type === 'comment-reply' && t1.idempotencyKey === `comment-reply:${r1}:1` && t1.status === 'success' && t1.createdBy === uA, JSON.stringify({ k: t1.idempotencyKey, s: t1.status }));
  const dupTask = await createTask({ type: 'comment-reply', userId: uA, refType: 'comment_reply', refId: r1, payload: { commentTaskId: r1, round: 1 }, idempotencyKey: `comment-reply:${r1}:1` });
  check('idempotency: creating the reply job again with the same key returns the same task', dupTask.created === false && dupTask.task.id === t1.id);
  r = await http('POST', `/api/comment-replies/${r1}/approve`, T);
  check('approve again → 409 comment.bad_status', r.status === 409 && r.body.code === 'comment.bad_status');
  r = await http('GET', `/api/comment-replies/${r1}`, A);
  check('reply detail: device link info + logs + runs', r.status === 200 && r.body.runs.length === 1 && r.body.logs.some((l: any) => l.action === 'handed_over'), r.text.slice(0, 300));
  r = await http('POST', `/api/comment-replies/${r1}/outcome`, A, { result: 'failed' });
  check('outcome failed without a reason → 400', r.status === 400 && r.body.code === 'comment.outcome_needs_reason');
  r = await http('POST', `/api/comment-replies/${r1}/outcome`, B, { result: 'sent' });
  check('user B: record outcome on A\'s reply → 404', r.status === 404);
  r = await http('POST', `/api/comment-replies/${r1}/outcome`, A, { result: 'sent' });
  check('operator records sent → sent (sender recorded), comment replied', r.status === 200 && r.body.reply.status === 'sent' && r.body.reply.senderName === `cca${tag}` && r.body.reply.comment.status === 'replied', r.text);
  r = await http('POST', `/api/comments/${c[0]}/replies`, A, { text: 'one more' });
  check('after a sent reply: another reply → 409 comment.already_replied', r.status === 409 && r.body.code === 'comment.already_replied');
  r = await http('PATCH', `/api/comment-replies/${r1}`, A, { text: 'changed' });
  check('edit a sent reply → 409', r.status === 409);

  // failed → new reply allowed; cancelled → new reply allowed
  r = await http('POST', `/api/comments/${c[1]}/replies`, A, { text: `Reply one ${tag}`, submit: true });
  const r2 = r.body.reply.id as string;
  await http('POST', `/api/comment-replies/${r2}/approve`, T);
  await waitReply(r2, ['awaiting_operator']);
  r = await http('POST', `/api/comment-replies/${r2}/outcome`, A, { result: 'failed', reason: 'comments are closed on this video' });
  check('operator records failed (reason kept)', r.status === 200 && r.body.reply.status === 'failed' && r.body.reply.errorCode === 'comment.operator_failed' && r.body.reply.error === 'comments are closed on this video');
  r = await http('POST', `/api/comments/${c[1]}/replies`, A, { text: `Reply two ${tag}` });
  const r3 = r.body.reply?.id as string;
  check('after failure: a new reply is allowed (draft)', r.status === 201 && r.body.reply.status === 'draft');
  r = await http('PATCH', `/api/comment-replies/${r3}`, A, { text: `Reply two, edited ${tag}` });
  check('edit draft', r.status === 200 && r.body.reply.text === `Reply two, edited ${tag}`);
  r = await http('POST', `/api/comment-replies/${r3}/cancel`, B);
  check('user B: cancel A\'s reply → 404', r.status === 404);
  r = await http('POST', `/api/comment-replies/${r3}/cancel`, A);
  check('cancel draft → cancelled', r.status === 200 && r.body.reply.status === 'cancelled');
  r = await http('POST', `/api/comments/${c[1]}/replies`, A, { text: `Reply three ${tag}` });
  check('after cancel: a new reply is allowed', r.status === 201);

  // reject (reason required) → new reply allowed
  r = await http('POST', `/api/comments/${c[2]}/replies`, A, { text: `Check my profile ${tag}`, submit: true });
  const r4 = r.body.reply.id as string;
  r = await http('POST', `/api/comment-replies/${r4}/reject`, T, { reason: '' });
  check('reject without a reason → 400', r.status === 400);
  r = await http('POST', `/api/comment-replies/${r4}/reject`, T, { reason: 'self-promotion' });
  check('admin rejects with a reason', r.status === 200 && r.body.reply.status === 'rejected' && r.body.reply.reviewNote === 'self-promotion');
  r = await http('POST', `/api/comment-replies/${r4}/submit`, A);
  check('rejected reply cannot be resubmitted (409)', r.status === 409);
  r = await http('POST', `/api/comments/${c[2]}/replies`, A, { text: `Thanks for the feedback ${tag}` });
  check('after rejection: a new reply is allowed', r.status === 201);
  await http('POST', `/api/comment-replies/${r.body.reply.id}/cancel`, A);

  // ---------------------------------------------------------------- duplicate text
  const same = `Thanks for watching! ${tag}`;
  const dupIds: string[] = [];
  for (const i of [3, 4, 5]) {
    r = await http('POST', `/api/comments/${c[i]}/replies`, A, { text: same, submit: true });
    dupIds.push(r.body.reply?.id);
  }
  check('same text on 3 comments → allowed (limit 3 / 24 h)', dupIds.every(Boolean));
  r = await http('POST', `/api/comments/${c[6]}/replies`, A, { text: same, submit: true });
  const blockedDraft = r.body?.reply?.id;
  check('4th identical reply → 409 comment.duplicate_text', r.status === 409 && r.body.code === 'comment.duplicate_text' && r.body.params?.max === 3, r.text);
  const [d6] = await db.select().from(schema.commentTasks).where(eq(schema.commentTasks.commentId, c[6]!));
  check('blocked submit leaves the reply as a draft to rewrite', !blockedDraft && d6?.status === 'draft');
  r = await http('POST', `/api/comment-replies/${d6!.id}/submit`, A);
  check('submitting the same text again stays blocked', r.status === 409 && r.body.code === 'comment.duplicate_text');
  r = await http('PATCH', `/api/comment-replies/${d6!.id}`, A, { text: `  THANKS   for watching!  ${tag} ` });
  r = await http('POST', `/api/comment-replies/${d6!.id}/submit`, A);
  check('case / whitespace variant of the same text → still blocked', r.status === 409 && r.body.code === 'comment.duplicate_text');
  r = await http('PATCH', `/api/comment-replies/${d6!.id}`, A, { text: `Glad you liked the part about lighting ${tag}` });
  r = await http('POST', `/api/comment-replies/${d6!.id}/submit`, A);
  check('individually written text → submitted', r.status === 200 && r.body.reply.status === 'pending_review');
  r = await http('POST', `/api/comments/${c[7]}/replies`, B, { text: same, submit: true });
  check('(B cannot even reach A\'s comment: 404)', r.status === 404);

  // ---------------------------------------------------------------- batch approval
  r = await http('POST', '/api/comment-replies/approve', T, { ids: [dupIds[0], dupIds[1], r1] });
  check('batch approve: each checked individually (2 ok, sent one refused bad_status)',
    r.status === 200 && r.body.results.filter((x: any) => x.ok).length === 2 && r.body.results.find((x: any) => x.id === r1)?.code === 'comment.bad_status', r.text);
  r = await http('POST', '/api/comment-replies/approve', A, { ids: [dupIds[2]!] });
  check('batch approve by the author: refused per item (comment.self_approval)', r.status === 200 && r.body.results[0].ok === false && r.body.results[0].code === 'comment.self_approval', r.text);
  for (const id of dupIds.slice(0, 2)) await waitReply(id!, ['awaiting_operator']);

  // ---------------------------------------------------------------- scheduled send + cancel
  const later = new Date(Date.now() + 3600_000).toISOString();
  r = await http('POST', `/api/comments/${c[8]}/replies`, A, { text: `See you tomorrow ${tag}`, submit: true, scheduledAt: later });
  const r8 = r.body.reply.id as string;
  r = await http('POST', `/api/comment-replies/${r8}/approve`, T);
  check('approved with a send time → scheduled', r.status === 200 && r.body.reply.status === 'scheduled', r.text);
  const t8 = await taskRow(r.body.reply.taskId);
  check('scheduled task-centre task with run_at', t8.status === 'scheduled' && !!t8.runAt);
  r = await http('POST', `/api/comment-replies/${r8}/cancel`, A);
  check('cancel scheduled reply → cancelled, its task cancelled', r.status === 200 && r.body.reply.status === 'cancelled' && (await taskRow(t8.id)).status === 'cancelled');

  // ---------------------------------------------------------------- send rate limit (deferred, not dropped)
  r = await http('PUT', '/api/comments/settings', T, { sendsPerHour: 2 });
  const rl: string[] = [];
  for (let i = 0; i < 3; i++) {
    r = await http('POST', `/api/comments/${cr2[i]}/replies`, T, { text: `Admin reply ${i} ${tag}`, submit: true });
    check(`admin reply ${i}: approved without review (admin)`, r.status === 201 && r.body.reply.reviewerName === process.env.ADMIN_USERNAME && r.body.reply.status !== 'pending_review', r.text);
    rl.push(r.body.reply.id);
    if (i < 2) await waitReply(r.body.reply.id, ['awaiting_operator']);
  }
  row = await waitFor('deferred', async () => { const x = await replyRow(rl[2]!); return x.round === 2 ? x : null; });
  check('3rd send in the hour (limit 2) → deferred: scheduled, round 2, ~1 h later',
    row.status === 'scheduled' && !!row.scheduledAt && row.scheduledAt.getTime() > Date.now() + 50 * 60_000, `${row.status} ${row.scheduledAt?.toISOString()}`);
  const next = await taskRow(row.taskId!);
  check('deferred round has a new scheduled task (key comment-reply:<id>:2)', next.status === 'scheduled' && next.idempotencyKey === `comment-reply:${rl[2]}:2`);
  r = await http('POST', `/api/comment-replies/${rl[2]}/cancel`, T);
  check('cancel the deferred reply', r.status === 200 && r.body.reply.status === 'cancelled' && (await taskRow(next.id)).status === 'cancelled');
  await http('PUT', '/api/comments/settings', T, { sendsPerHour: 20 });

  // ---------------------------------------------------------------- API reply path (real YouTube, fake token)
  const [apiC] = await db.insert(schema.comments).values({
    userId: uA, accountId: ya, platform: 'youtube', source: 'api', externalId: `Ugz${tag}fakecommentid`, externalPostId: `vid${tag}`, authorName: 'YT Viewer', text: `nice video ${tag}`,
    publishedAt: new Date(),
  }).returning();
  await db.update(schema.platformConnections).set({ status: 'connected', lastError: null, lastErrorCode: null }).where(eq(schema.platformConnections.socialAccountId, ya));
  r = await http('GET', `/api/comments/${apiC!.id}`, A);
  check('API comment with a connected YouTube account → reply mode api', r.status === 200 && r.body.replyMode.mode === 'api', JSON.stringify(r.body?.replyMode));
  r = await http('POST', `/api/comments/${apiC!.id}/replies`, A, { text: `Thanks a lot ${tag}`, submit: true });
  const ry = r.body.reply.id as string;
  await http('POST', `/api/comment-replies/${ry}/approve`, T);
  row = await waitReply(ry, ['failed', 'sent', 'awaiting_operator']);
  check('reply via the real YouTube API with a fake token → failed platform.auth_expired', row.status === 'failed' && row.method === 'api' && row.errorCode === 'platform.auth_expired', `${row.status} ${row.errorCode} ${row.error}`);
  const ty = await waitTask(row.taskId!);
  check('reply task failed after 1 attempt (auth errors are not retried) with the platform code', ty.status === 'failed' && ty.attempts === 1 && ty.errorCode === 'platform.auth_expired', `${ty.status} ${ty.attempts} ${ty.errorCode}`);
  r = await http('GET', `/api/comments/${apiC!.id}`, A);
  check('after auth failure: reply mode falls back to manual (platform.auth_expired)', r.body.replyMode.mode === 'manual' && r.body.replyMode.reason === 'platform.auth_expired');
  r = await http('POST', `/api/comments/${apiC!.id}/replies`, A, { text: `Thanks a lot (retry) ${tag}` });
  check('after an API failure a new reply may be written', r.status === 201);
  r = await http('DELETE', `/api/comments/${apiC!.id}`, A);
  check('delete an API comment → 409 comment.not_manual (hide instead)', r.status === 409 && r.body.code === 'comment.not_manual');

  // ---------------------------------------------------------------- templates
  r = await http('POST', '/api/comment-templates', A, { name: 'Thanks', text: 'Thanks for watching, {name}!' });
  const tplA = r.body.template?.id as string;
  check('A: private template', r.status === 201 && r.body.template.shared === false);
  r = await http('POST', '/api/comment-templates', A, { name: 'Shared', text: 'x', shared: true });
  check('A: shared template → 403', r.status === 403 && r.body.code === 'comment.admin_only');
  r = await http('POST', '/api/comment-templates', T, { name: h('shared'), text: 'Thanks for your comment!', shared: true });
  sharedTemplates.push(r.body.template?.id);
  check('admin: shared template', r.status === 201 && r.body.template.shared === true);
  r = await http('GET', '/api/comment-templates', B);
  check('B: sees shared, not A\'s private template', r.status === 200 && r.body.templates.some((x: any) => x.id === sharedTemplates[0] && !x.writable) && !r.body.templates.some((x: any) => x.id === tplA));
  r = await http('PUT', `/api/comment-templates/${tplA}`, B, { name: 'x' });
  check('B: update A\'s template → 404', r.status === 404);
  r = await http('PUT', `/api/comment-templates/${sharedTemplates[0]}`, B, { name: 'x' });
  check('B: update shared template → 403', r.status === 403);
  r = await http('POST', `/api/comments/${cb}/replies`, B, { text: 'hello', templateId: tplA });
  check('B: reply with A\'s template id → 404', r.status === 404 && r.body.code === 'comment.template_not_found');
  r = await http('POST', `/api/comments/${c[9]}/replies`, A, { text: 'Thanks for watching, Viewer 9! (edited)', templateId: tplA });
  check('A: reply started from a template (edited by a person)', r.status === 201 && r.body.reply.templateId === tplA);
  r = await http('DELETE', `/api/comment-templates/${tplA}`, A);
  check('A: delete own template', r.status === 204);

  // ---------------------------------------------------------------- RBAC on replies / history
  r = await http('GET', `/api/comment-replies/${r1}`, B);
  check('B: GET A\'s reply → 404', r.status === 404);
  r = await http('GET', '/api/comment-replies?limit=200', B);
  check('B: reply history has none of A\'s', r.status === 200 && r.body.items.length === 0);
  r = await http('GET', `/api/comment-replies?status=sent,failed&accountId=${ta}`, A);
  check('A: sent/failed history with author, reviewer, sender and failure reason',
    r.status === 200 && r.body.items.some((x: any) => x.id === r1 && x.authorName && x.reviewerName && x.senderName) && r.body.items.some((x: any) => x.id === r2 && x.error), r.text.slice(0, 300));
  r = await http('DELETE', `/api/comments/${c[10]}`, B);
  check('B: delete A\'s comment → 404', r.status === 404);
  r = await http('DELETE', `/api/comments/${c[10]}`, A);
  check('A: delete manual comment → 204', r.status === 204);

  // ---------------------------------------------------------------- logs, leaks, audit
  const logs = await db.select().from(schema.commentLogs).where(inArray(schema.commentLogs.accountId, [ya, ia, ta, ta2]));
  const codes = new Set(logs.filter((l) => l.action === 'blocked').map((l) => l.code));
  const want = ['comment.already_replied', 'comment.self_approval', 'comment.duplicate_text', 'comment.rate_limited'];
  check('every block logged with its reason code', want.every((x) => codes.has(x)), [...codes].join(','));
  const r1Logs = logs.filter((l) => l.commentTaskId === r1).map((l) => l.action);
  check('reply log: created → submitted → blocked (self-approval) → edited → approved → queued → run → handed_over → sent',
    ['created', 'submitted', 'blocked', 'edited', 'approved', 'queued', 'run', 'handed_over', 'sent'].every((a) => r1Logs.includes(a)), r1Logs.join(','));
  const taskRows = await db.select().from(schema.tasks).where(and(inArray(schema.tasks.type, ['comment-sync', 'comment-reply']), gte(schema.tasks.createdAt, t0)));
  const taskLogRows = taskRows.length ? await db.select().from(schema.taskLogs).where(inArray(schema.taskLogs.taskId, taskRows.map((t) => t.id))) : [];
  const syncStates = await db.select().from(schema.commentSyncStates).where(inArray(schema.commentSyncStates.accountId, [ya, ia]));
  const replies = await db.select().from(schema.commentTasks).where(inArray(schema.commentTasks.accountId, [ya, ia, ta, ta2]));
  check('no token or client secret in tasks, task logs, comment logs, sync states or replies',
    !leaks(JSON.stringify([taskRows, taskLogRows, logs, syncStates, replies])).length);
  check('task payloads carry only ids', taskRows.every((t) => Object.keys(t.payload ?? {}).every((k) => ['socialAccountId', 'commentTaskId', 'round'].includes(k))));
  await new Promise((res) => setTimeout(res, 500));
  const audits = await db.select().from(schema.auditLogs).where(gte(schema.auditLogs.at, t0));
  const acts = new Set(audits.map((a) => a.action));
  const wantA = ['comment.rules_update', 'comment.sync', 'comment.manual_create', 'comment.status', 'comment.delete', 'comment.reply_create', 'comment.reply_update',
    'comment.reply_submit', 'comment.reply_approve', 'comment.reply_approve_batch', 'comment.reply_reject', 'comment.reply_cancel', 'comment.reply_outcome_sent',
    'comment.reply_outcome_failed', 'comment.template_create', 'comment.template_update', 'comment.template_delete'];
  check('audit actions recorded', wantA.every((x) => acts.has(x)), wantA.filter((x) => !acts.has(x)).join(','));
  check('audit: refused self-approval recorded with 403', audits.some((a) => a.action === 'comment.reply_approve' && a.status === 403 && a.userId === uA));
  check('audit: reply target is "platform @handle → author"', audits.some((a) => a.action === 'comment.reply_approve' && a.target === `tiktok @${h('ta')} → Viewer 0`), audits.filter((a) => a.action === 'comment.reply_approve').map((a) => a.target).join('|'));
  check('audit never stores reply texts, tokens or the secret', !audits.some((a) => JSON.stringify(a.detail).includes(same) || JSON.stringify(a.detail).includes('Thank you')) && !leaks(JSON.stringify(audits)).length);
} catch (err) {
  check(`unexpected error: ${(err as Error).stack}`, false);
} finally {
  for (const id of sharedTemplates.filter(Boolean)) await db.delete(schema.commentTemplates).where(eq(schema.commentTemplates.id, id));
  // cancel anything still waiting so no job runs after the rows are gone
  const open = await db.select().from(schema.tasks).where(and(inArray(schema.tasks.type, ['comment-sync', 'comment-reply']), inArray(schema.tasks.status, ['pending', 'scheduled']), gte(schema.tasks.createdAt, t0)));
  for (const t of open) await http('POST', `/api/tasks/${t.id}/cancel`, T);
  for (const id of userIds) await http('DELETE', `/api/users/${id}`, T);
  await db.delete(schema.socialAccounts).where(like(schema.socialAccounts.handle, `cc_${tag}_%`));
  if (contentIds.length) await db.delete(schema.contents).where(inArray(schema.contents.id, contentIds));
  for (const [key, before] of [['comments.rules', rulesBefore], ['platform.apps', appsBefore]] as const) {
    if (before) await db.insert(schema.settings).values({ key, value: before.value }).onConflictDoUpdate({ target: schema.settings.key, set: { value: before.value } });
    else await db.delete(schema.settings).where(eq(schema.settings.key, key));
  }
  const left = await db.select().from(schema.socialAccounts).where(like(schema.socialAccounts.handle, `cc_${tag}_%`));
  const leftC = userIds.length ? await db.select().from(schema.comments).where(inArray(schema.comments.userId, userIds)) : [];
  check('cleanup: users, accounts, comments, replies, templates removed', left.length === 0 && leftC.length === 0);
  await closeTaskQueues();
  await sqlClient.end();
  const failed = results.filter((x) => !x[1]).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}
