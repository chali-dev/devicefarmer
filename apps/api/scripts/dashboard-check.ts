/**
 * Dashboard (仪表板) + Settings (设置) test through the public API against the real API, DB and Redis (no mocks).
 * - Seeds rows across modules directly in the DB (placeholder devices without containers, proxies, social
 *   accounts, tracked accounts + snapshots, contents + publish runs, tasks, media rows) for the
 *   admin, user A and user B, then checks that GET /api/dashboard returns exactly the seeded numbers per role
 *   (users never see others' rows; the admin sees the seeded delta on top of what was there before).
 * - Settings: admin-only routes, write-only secrets (YouTube key), validation, audit entries.
 * - Task retention: only finished tasks older than the retention (and not referenced by unfinished publish
 *   runs) are deleted, with their logs; unfinished/referenced/recent ones are kept; null keeps everything.
 * Placeholder devices use statuses the monitor leaves alone without a container (stopped / error / creating).
 * Usage (from apps/api, API running): npx tsx --env-file=../../.env scripts/dashboard-check.ts
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { inArray, like, or, sql } from 'drizzle-orm';
import { db, schema, sqlClient } from '../src/db/index.js';
import { withCaptcha } from './lib/login.js';

const API = `http://127.0.0.1:${process.env.API_PORT ?? 3000}`;
const results: [string, boolean][] = [];
const check = (name: string, ok: boolean, detail = '') => { results.push([name, ok]); console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`); };
const j = (v: unknown) => JSON.stringify(v);
const same = (a: unknown, b: unknown) => j(a) === j(b);
const sortKeys = (o: Record<string, number>) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));

async function http<T = any>(method: string, path: string, token: string, body?: unknown) {
  const res = await fetch(API + path, { method, headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* 204 */ }
  return { status: res.status, body: json as T, text };
}
async function login(username: string, password: string): Promise<string> {
  const r = await fetch(`${API}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(await withCaptcha(API, { username, password })) });
  return (await r.json()).token;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor<T>(label: string, fn: () => Promise<T | null | false | undefined>, ms = 30_000): Promise<T> {
  const t0 = Date.now();
  for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() - t0 > ms) throw new Error(`timeout: ${label}`); await sleep(500); }
}

const tag = randomBytes(3).toString('hex');
const now = Date.now();
const ago = (ms: number) => new Date(now - ms);
const H = 3600_000; const D = 24 * H;
const T = await login(process.env.ADMIN_USERNAME!, process.env.ADMIN_PASSWORD!);
const dash = async (token: string, q = '') => http('GET', `/api/dashboard?tz=UTC${q}`, token);

const userIds: string[] = [];
const instIds: string[] = [];
const proxyIds: string[] = [];
const taskIds: string[] = [];
const mediaIds: string[] = [];
let retentionBefore: number | null | undefined;

try {
  // ---------------------------------------------------------------- baseline (admin) + users
  const base = (await dash(T)).body;
  check('admin dashboard 200 with core widgets', !!base && ['devices', 'proxies', 'social', 'tracked', 'publishing', 'tasks', 'media', 'perUser'].every((k) => base.order.includes(k)), j(base?.order));

  const pw = randomBytes(12).toString('hex');
  const mk = async (name: string) => {
    const r = await http('POST', '/api/users', T, { username: `dbc-${tag}-${name}`, password: pw, role: 'user' });
    userIds.push(r.body.user.id);
    return r.body.user.id as string;
  };
  const A = await mk('a'); const B = await mk('b');
  const TA = await login(`dbc-${tag}-a`, pw); const TB = await login(`dbc-${tag}-b`, pw);

  // ---------------------------------------------------------------- seed: devices + grants + proxies
  const spec = { width: 720, height: 1280, dpi: 320 };
  const port = () => 42000 + Math.floor(Math.random() * 15000);
  const devs = await db.insert(schema.instances).values([
    { name: `dbc-${tag}-d1`, image: 'none', adbPort: port(), status: 'stopped' as const, spec },
    { name: `dbc-${tag}-d2`, image: 'none', adbPort: port(), status: 'error' as const, spec },
    { name: `dbc-${tag}-d3`, image: 'none', adbPort: port(), status: 'creating' as const, spec },
    { name: `dbc-${tag}-d4`, image: 'none', adbPort: port(), status: 'stopped' as const, spec },
  ]).returning();
  instIds.push(...devs.map((d) => d.id));
  const [D1, D2, D3] = devs as [typeof devs[0], typeof devs[0], typeof devs[0], typeof devs[0]];
  await db.insert(schema.instanceGrants).values([{ userId: A, instanceId: D1.id }, { userId: A, instanceId: D2.id }, { userId: B, instanceId: D2.id }, { userId: B, instanceId: D3.id }]);
  const pxs = await db.insert(schema.proxies).values([
    { label: `dbc-${tag}-p1`, type: 'socks5' as const, host: `p1-${tag}.invalid`, port: 1080, status: 'ok' as const },
    { label: `dbc-${tag}-p2`, type: 'socks5' as const, host: `p2-${tag}.invalid`, port: 1080, status: 'failed' as const },
    { label: `dbc-${tag}-p3`, type: 'http' as const, host: `p3-${tag}.invalid`, port: 8080, status: 'unchecked' as const },
  ]).returning();
  proxyIds.push(...pxs.map((p) => p.id));
  await db.update(schema.instances).set({ proxyId: pxs[0]!.id }).where(inArray(schema.instances.id, [D1.id]));

  // ---------------------------------------------------------------- seed: social accounts
  const acc = await db.insert(schema.socialAccounts).values([
    { userId: A, platform: 'youtube', handle: `dbc${tag}a1`, loginStatus: 'logged_in' as const, instanceId: D1.id },
    { userId: A, platform: 'instagram', handle: `dbc${tag}a2`, loginStatus: 'logged_out' as const },
    { userId: A, platform: 'tiktok', handle: `dbc${tag}a3`, loginStatus: 'unknown' as const, lastError: 'test error' },
    { userId: B, platform: 'youtube', handle: `dbc${tag}b1`, loginStatus: 'needs_verification' as const },
    { userId: B, platform: 'instagram', handle: `dbc${tag}b2`, loginStatus: 'logged_in' as const, accountStatus: 'limited' as const },
  ]).returning();
  const [SA1, SA2, , SB1, SB2] = acc as [typeof acc[0], typeof acc[0], typeof acc[0], typeof acc[0], typeof acc[0]];

  // ---------------------------------------------------------------- seed: tracked accounts + snapshots
  const tr = await db.insert(schema.trackedAccounts).values([
    { userId: A, platform: 'youtube', handle: `dbc${tag}t1`, profileUrl: 'https://example.invalid/t1', status: 'active' as const },
    { userId: A, platform: 'tiktok', handle: `dbc${tag}t2`, profileUrl: 'https://example.invalid/t2', status: 'active' as const },
    { userId: A, platform: 'youtube', handle: `dbc${tag}t3`, profileUrl: 'https://example.invalid/t3', status: 'error' as const },
    { userId: A, platform: 'youtube', handle: `dbc${tag}t4`, profileUrl: 'https://example.invalid/t4', status: 'paused' as const },
    { userId: B, platform: 'youtube', handle: `dbc${tag}t5`, profileUrl: 'https://example.invalid/t5', status: 'active' as const },
    { userId: B, platform: 'instagram', handle: `dbc${tag}t6`, profileUrl: 'https://example.invalid/t6', status: 'active' as const },
  ]).returning();
  const [T1, T2, T3, T4, T5, T6] = tr as [typeof tr[0], typeof tr[0], typeof tr[0], typeof tr[0], typeof tr[0], typeof tr[0]];
  const snap = (id: string, at: Date, followers: number) => ({ trackedAccountId: id, capturedAt: at, source: 'manual' as const, followers });
  await db.insert(schema.trackedAccountSnapshots).values([
    snap(T1.id, ago(10 * D), 1000), snap(T1.id, ago(3 * D), 1200), snap(T1.id, ago(H), 1500), // gain 500 (baseline before the window)
    snap(T2.id, ago(5 * D), 200), snap(T2.id, ago(D), 260), // gain 60 (first snapshot inside the window)
    snap(T3.id, ago(2 * D), 50), // single snapshot: no gain
    snap(T4.id, ago(20 * D), 100), snap(T4.id, ago(10 * D), 50), // nothing new in the window
    snap(T5.id, ago(6 * D), 10), snap(T5.id, ago(2 * D), 5), // loss: not a gainer
    snap(T6.id, ago(6 * D), 100), snap(T6.id, ago(D), 400), // gain 300
  ]);

  // ---------------------------------------------------------------- seed: contents + publish runs
  const cs = await db.insert(schema.contents).values([
    { userId: A, title: `dbc-${tag}-c1`, stage: 'draft' as const, status: 'draft' as const },
    { userId: A, title: `dbc-${tag}-c2`, stage: 'ready' as const, status: 'ready' as const },
    { userId: B, title: `dbc-${tag}-c3`, stage: 'ready' as const, status: 'scheduled' as const },
  ]).returning();
  const [C1, C2, C3] = cs as [typeof cs[0], typeof cs[0], typeof cs[0]];
  const pub = (userId: string, contentId: string, accountId: string, platform: string, status: typeof schema.publishTasks.$inferInsert['status'], scheduledAt: Date, extra: Partial<typeof schema.publishTasks.$inferInsert> = {}) =>
    ({ userId, contentId, accountId, platform, status, scheduledAt, createdAt: scheduledAt, updatedAt: extra.updatedAt ?? new Date(now), ...extra });
  const pubs = await db.insert(schema.publishTasks).values([
    pub(A, C1.id, SA1.id, 'youtube', 'scheduled', new Date(now + 2 * D), { title: `dbc-${tag}-next` }), // upcoming
    pub(A, C1.id, SA2.id, 'instagram', 'pending', new Date(now + 10 * D)), // beyond 7 days
    pub(A, C2.id, SA1.id, 'youtube', 'published', ago(D), { publishedAt: ago(D), updatedAt: ago(D) }),
    pub(A, C2.id, SA2.id, 'instagram', 'published', ago(9 * D), { publishedAt: ago(9 * D), updatedAt: ago(9 * D) }), // in the 14-day trend only
    pub(A, C1.id, SA1.id, 'youtube', 'failed', ago(2 * D), { updatedAt: ago(2 * D) }),
    pub(A, C2.id, SA2.id, 'instagram', 'awaiting_operator', ago(H)),
    pub(B, C3.id, SB1.id, 'youtube', 'scheduled', new Date(now + D)),
    pub(B, C3.id, SB2.id, 'instagram', 'failed', ago(3 * H), { updatedAt: ago(3 * H) }),
    pub(B, C3.id, SB1.id, 'youtube', 'published', ago(2 * H), { publishedAt: ago(2 * H), updatedAt: ago(2 * H) }),
  ]).returning();

  // ---------------------------------------------------------------- seed: tasks (type without a handler: never executed)
  const task = (v: Partial<typeof schema.tasks.$inferInsert>) => ({ type: 'dbc-test', payload: {}, ...v });
  const ts = await db.insert(schema.tasks).values([
    task({ createdBy: A, status: 'success', createdAt: ago(H), finishedAt: ago(H) }),
    task({ createdBy: A, status: 'failed', createdAt: ago(2 * H), finishedAt: ago(2 * H), error: 'dbc boom', instanceName: `dbc-${tag}-f1` }),
    task({ createdBy: A, status: 'pending', createdAt: ago(H / 2) }),
    task({ createdBy: A, status: 'failed', createdAt: ago(2 * D), finishedAt: ago(2 * D), error: 'dbc old boom', instanceName: `dbc-${tag}-f0` }),
    task({ createdBy: null, status: 'running', instanceId: D2.id, instanceName: D2.name, createdAt: ago(H) }), // visible to A and B (grant)
    task({ createdBy: B, status: 'cancelled', createdAt: ago(5 * H), finishedAt: ago(5 * H) }),
  ]).returning();
  taskIds.push(...ts.map((x) => x.id));

  // ---------------------------------------------------------------- seed: media rows
  const media = (v: Partial<typeof schema.mediaAssets.$inferInsert>) => ({
    name: `dbc-${tag}`, fileName: 'x', storage: 'local' as const, fileKey: `dbc/${randomUUID()}`, mimeType: 'image/png', checksum: 'x', fileType: 'image' as const, fileSize: 1, ...v,
  }) as typeof schema.mediaAssets.$inferInsert;
  const ms = await db.insert(schema.mediaAssets).values([
    media({ ownerType: 'public', ownerId: null, status: 'ready', fileSize: 1000 }),
    media({ ownerType: 'public', ownerId: null, status: 'failed', fileSize: 500, fileType: 'video', mimeType: 'video/mp4' }),
    media({ ownerType: 'user', ownerId: A, status: 'ready', fileSize: 2000 }),
    media({ ownerType: 'user', ownerId: A, status: 'processing', fileSize: 3000, fileType: 'video', mimeType: 'video/mp4' }),
    media({ ownerType: 'user', ownerId: B, status: 'ready', fileSize: 4000 }),
    media({ ownerType: 'user', ownerId: A, status: 'ready', fileSize: 9999, deletedAt: new Date(now) }),
  ]).returning();
  mediaIds.push(...ms.map((m) => m.id));

  // ---------------------------------------------------------------- user A
  const ra = await dash(TA);
  const a = ra.body.widgets;
  check('user A: 200, no admin-only widgets (proxies, perUser), no host capacity', ra.status === 200 && !a.proxies && !a.perUser && a.devices.capacity === null && !ra.body.order.includes('proxies'), j(ra.body.order));
  check('user A: devices = granted only (2: stopped 1, error 1, busy 0)', a.devices.total === 2 && a.devices.stopped === 1 && a.devices.error === 1 && a.devices.busy === 0 && a.devices.running === 0, j(a.devices));
  check('user A: social accounts 3, exceptions 2, linked 1', a.social.total === 3 && a.social.exceptions === 2 && a.social.linked === 1, j(a.social));
  check('user A: social by platform / login status', same(sortKeys(a.social.byPlatform), { instagram: 1, tiktok: 1, youtube: 1 }) && same(sortKeys(a.social.byLogin), { logged_in: 1, logged_out: 1, unknown: 1 }));
  check('user A: social widget has no API connections any more', !('connections' in a.social), j(a.social));
  check('user A: tracked 4 by status (active 2, error 1, paused 1)', a.tracked.total === 4 && same(sortKeys(a.tracked.byStatus), { active: 2, error: 1, paused: 1 }), j(a.tracked.byStatus));
  check('user A: top gainers = [t1 +500, t2 +60]', same(a.tracked.topGainers.map((g: any) => [g.id, g.gain, g.followers]), [[T1.id, 500, 1500], [T2.id, 60, 260]]), j(a.tracked.topGainers));
  const ap = a.publishing;
  check('user A: publishing upcoming 1 / published 1 / failed 1 / awaiting 1 (7 days)', ap.upcoming7d === 1 && ap.published7d === 1 && ap.failed7d === 1 && ap.awaitingOperator === 1 && ap.running === 0, j({ ...ap, trend: undefined, next: undefined }));
  check('user A: contents 2 (draft 1, ready 1)', ap.contents.total === 2 && same(sortKeys(ap.contents.byStatus), { draft: 1, ready: 1 }));
  check('user A: next up = the scheduled run (title, handle)', ap.next.length === 1 && ap.next[0].id === pubs[0]!.id && ap.next[0].title === `dbc-${tag}-next` && ap.next[0].handle === SA1.handle, j(ap.next));
  const day = (d: Date) => d.toISOString().slice(0, 10);
  const trendOf = (tr: any[]) => Object.fromEntries(tr.filter((r) => r.published || r.failed).map((r) => [r.day, [r.published, r.failed]]));
  const expTrendA: Record<string, [number, number]> = {};
  for (const [d, p, f] of [[ago(D), 1, 0], [ago(9 * D), 1, 0], [ago(2 * D), 0, 1]] as [Date, number, number][]) {
    const k = day(d); const cur = expTrendA[k] ?? [0, 0]; expTrendA[k] = [cur[0] + p, cur[1] + f];
  }
  check('user A: 14-day trend has 14 days ending today (UTC) with the seeded per-day counts',
    ap.trend.length === 14 && ap.trend[13].day === day(new Date(now)) && same(sortKeys(trendOf(ap.trend) as any), sortKeys(expTrendA as any)), j(trendOf(ap.trend)));
  check('user A: tasks last 24 h (success 1, failed 1, pending 1, running 1 on a granted device)',
    same(a.tasks.last24h, { total: 4, pending: 1, scheduled: 0, running: 1, success: 1, failed: 1, cancelled: 0 }), j(a.tasks.last24h));
  check('user A: recent failures = own failed tasks, newest first', same(a.tasks.recentFailures.map((f: any) => f.id), [ts[1]!.id, ts[3]!.id]), j(a.tasks.recentFailures.map((f: any) => f.label)));
  check('user A: media (public ready 1 / 1000 B; own 2 / 5000 B; processing 1; deleted and disabled excluded)',
    same(a.media, { public: { count: 1, bytes: 1000, images: 1, videos: 0 }, private: { count: 2, bytes: 5000, images: 1, videos: 1 }, processing: 1, failed: 0 }), j(a.media));

  // ---------------------------------------------------------------- user B
  const b = (await dash(TB)).body.widgets;
  check('user B: devices 2 (error 1, busy 1)', b.devices.total === 2 && b.devices.error === 1 && b.devices.busy === 1 && b.devices.stopped === 0, j(b.devices));
  check('user B: social 2, exceptions 2, linked 0', b.social.total === 2 && b.social.exceptions === 2 && b.social.linked === 0 && !('connections' in b.social), j(b.social));
  check('user B: tracked 2, top gainers = [t6 +300] (loss excluded)', b.tracked.total === 2 && same(b.tracked.topGainers.map((g: any) => [g.id, g.gain]), [[T6.id, 300]]), j(b.tracked.topGainers));
  check('user B: publishing upcoming 1 / published 1 / failed 1 / awaiting 0; contents 1',
    b.publishing.upcoming7d === 1 && b.publishing.published7d === 1 && b.publishing.failed7d === 1 && b.publishing.awaitingOperator === 0 && b.publishing.contents.total === 1);
  check('user B: tasks last 24 h (running 1 on the shared device, cancelled 1), no failures',
    same(b.tasks.last24h, { total: 2, pending: 0, scheduled: 0, running: 1, success: 0, failed: 0, cancelled: 1 }) && b.tasks.recentFailures.length === 0, j(b.tasks.last24h));
  check('user B: media (public 1, own 1 / 4000 B)', b.media.private.count === 1 && b.media.private.bytes === 4000 && b.media.public.count === 1);
  check("users never see each other's rows (B's numbers contain none of A's)", !j(b).includes(T1.id) && !j(b).includes(`dbc${tag}a1`) && !j(a).includes(T6.id));

  // ---------------------------------------------------------------- admin (delta over the baseline)
  const adm = (await dash(T)).body.widgets;
  const dv = (k: string) => adm.devices[k] - base.widgets.devices[k];
  check('admin: devices +4 (stopped +2, error +1, busy +1)', dv('total') === 4 && dv('stopped') === 2 && dv('error') === 1 && dv('busy') === 1, j(adm.devices));
  check('admin: host capacity present', adm.devices.capacity !== null && 'freeMb' in adm.devices.capacity);
  const pv = (k: string) => adm.proxies[k] - base.widgets.proxies[k];
  check('admin: proxies +3 (bound +1, free +2, failed +1, free usable +1)', pv('total') === 3 && pv('bound') === 1 && pv('free') === 2 && pv('failed') === 1 && pv('freeUsable') === 1 && pv('unchecked') === 1, j(adm.proxies));
  check('admin: social +5, exceptions +4', adm.social.total - base.widgets.social.total === 5 && adm.social.exceptions - base.widgets.social.exceptions === 4);
  check('admin: tracked +6', adm.tracked.total - base.widgets.tracked.total === 6);
  const gIds = adm.tracked.topGainers.map((g: any) => g.id).filter((id: string) => [T1.id, T2.id, T6.id].includes(id));
  check('admin: top gainers include all users ordered by gain (t1, t6, t2)', same(gIds, [T1.id, T6.id, T2.id]), j(adm.tracked.topGainers.map((g: any) => g.gain)));
  const bp = base.widgets.publishing; const ad = adm.publishing;
  check('admin: publishing upcoming +2, published +2, failed +2, awaiting +1, contents +3',
    ad.upcoming7d - bp.upcoming7d === 2 && ad.published7d - bp.published7d === 2 && ad.failed7d - bp.failed7d === 2 && ad.awaitingOperator - bp.awaitingOperator === 1 && ad.contents.total - bp.contents.total === 3);
  check('admin: tasks last 24 h +5 (A 3, shared 1, B 1)', adm.tasks.last24h.total - base.widgets.tasks.last24h.total === 5, `${base.widgets.tasks.last24h.total} → ${adm.tasks.last24h.total}`);
  const mb = base.widgets.media;
  check('admin: media public +2 (1500 B, incl. disabled), private +3 (9000 B), processing +1',
    adm.media.public.count - mb.public.count === 2 && adm.media.public.bytes - mb.public.bytes === 1500 && adm.media.private.count - mb.private.count === 3
    && adm.media.private.bytes - mb.private.bytes === 9000 && adm.media.processing - mb.processing === 1, j(adm.media));
  const rowA = adm.perUser.users.find((u: any) => u.id === A);
  check('admin: per-user breakdown row for A', !!rowA && same({ ...rowA, id: undefined, username: undefined, role: undefined, disabled: undefined }, {
    devices: 2, socialAccounts: 3, exceptions: 2, trackedAccounts: 4, contents: 2, published7d: 1, failed7d: 1, awaitingOperator: 1,
  }), j(rowA));

  // ---------------------------------------------------------------- scope switch + RBAC
  const asA = await dash(T, `&userId=${A}`);
  const strip = (w: any) => ({ ...w, devices: { ...w.devices, capacity: null } });
  check("admin ?userId=A returns exactly A's own dashboard", asA.status === 200 && same(strip(asA.body.widgets), strip(a)) && same(asA.body.order, ra.body.order) && asA.body.scope.userId === A);
  let r = await dash(TA, `&userId=${B}`);
  check("user A cannot view B's dashboard (403 dashboard.admin_only)", r.status === 403 && r.body.code === 'dashboard.admin_only', r.text.slice(0, 120));
  r = await dash(TA, `&userId=${A}`);
  check('user A ?userId=self is allowed', r.status === 200);
  r = await dash(T, `&userId=${randomUUID()}`);
  check('admin ?userId=unknown → 404', r.status === 404);
  r = await http('GET', '/api/dashboard?tz=Not/AZone', T);
  check('invalid time zone → 400', r.status === 400);
  r = await http('GET', '/api/dashboard?tz=Asia/Shanghai', TA);
  check('time zone shifts day buckets but not totals', r.status === 200 && r.body.widgets.publishing.trend.length === 14
    && r.body.widgets.publishing.trend.reduce((s: number, x: any) => s + x.published, 0) === 2);
  r = await fetch(`${API}/api/dashboard`).then((x) => ({ status: x.status }) as any);
  check('dashboard requires login (401)', r.status === 401);

  // ---------------------------------------------------------------- settings: admin-only, write-only secrets
  const adminOnly = [['GET', '/api/settings/storage'], ['GET', '/api/settings/youtube'], ['GET', '/api/settings/tasks'], ['GET', '/api/settings/config'], ['GET', '/api/settings/system'],
    ['PUT', '/api/settings/tasks', { retentionDays: 5 }], ['POST', '/api/settings/tasks/cleanup'], ['GET', '/api/social/settings']] as const;
  const codes = await Promise.all(adminOnly.map(([m, p, body]) => http(m, p, TA, body).then((x) => x.status)));
  check('every settings route is admin-only (403 for a user)', codes.every((c) => c === 403), codes.join(','));
  r = await http('GET', '/api/settings/config', T);
  check('config: env media defaults, no publish timeout (系统配置 → 任务超时) and no audit retention (settings now)', r.status === 200 && r.body.media?.imageMaxMb > 0 && !('publish' in r.body) && !('auditRetentionDays' in r.body), j(r.body));
  r = await http('GET', '/api/settings/system', T);
  check('system: real health checks for postgres/redis/docker/adb/stf + versions', r.status === 200 && ['postgres', 'redis', 'docker', 'adb', 'stf'].every((k) => k in r.body.health.checks)
    && r.body.health.checks.postgres === 'ok' && typeof r.body.versions.postgres === 'string' && !r.text.includes(process.env.DATABASE_URL!), j(r.body.health));
  r = await http('GET', '/api/settings/storage', T);
  check('storage settings never return the S3 secret', r.status === 200 && !/secretAccessKey"\s*:/.test(r.text));
  const ytBefore = (await http('GET', '/api/settings/youtube', T)).body.youtube;
  const KEY = `AIzaTest${randomBytes(16).toString('hex')}`;
  r = await http('PUT', '/api/settings/youtube', T, { apiKey: KEY });
  const ytGet = await http('GET', '/api/settings/youtube', T);
  check('YouTube key is write-only (set, never returned)', r.status === 200 && ytGet.body.youtube.apiKeySet === true && !r.text.includes(KEY) && !ytGet.text.includes(KEY));
  if (!ytBefore.apiKeySet) await http('PUT', '/api/settings/youtube', T, { apiKey: null });

  // ---------------------------------------------------------------- task retention
  const rs = (await http('GET', '/api/settings/tasks', T)).body;
  retentionBefore = rs.retention.days;
  check('retention GET shows days + default', typeof rs.defaultDays === 'number' && 'days' in rs.retention);
  for (const bad of [0, -1, 1.5, 4000, '30']) {
    r = await http('PUT', '/api/settings/tasks', T, { retentionDays: bad });
    if (r.status !== 400) { check(`retention ${j(bad)} rejected`, false, String(r.status)); break; }
  }
  check('retention validation (0, negative, fraction, > 3650, string → 400)', true);

  const old = ago(40 * D);
  const rt = await db.insert(schema.tasks).values([
    task({ status: 'success', createdAt: old, finishedAt: old, updatedAt: old }), // 0 delete
    task({ status: 'failed', createdAt: old, finishedAt: old, updatedAt: old }), // 1 delete
    task({ status: 'cancelled', createdAt: old, finishedAt: old, updatedAt: old }), // 2 keep: unfinished publish run references it
    task({ status: 'success', createdAt: old, finishedAt: old, updatedAt: old }), // 3 delete: referenced by a finished publish run
    task({ status: 'pending', createdAt: old, updatedAt: old }), // 4 keep: unfinished
    task({ status: 'running', createdAt: old, startedAt: old, updatedAt: old }), // 5 keep: unfinished
    task({ status: 'success', createdAt: ago(5 * D), finishedAt: ago(5 * D), updatedAt: ago(5 * D) }), // 6 keep: recent
    task({ status: 'success', createdAt: old, finishedAt: null, updatedAt: old }), // 7 delete: finished_at missing, updated long ago
  ]).returning();
  taskIds.push(...rt.map((x) => x.id));
  await db.insert(schema.taskLogs).values(rt.flatMap((x) => [{ taskId: x.id, level: 'info' as const, message: 'dbc log 1' }, { taskId: x.id, level: 'info' as const, message: 'dbc log 2' }]));
  // pubs[5] is awaiting_operator (unfinished), pubs[2] published (finished).
  await db.update(schema.publishTasks).set({ taskId: rt[2]!.id }).where(inArray(schema.publishTasks.id, [pubs[5]!.id]));
  await db.update(schema.publishTasks).set({ taskId: rt[3]!.id }).where(inArray(schema.publishTasks.id, [pubs[2]!.id]));

  const runCleanup = async () => {
    const c = await http('POST', '/api/settings/tasks/cleanup', T);
    if (c.status !== 202) throw new Error(`cleanup → ${c.status} ${c.text}`);
    return waitFor('cleanup task', async () => {
      const t = (await http('GET', `/api/tasks/${c.body.task.id}`, T)).body?.task;
      return t && ['success', 'failed'].includes(t.status) ? t : null;
    });
  };
  const exists = async (ids: string[]) => new Set((await db.select({ id: schema.tasks.id }).from(schema.tasks).where(inArray(schema.tasks.id, ids))).map((x) => x.id));

  r = await http('PUT', '/api/settings/tasks', T, { retentionDays: null });
  let ct = await runCleanup();
  let left = await exists(rt.map((x) => x.id));
  check('retention null (keep forever): cleanup deletes nothing', ct.status === 'success' && ct.result.tasks === 0 && left.size === rt.length, j(ct.result));

  r = await http('PUT', '/api/settings/tasks', T, { retentionDays: 30 });
  check('retention set to 30 days', r.status === 200 && r.body.retention.days === 30);
  ct = await runCleanup();
  left = await exists(rt.map((x) => x.id));
  const del = [0, 1, 3, 7].map((i) => rt[i]!.id); const keep = [2, 4, 5, 6].map((i) => rt[i]!.id);
  check('cleanup ran as a task-centre task (success, result counts)', ct.status === 'success' && ct.type === 'tasks-cleanup' && ct.result.tasks >= 4 && ct.result.logs >= 8, j(ct.result));
  check('deleted: old finished tasks (success/failed, finished_at missing, referenced only by a finished publish run)', del.every((id) => !left.has(id)));
  check('kept: unfinished (pending/running), recent, and referenced by an unfinished publish run', keep.every((id) => left.has(id)), j(keep.map((id) => left.has(id))));
  const logsLeft = await db.select({ taskId: schema.taskLogs.taskId }).from(schema.taskLogs).where(inArray(schema.taskLogs.taskId, rt.map((x) => x.id)));
  check('task_logs of deleted tasks removed, logs of kept tasks intact', logsLeft.every((l) => keep.includes(l.taskId)) && logsLeft.length === keep.length * 2, String(logsLeft.length));
  const dashTasks = await exists(ts.map((x) => x.id));
  check('recent dashboard tasks untouched by the cleanup', dashTasks.size === ts.length);
  const st = (await http('GET', '/api/settings/tasks', T)).body;
  check('settings show the last cleanup run', st.lastCleanup?.id === ct.id && st.lastCleanup.result.tasks === ct.result.tasks);

  // Hourly scheduling is idempotent per hour (several API processes create one task).
  const { scheduleTaskCleanup } = await import('../src/modules/tasks/retention.js');
  const { closeTaskQueues } = await import('../src/modules/tasks/core.js');
  const h1 = await scheduleTaskCleanup(); const h2 = await scheduleTaskCleanup();
  check('hourly cleanup is one task per hour (idempotency key)', h1.task.id === h2.task.id && h2.created === false && h1.task.idempotencyKey === `hourly:${new Date().toISOString().slice(0, 13)}`);
  await closeTaskQueues();

  // ---------------------------------------------------------------- audit
  await sleep(500);
  const audit = await sqlClient`select action, detail::text as detail, username from audit_logs where action like 'settings.%' and at > ${new Date(now - 60_000).toISOString()}::timestamptz order by at`;
  const acts = new Set(audit.map((x) => x.action as string));
  check('audit: settings.task_retention / settings.task_cleanup / settings.youtube_api_key recorded', ['settings.task_retention', 'settings.task_cleanup', 'settings.youtube_api_key'].every((x) => acts.has(x)), [...acts].join(','));
  check('audit: retention detail allowlisted ({retentionDays})', audit.some((x) => x.action === 'settings.task_retention' && x.detail === '{"retentionDays": 30}'), j(audit.filter((x) => x.action === 'settings.task_retention').map((x) => x.detail)));
  check('audit: the YouTube key never appears in the audit log', audit.every((x) => !String(x.detail).includes(KEY)) && audit.some((x) => x.action === 'settings.youtube_api_key' && x.detail === '{"set": true}'));
  const failedAudit = await sqlClient`select count(*)::int as n from audit_logs where action = 'settings.task_retention' and username = ${`dbc-${tag}-a`} and ok = false`;
  check("audit: user A's refused settings write recorded as failed (403)", failedAudit[0]!.n === 1, String(failedAudit[0]!.n));
} catch (err) {
  check(`unexpected error: ${(err as Error).stack ?? (err as Error).message}`, false);
} finally {
  if (retentionBefore !== undefined) await http('PUT', '/api/settings/tasks', T, { retentionDays: retentionBefore });
  if (taskIds.length) await db.delete(schema.tasks).where(inArray(schema.tasks.id, taskIds));
  if (mediaIds.length) await db.delete(schema.mediaAssets).where(inArray(schema.mediaAssets.id, mediaIds));
  if (instIds.length) await db.delete(schema.instances).where(inArray(schema.instances.id, instIds));
  if (proxyIds.length) await db.delete(schema.proxies).where(inArray(schema.proxies.id, proxyIds));
  for (const id of userIds) await http('DELETE', `/api/users/${id}`, T);
  const leftUsers = await db.select().from(schema.users).where(like(schema.users.username, `dbc-${tag}-%`));
  const leftRows = await db.select({ id: schema.instances.id }).from(schema.instances).where(like(schema.instances.name, `dbc-${tag}-%`));
  const leftTasks = await db.select({ id: schema.tasks.id }).from(schema.tasks).where(or(sql`${schema.tasks.type} = 'dbc-test'`, like(schema.tasks.instanceName, `dbc-${tag}-%`)));
  check('cleanup: test users (and their accounts/content), devices, proxies, tasks and media removed', leftUsers.length === 0 && leftRows.length === 0 && leftTasks.length === 0);
  await sqlClient.end();
  const failed = results.filter((x) => !x[1]).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}
