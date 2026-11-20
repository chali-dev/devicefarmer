/**
 * 运营只能看到自己的媒体号: an operator (role user) never sees another user's social accounts, anywhere.
 * Real API + DB, no mocks. Two temporary users A and B (+ the built-in admin), placeholder `instances` rows
 * (adb ports 5598–5599, no containers). User A is granted device D1, which hosts one of B's accounts.
 * Seeds for both users: accounts (tag, personal persona), media + content with targets, scheduled
 * publish tasks (plus an admin distribution of A's content to B's account), seeded analytics stats,
 * manual comments + a reply (submitted by B → B's comment-reply task; no approval step) and an account.problem notification
 * (as raised by the automatic account check: statuses written + the real trigger called).
 * Then, as A: every list/detail/filter/count/action endpoint must never contain B's account ids, handles,
 * display name, tag or persona, others' rows are 404 and ownerId filters are ignored or 403;
 * A's /api/events WebSocket must not carry B's account events. The admin sees both.
 * Usage (from apps/api, API running): npx tsx --env-file=../../.env scripts/account-visibility-check.ts
 * (E2E_API=http://127.0.0.1:<port> for another API).
 */
import { randomBytes } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import sharp from 'sharp';
import { db, schema, sqlClient } from '../src/db/index.js';
import { seedStatsDay } from './lib/analytics-seed.js';
import { accountChecked } from '../src/modules/notify/triggers.js';
import { withCaptcha } from './lib/login.js';
import { linkAccount } from './lib/social-link.js';
import { applySync } from '../src/modules/social/sync.js';
import { placeholders } from './lib/placeholder.js';

const ph = placeholders('avfake');

const API = process.env.E2E_API ?? `http://127.0.0.1:${process.env.API_PORT ?? 3000}`;
const results: [string, boolean][] = [];
const check = (name: string, ok: boolean, detail = '') => { results.push([name, ok]); console.log(`${ok ? '✓' : '✗'} ${name}${detail && !ok ? ` — ${detail.slice(0, 400)}` : ''}`); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function http<T = any>(method: string, path: string, token?: string, body?: unknown) {
  const form = body instanceof FormData;
  const res = await fetch(API + path, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined && !form ? { 'content-type': 'application/json' } : {}) },
    body: body === undefined ? undefined : form ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* 204 */ }
  return { status: res.status, body: json as T, text };
}
async function login(username: string, password: string): Promise<string> {
  const r = await http('POST', '/api/auth/login', undefined, await withCaptcha(API, { username, password }));
  if (!r.body?.token) throw new Error(`login ${username} failed: ${r.status}`);
  return r.body.token;
}
async function waitFor<T>(label: string, fn: () => Promise<T | null | false | undefined>, ms = 60_000): Promise<T> {
  const t0 = Date.now();
  for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() - t0 > ms) throw new Error(`timeout: ${label}`); await sleep(500); }
}
async function upload(token: string, name: string, r: number): Promise<string> {
  const data = await sharp({ create: { width: 360, height: 640, channels: 3, background: { r, g: 120, b: 80 } } }).jpeg().toBuffer();
  const fd = new FormData();
  fd.append('scope', 'mine');
  fd.append('file', new Blob([new Uint8Array(data)], { type: 'image/jpeg' }), name);
  const res = await http('POST', '/api/media/upload', token, fd);
  if (res.status !== 201) throw new Error(`upload failed ${res.status} ${res.text}`);
  const id: string = res.body.item.id;
  await waitFor(`media ${name} ready`, async () => (await http('GET', `/api/media/${id}`, token)).body.item.status === 'ready', 120_000);
  return id;
}

const T = await login(process.env.ADMIN_USERNAME!, process.env.ADMIN_PASSWORD!);
const tag = randomBytes(3).toString('hex');
const userIds: string[] = [];
const fakeIds: string[] = [];
const wsMessages: string[] = [];
let ws: WebSocket | null = null;

try {
  // ---------------------------------------------------------------- setup
  const pw = randomBytes(12).toString('base64url');
  for (const n of ['a', 'b']) {
    const r = await http('POST', '/api/users', T, { username: `av${n}${tag}`, password: pw, role: 'user' });
    if (r.status !== 201) throw new Error(`create user: ${r.status} ${r.text}`);
    userIds.push(r.body.user.id);
  }
  const [uA, uB] = userIds as [string, string];
  const A = await login(`ava${tag}`, pw);
  const B = await login(`avb${tag}`, pw);
  const fakes = await ph.insert([1, 2].map((n) => ({
    name: `avfake-${tag}-${n}`, adbPort: 5597 + n, status: 'stopped' as const,
  })));
  fakeIds.push(...fakes.map((f) => f.id));
  const [D1, D2] = fakes as [typeof fakes[0], typeof fakes[0]];
  await http('PUT', `/api/users/${uA}/grants`, T, { instanceIds: [D1.id] });
  await http('PUT', `/api/users/${uB}/grants`, T, { instanceIds: [D2.id] });

  // A's /api/events WebSocket, open before B does anything.
  ws = new WebSocket(`${API.replace(/^http/, 'ws')}/api/events`);
  await new Promise<void>((resolve, reject) => {
    ws!.onopen = () => ws!.send(JSON.stringify({ type: 'auth', token: A }));
    ws!.onmessage = (ev) => { const s = String(ev.data); wsMessages.push(s); if (s.includes('"ready"')) resolve(); };
    ws!.onerror = () => reject(new Error('ws error'));
    setTimeout(() => reject(new Error('ws ready timeout')), 10_000);
  });

  // Per user: personal persona, instagram account (B's on D1, A's unlinked), media, content with target.
  const seed = async (who: 'a' | 'b', token: string) => {
    const p = await http('POST', '/api/personas', token, { scope: 'mine', name: `av${who}persona${tag}` });
    const acc = await http('POST', '/api/social/accounts', token, {
      platform: 'instagram', handle: `av${who}_${tag}_main`, displayName: `AV${who.toUpperCase()}Display${tag}`, notes: `av${who}notes${tag}`,
      personaId: p.body.persona.id, tags: [`av${who}tag${tag}`],
    });
    if (acc.status !== 201) throw new Error(`account ${who}: ${acc.status} ${acc.text}`);
    const media = await upload(token, `av${who}.jpg`, who === 'a' ? 30 : 200);
    const c = await http('POST', '/api/contents', token, { title: `av${who}content${tag}`, body: 'Body', mediaIds: [media], targetIds: [acc.body.account.id] });
    if (c.status !== 201) throw new Error(`content ${who}: ${c.status} ${c.text}`);
    return { persona: p.body.persona.id as string, account: acc.body.account.id as string, content: c.body.content.id as string };
  };
  const a = await seed('a', A);
  const b = await seed('b', B);
  // The device link is read only in the API (set by 从云手机同步); written here with the sync's rules (lib/social-link.ts).
  await linkAccount(b.account, D1.id);
  let r = await http('GET', `/api/social/accounts/${b.account}`, T);
  check('setup: B\'s account linked to D1 (A has a grant on D1, B none)', r.status === 200 && r.body.account.instance?.id === D1.id, r.text);

  const later = new Date(Date.now() + 2 * 86400_000).toISOString();
  const dA = await http('POST', `/api/contents/${a.content}/distribute`, A, { targets: [{ accountId: a.account, scheduledAt: later }] });
  const dB = await http('POST', `/api/contents/${b.content}/distribute`, B, { targets: [{ accountId: b.account, scheduledAt: later }] });
  // Admin distributes A's content to B's account (allowed for admins): the task belongs to B.
  const dX = await http('POST', `/api/contents/${a.content}/distribute`, T, { targets: [{ accountId: b.account, scheduledAt: later }] });
  check('setup: scheduled publish tasks (A, B, admin: A\'s content → B\'s account)', dA.status === 201 && dB.status === 201 && dX.status === 201, `${dA.text} ${dB.text} ${dX.text}`);
  const ptB: string = dB.body.created[0].id;
  const ptX: string = dX.body.created[0].id;
  const publishIds = [dA.body.created[0].id, ptB, ptX];

  const today = new Date().toISOString().slice(0, 10);
  // The API cannot write analytics any more (no data source): historical rows are seeded directly.
  const sa = await seedStatsDay(a.account, today, { followers: 100, posts: 3 });
  const sb = await seedStatsDay(b.account, today, { followers: 777, posts: 9 });
  check('setup: analytics stats rows for A and B (seeded)', !!sa.id && !!sb.id);

  const cmA = await http('POST', '/api/comments', A, { accountId: a.account, text: `ava comment ${tag}`, authorName: 'Viewer A', externalPostId: 'post-a' });
  const cmB = await http('POST', '/api/comments', B, { accountId: b.account, text: `avb comment ${tag}`, authorName: 'Viewer B', externalPostId: `avbpost${tag}` });
  const rpB = await http('POST', `/api/comments/${cmB.body.comment?.id}/replies`, B, { text: `avb reply ${tag}` });
  check('setup: manual comments (A, B) + B\'s reply draft', cmA.status === 201 && cmB.status === 201 && rpB.status === 201, cmA.text + cmB.text + rpB.text);
  const commentB: string = cmB.body.comment.id;
  const replyB: string = rpB.body.reply.id;

  // B: a comment-reply task (B submits the reply → handed to an operator, no approval) + an account.problem alert
  // (what the automatic account check does on a logged-out phone: status written, real trigger called).
  // 排程 needs the phone's grant (2026-11-19, social.device_not_granted): B holds D1 for the submit only (a legacy
  // shared row written in the DB), removed again once the task finished, so A is the phone's only user afterwards.
  await db.insert(schema.instanceGrants).values({ userId: uB, instanceId: D1.id });
  r = await http('POST', `/api/comment-replies/${replyB}/submit`, B, {});
  const taskB: string = r.body?.reply?.taskId;
  check('setup: B submits the reply → scheduled, B\'s comment-reply task', r.status === 200 && r.body.reply?.status === 'scheduled' && !!taskB, r.text.slice(0, 200));
  await waitFor('B reply task finished', async () => ['success', 'failed'].includes((await http('GET', `/api/tasks/${taskB}`, B)).body?.task?.status));
  await db.delete(schema.instanceGrants).where(and(eq(schema.instanceGrants.userId, uB), eq(schema.instanceGrants.instanceId, D1.id)));
  const [bRow] = await db.update(schema.socialAccounts).set({ loginStatus: 'logged_out', lastCheckCode: 'logged_out' }).where(eq(schema.socialAccounts.id, b.account)).returning();
  await accountChecked(bRow!);
  check('setup: B\'s account checked as logged out (account.problem)', bRow?.loginStatus === 'logged_out');
  await waitFor('B notification', async () => ((await http('GET', '/api/notifications', B)).body?.items ?? (await http('GET', '/api/notifications', B)).body?.notifications ?? [])
    .some((n: any) => n.kind === 'account.problem'), 15_000).catch(() => undefined);
  await sleep(1500); // let pending events reach the WebSocket

  // ---------------------------------------------------------------- what must never reach A
  const bTokens = [b.account, b.persona, `avb_${tag}_main`, `AVBDisplay${tag}`, `avbpersona${tag}`, `avbtag${tag}`, `avbnotes${tag}`,
    ptB, ptX, commentB, replyB, taskB, `avb comment ${tag}`, `avb reply ${tag}`, `avbpost${tag}`];
  const leaks = (text: string) => bTokens.filter((t) => text.toLowerCase().includes(t.toLowerCase()));
  const clean = async (label: string, path: string, expect = 200, token = A) => {
    const res = await http('GET', path, token);
    const l = leaks(res.text);
    check(`A: GET ${label} → ${expect}, no B data`, res.status === expect && !l.length, `${res.status} leaks=${l.join(',')} ${res.text.slice(0, 200)}`);
    return res;
  };

  // social accounts
  r = await clean('/api/social/accounts', '/api/social/accounts?pageSize=200');
  check('A: account list = exactly A\'s account', r.body.total === 1 && r.body.items[0]?.id === a.account, r.text.slice(0, 300));
  r = await clean('/api/social/accounts?ownerId=<B> (ignored for users)', `/api/social/accounts?ownerId=${uB}`);
  check('A: ownerId=<B> still returns only A\'s account', r.body.items.every((x: any) => x.userId === uA));
  r = await clean('/api/social/accounts?instanceId=<D1> (granted device hosting B\'s account)', `/api/social/accounts?instanceId=${D1.id}`);
  check('A: D1\'s account list is empty for A', r.body.total === 0);
  for (const q of [`q=avb_${tag}`, `personaId=${b.persona}`, `tags=avbtag${tag}`, 'loginStatus=logged_out', 'exception=true']) {
    r = await clean(`/api/social/accounts?${q.split('=')[0]}=…`, `/api/social/accounts?${q}`);
    check(`A: filter ${q.split('=')[0]} matching only B's account → 0`, r.body.total === 0, r.text.slice(0, 200));
  }
  await clean('/api/social/tags', '/api/social/tags');
  await clean('/api/social/tags?ownerId=<B>', `/api/social/tags?ownerId=${uB}`);
  r = await clean('/api/personas?scope=mine&ownerId=<B>', `/api/personas?scope=mine&ownerId=${uB}`);
  check('A: personal personas = only A\'s, counting A\'s account', r.body.personas.length === 1 && r.body.personas[0].id === a.persona && r.body.personas[0].accounts === 1, r.text.slice(0, 300));
  await clean('/api/personas?scope=all-users (admin only)', '/api/personas?scope=all-users', 403);
  // a public persona on both accounts: its account count is per viewer (A: own only; admin: both)
  const pubP = (await http('POST', '/api/personas', T, { scope: 'public', name: `avpub${tag}` })).body.persona.id as string;
  await http('PUT', `/api/social/accounts/${a.account}`, A, { personaId: pubP });
  await http('PUT', `/api/social/accounts/${b.account}`, B, { personaId: pubP });
  const pubCount = async (token: string) => ((await http('GET', '/api/personas?scope=public', token)).body.personas as any[]).find((x) => x.id === pubP)?.accounts;
  check('public persona account count per viewer (A 1, admin 2)', (await pubCount(A)) === 1 && (await pubCount(T)) === 2);
  await http('PUT', `/api/social/accounts/${a.account}`, A, { personaId: a.persona });
  await http('PUT', `/api/social/accounts/${b.account}`, B, { personaId: b.persona });
  await http('DELETE', `/api/personas/${pubP}`, T);
  await clean('/api/social/accounts/<B>', `/api/social/accounts/${b.account}`, 404);
  await clean('/api/social/accounts/<B>/logs', `/api/social/accounts/${b.account}/logs`, 404);
  const deny = async (label: string, method: string, path: string, body?: unknown, codes = [404]) => {
    const res = await http(method, path, A, body);
    check(`A: ${label} → ${codes.join('/')}`, codes.includes(res.status) && !leaks(res.text).length, `${res.status} ${res.text.slice(0, 200)}`);
  };
  await deny('PUT B\'s account', 'PUT', `/api/social/accounts/${b.account}`, { notes: 'x' });
  await deny('立即检测 on B\'s account', 'POST', `/api/social/accounts/${b.account}/check`);
  await deny('batch with B\'s account', 'POST', '/api/social/accounts/batch', { ids: [a.account, b.account], action: 'add-tags', tags: ['x'] });
  await deny('rename B\'s persona', 'PATCH', `/api/personas/${b.persona}`, { name: 'x' });
  await deny('set B\'s personal persona on own account', 'PUT', `/api/social/accounts/${a.account}`, { personaId: b.persona }, [400, 404]);
  await deny('DELETE B\'s account', 'DELETE', `/api/social/accounts/${b.account}`);
  // A second instagram account of A on D1: refused by the per-device limit, which counts B's account (open question, see report).
  // 从云手机同步 of a 2nd instagram account of A on D1 (DB part of the sync; the phone read is covered elsewhere).
  const [d1Row] = await db.select().from(schema.instances).where(eq(schema.instances.id, D1.id));
  const so = await applySync({ inst: d1Row!, ownerId: uA, actor: null, handle: `ava_${tag}_second`, displayName: null, deviceIds: [] });
  check('A: sync on D1 hits the device limit (counts B\'s account) without B\'s handle', so.result === 'limit_reached' && !leaks(JSON.stringify(so)).length, JSON.stringify(so));
  const st = await applySync({ inst: d1Row!, ownerId: uA, actor: null, handle: `avb_${tag}_main`, displayName: null, deviceIds: [] });
  check('A: sync of B\'s handle → taken, nothing about B returned', st.result === 'taken' && Object.keys(st).join() === 'result', JSON.stringify(st));
  r = await http('POST', '/api/social/accounts', A, { platform: 'instagram', handle: `avb_${tag}_main` });
  console.log(`  (info) creating B's handle as A → ${r.status} ${r.body?.code ?? ''} (handles are unique across owners)`);

  // devices
  r = await clean('/api/instances', '/api/instances');
  check('A: device list = D1 only', r.body.instances.length === 1 && r.body.instances[0].id === D1.id);
  await clean('/api/instances/<D1>', `/api/instances/${D1.id}`);
  // 连线监控 is admin only (2026-11-18): A gets 403 even for its granted D1
  await clean('/api/system/connections', '/api/system/connections', 403);
  await clean('/api/system/connections/<D1>/history', `/api/system/connections/${D1.id}/history`, 403);

  // analytics
  r = await clean('/api/analytics/summary', '/api/analytics/summary?days=7');
  await clean('/api/analytics/summary?ownerId=<B>', `/api/analytics/summary?days=7&ownerId=${uB}`);
  check('A: analytics summary has no 777 followers (B\'s)', !r.text.includes('777'));
  await clean('/api/analytics/accounts/<B>', `/api/analytics/accounts/${b.account}`, 404);

  // content + publish
  r = await clean('/api/contents', '/api/contents');
  check('A: contents = A\'s content, targets = A\'s account only', r.body.items.length === 1 && r.body.items[0].targets.every((x: any) => x.id === a.account));
  check('A: list 媒体号 (publishAccounts) = A\'s account only, though the admin also distributed it to B\'s',
    r.body.items[0]?.publishAccounts?.length === 1 && r.body.items[0].publishAccounts[0].id === a.account && !!r.body.items[0].nextPublishAt, r.text.slice(0, 300));
  await clean('/api/contents?ownerId=<B>', `/api/contents?ownerId=${uB}`, 403);
  r = await clean('/api/contents/<A> (admin also distributed it to B\'s account)', `/api/contents/${a.content}`);
  check('A: content detail lists only A\'s publish task', r.body.publishTasks?.length === 1 && r.body.publishTasks[0].accountId === a.account, r.text.slice(0, 300));
  await clean('/api/contents/<B>', `/api/contents/${b.content}`, 404);
  await deny('create content targeting B\'s account', 'POST', '/api/contents', { title: 'x', targetIds: [b.account] });
  await deny('distribute to B\'s account', 'POST', `/api/contents/${a.content}/distribute`, { targets: [{ accountId: b.account, scheduledAt: later }] });
  r = await clean('/api/publish/tasks', '/api/publish/tasks');
  const sum = (o: Record<string, number>) => Object.values(o ?? {}).reduce((s, n) => s + Number(n), 0);
  check('A: publish tasks + byStatus/byPostType counts = 1 (own only)', r.body.total === 1 && sum(r.body.byStatus) === 1 && sum(r.body.byPostType) === 1, r.text.slice(0, 300));
  r = await clean('/api/publish/tasks?accountId=<B>', `/api/publish/tasks?accountId=${b.account}`);
  check('A: accountId=<B> → 0 and zero counts', r.body.total === 0 && sum(r.body.byStatus) === 0);
  await clean('/api/publish/tasks?ownerId=<B>', `/api/publish/tasks?ownerId=${uB}`, 403);
  const from = new Date(Date.now() - 86400_000).toISOString(); const to = new Date(Date.now() + 7 * 86400_000).toISOString();
  r = await clean('/api/publish/tasks?from&to (calendar)', `/api/publish/tasks?from=${from}&to=${to}`);
  check('A: calendar range counts own only', r.body.total === 1);
  await clean('/api/publish/tasks/<B>', `/api/publish/tasks/${ptB}`, 404);
  await clean('/api/publish/tasks/<admin → B>', `/api/publish/tasks/${ptX}`, 404);
  await deny('cancel B\'s publish task', 'POST', `/api/publish/tasks/${ptB}/cancel`);

  // comments
  r = await clean('/api/comments/accounts', '/api/comments/accounts');
  check('A: comment accounts = A\'s only', r.body.accounts.length === 1 && r.body.accounts[0].id === a.account);
  r = await clean('/api/comments', '/api/comments');
  check('A: comments total 1, byStatus sums to 1', r.body.total === 1 && sum(r.body.byStatus) === 1, r.text.slice(0, 200));
  r = await clean('/api/comments?accountId=<B>', `/api/comments?accountId=${b.account}`);
  check('A: accountId=<B> → 0, byStatus zero', r.body.total === 0 && sum(r.body.byStatus) === 0);
  await clean('/api/comments?ownerId=<B>', `/api/comments?ownerId=${uB}`, 403);
  await clean('/api/comments/posts?accountId=<B>', `/api/comments/posts?accountId=${b.account}`, 404);
  await clean('/api/comments/<B>', `/api/comments/${commentB}`, 404);
  r = await clean('/api/comment-replies', '/api/comment-replies');
  await clean('/api/comment-replies?accountId=<B>', `/api/comment-replies?accountId=${b.account}`);
  await clean('/api/comment-replies?ownerId=<B>', `/api/comment-replies?ownerId=${uB}`, 403);
  await clean('/api/comment-replies/<B>', `/api/comment-replies/${replyB}`, 404);
  await deny('manual comment on B\'s account', 'POST', '/api/comments', { accountId: b.account, text: 'x', authorName: 'x' });
  await deny('reply to B\'s comment', 'POST', `/api/comments/${commentB}/replies`, { text: 'x' });
  await deny('cancel B\'s reply', 'POST', `/api/comment-replies/${replyB}/cancel`);
  await clean('/api/comment-templates', '/api/comment-templates');

  // personas / categories
  r = await clean('/api/personas?scope=mine', '/api/personas?scope=mine');
  check('A: personal personas = A\'s only', r.body.personas.length === 1 && r.body.personas[0].id === a.persona);
  await clean('/api/personas?scope=public', '/api/personas?scope=public');
  await clean('/api/personas?scope=all-users', `/api/personas?scope=all-users&ownerId=${uB}`, 403);
  await deny('rename B\'s persona', 'PATCH', `/api/personas/${b.persona}`, { name: 'x' });
  await clean('/api/content-categories?scope=mine', '/api/content-categories?scope=mine');

  // dashboard
  r = await clean('/api/dashboard', '/api/dashboard');
  const w = r.body.widgets ?? r.body;
  // Simplified 2026-11-19: only 我的云机状态 (devices widget); 媒体号分析 is /api/analytics/summary (checked above).
  check('A: dashboard = only the devices widget, A\'s granted phone only', JSON.stringify(r.body.order) === '["devices"]' && w.devices?.total === 1 && !JSON.stringify(w).includes(D2.id), JSON.stringify(w));
  await clean('/api/dashboard?userId=<B>', `/api/dashboard?userId=${uB}`, 403);
  const asA = await http('GET', `/api/dashboard?userId=${uA}`, T);
  const wa = asA.body.widgets ?? asA.body;
  check('admin: dashboard as A shows the same numbers', JSON.stringify(wa) === JSON.stringify(w), `${JSON.stringify(wa)} vs ${JSON.stringify(w)}`);

  // task centre
  r = await clean('/api/tasks', '/api/tasks');
  await clean('/api/tasks?refId=<B account>', `/api/tasks?refId=${b.account}`);
  await clean('/api/tasks?userId=<B>', `/api/tasks?userId=${uB}`);
  await clean('/api/tasks?instanceId=<D1>', `/api/tasks?instanceId=${D1.id}`);
  await clean('/api/tasks/stats', '/api/tasks/stats');
  await clean('/api/tasks/<B check task>', `/api/tasks/${taskB}`, 404);
  await deny('retry B\'s task', 'POST', `/api/tasks/${taskB}/retry`);

  // alerts, audit
  await clean('/api/notifications', '/api/notifications');
  r = await http('GET', '/api/notifications', B);
  check('B: received the account.problem alert about own account', r.text.includes('account.problem') && r.text.includes(`avb_${tag}_main`), r.text.slice(0, 300));
  await clean('/api/audit', '/api/audit', 403);

  // WebSocket
  const wsLeaks = wsMessages.filter((m) => leaks(m).length);
  check(`A's /api/events WebSocket: ${wsMessages.length} messages, none about B's account`, wsLeaks.length === 0, wsLeaks.slice(0, 2).join(' | '));

  // ---------------------------------------------------------------- admin sees both
  r = await http('GET', '/api/social/accounts?pageSize=200', T);
  check('admin: account list contains A\'s and B\'s', [a.account, b.account].every((id) => r.body.items.some((x: any) => x.id === id)));
  r = await http('GET', `/api/social/accounts?ownerId=${uB}`, T);
  check('admin: ownerId=<B> → B\'s account only', r.body.total === 1 && r.body.items[0].id === b.account);
  r = await http('GET', `/api/analytics/summary?days=7&ownerId=${uB}`, T);
  check('admin: analytics summary for B has B\'s account', r.status === 200 && r.text.includes(b.account));
  r = await http('GET', `/api/contents/${a.content}`, T);
  check('admin: A\'s content detail lists both publish tasks', r.body.publishTasks?.length === 2);
  r = await http('GET', `/api/contents?ownerId=${uA}`, T);
  { const acc = (r.body.items?.[0]?.publishAccounts ?? []).map((x: any) => x.id);
    check('admin: list 媒体号 of A\'s content = A\'s and B\'s accounts', acc.length === 2 && acc.includes(a.account) && acc.includes(b.account), r.text.slice(0, 300)); }
  r = await http('GET', `/api/publish/tasks?ownerId=${uB}`, T);
  check('admin: publish tasks for B = 2', r.body.total === 2);
  r = await http('GET', `/api/comments?ownerId=${uB}`, T);
  check('admin: comments of B visible', r.body.total === 1);
  r = await http('GET', `/api/social/accounts/${b.account}`, B);
  check('B: own account detail visible', r.status === 200 && r.body.account.handle === `avb_${tag}_main`);
} catch (err) {
  check(`unexpected error: ${(err as Error).message}`, false);
} finally {
  try { ws?.close(); } catch { /* ignore */ }
  const pts = userIds.length ? await db.select({ id: schema.publishTasks.id, status: schema.publishTasks.status }).from(schema.publishTasks).where(inArray(schema.publishTasks.userId, userIds)) : [];
  for (const p of pts) if (['pending', 'scheduled'].includes(p.status)) await http('POST', `/api/publish/tasks/${p.id}/cancel`, T).catch(() => undefined);
  if (pts.length) await db.delete(schema.tasks).where(inArray(schema.tasks.refId, pts.map((p) => p.id)));
  for (const id of userIds) await http('DELETE', `/api/users/${id}`, T);
  if (fakeIds.length) await db.delete(schema.instances).where(inArray(schema.instances.id, fakeIds));
  await ph.cleanup();
  const left = userIds.length ? await db.select().from(schema.socialAccounts).where(inArray(schema.socialAccounts.userId, userIds)) : [];
  check('cleanup: users (accounts, contents, publish tasks) and placeholder devices removed', left.length === 0);
  await sqlClient.end();
  const failed = results.filter((x) => !x[1]).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}
