/**
 * Dashboard (仪表板) + Settings (设置) test through the public API against the real API, DB and Redis (no mocks).
 * - Dashboard (simplified 2026-11-19: 我的云机状态 + 媒体号分析): GET /api/dashboard has only the `devices` widget.
 *   Placeholder devices in every 云机管理 state (stopped / error / creating / stopped external phone / running ok /
 *   running + device lock = busy / running without adb = offline / 风控暂停) are granted to users A and B; the
 *   widget's state counts and 需要处理 list are checked exactly per role (users never see others' devices; the admin
 *   sees the seeded delta over the baseline), admin ?userId= = that user's dashboard, RBAC. The 媒体号分析 section
 *   is GET /api/analytics/summary (exact numbers in analytics-check.ts); here: its `lastCheck` per account, RBAC,
 *   admin ownerId.
 * - Settings: admin-only routes, write-only secrets (YouTube key), validation, audit entries.
 * - Task retention: only finished tasks older than the retention (and not referenced by unfinished publish
 *   runs) are deleted, with their logs; unfinished/referenced/recent ones are kept; null keeps everything.
 * Running placeholders are pinned by a test-only trigger (dropped afterwards); the busy lock is written in the
 * test API's Redis (REDIS_URL of .env / the environment: never run this against the main API's Redis db 0), the
 * halt into `risk.halts` (removed afterwards).
 * Usage (from apps/api, API running): npx tsx --env-file=../../.env scripts/dashboard-check.ts
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { eq, inArray, like, or, sql } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { db, schema, sqlClient } from '../src/db/index.js';
import { withCaptcha } from './lib/login.js';

const API = process.env.E2E_API ?? `http://127.0.0.1:${process.env.API_PORT ?? 3000}`;
const results: [string, boolean][] = [];
const check = (name: string, ok: boolean, detail = '') => { results.push([name, ok]); console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`); };
const j = (v: unknown) => JSON.stringify(v);
const same = (a: unknown, b: unknown) => j(a) === j(b);

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
const PIN_ON = 'dbc-test-pin-on'; const PIN_OFF = 'dbc-test-pin-off';
const redis = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: 2 });
const T = await login(process.env.ADMIN_USERNAME!, process.env.ADMIN_PASSWORD!);
const dash = async (token: string, q = '') => http('GET', `/api/dashboard?tz=UTC${q}`, token);

const userIds: string[] = [];
const instIds: string[] = [];
const taskIds: string[] = [];
let sourceId: string | null = null;
let haltId: string | null = null;
let retentionBefore: number | null | undefined;

try {
  // ---------------------------------------------------------------- baseline (admin) + users
  const base = (await dash(T)).body;
  check('admin dashboard 200 with exactly the devices widget (simplified 2026-11-19)', !!base && same(base.order, ['devices']) && same(Object.keys(base.widgets), ['devices']), j(base?.order));

  const pw = randomBytes(12).toString('hex');
  const mk = async (name: string) => {
    const r = await http('POST', '/api/users', T, { username: `dbc-${tag}-${name}`, password: pw, role: 'user' });
    userIds.push(r.body.user.id);
    return r.body.user.id as string;
  };
  const A = await mk('a'); const B = await mk('b');
  const TA = await login(`dbc-${tag}-a`, pw); const TB = await login(`dbc-${tag}-b`, pw);

  // ---------------------------------------------------------------- seed: devices in every 云机管理 state
  // Running placeholders are kept running by a test-only trigger (the monitor finds no container / adb for them).
  await sqlClient.unsafe(`create or replace function dbc_test_pin() returns trigger language plpgsql as $$
    begin if new.image = '${PIN_ON}' then new.status := 'running'; new.adb_state := 'device';
    elsif new.image = '${PIN_OFF}' then new.status := 'running'; new.adb_state := null; end if; return new; end $$`);
  await sqlClient.unsafe('drop trigger if exists dbc_test_pin on instances');
  await sqlClient.unsafe('create trigger dbc_test_pin before update on instances for each row execute function dbc_test_pin()');
  const [src] = await db.insert(schema.deviceSources).values({ type: 'bitbrowser', name: `dbc-${tag}-src`, config: { apiUrl: 'http://127.0.0.1:9' } }).returning();
  sourceId = src!.id;
  const spec = { width: 720, height: 1280, dpi: 320 };
  const port = () => 42000 + Math.floor(Math.random() * 15000);
  const dv = (n: string, v: Partial<typeof schema.instances.$inferInsert>) => ({ name: `dbc-${tag}-${n}`, image: 'none', adbPort: port(), status: 'stopped' as const, spec, ...v });
  const devs = await db.insert(schema.instances).values([
    dv('d1-stopped', {}), // not running, stopped on purpose: not listed
    dv('d2-error', { status: 'error' }), // not running, listed (error)
    dv('d3-creating', { status: 'creating' }), // not running, not listed
    dv('d4-ext-stopped', { sourceId, externalId: `x-${tag}` }), // stopped external phone: listed
    dv('d5-ok', { image: PIN_ON, status: 'running', adbState: 'device' }), // 正常
    dv('d6-busy', { image: PIN_ON, status: 'running', adbState: 'device' }), // 忙 (device lock below)
    dv('d7-offline', { image: PIN_OFF, status: 'running', adbState: null }), // 离线: listed
    dv('d8-halted', {}), // 风控暂停 wins over stopped: listed with its code
  ]).returning();
  instIds.push(...devs.map((d) => d.id));
  const [D1, D2, D3, D4, D5, D6, D7, D8] = devs as (typeof devs[0])[];
  await db.insert(schema.instanceGrants).values([
    ...[D1!, D2!, D4!, D5!, D7!].map((d) => ({ userId: A, instanceId: d.id })),
    ...[D2!, D3!, D6!, D8!].map((d) => ({ userId: B, instanceId: d.id })),
  ]);
  await redis.set(`tracked:collector:lock:${D6!.id}`, `dbc${tag}|feed|${Date.now()}`, 'PX', 300_000);
  const [hrow] = await db.select().from(schema.settings).where(eq(schema.settings.key, 'risk.halts'));
  const halts = { ...((hrow?.value as Record<string, unknown>) ?? {}), [D8!.id]: { at: new Date(now).toISOString(), code: 'tracked.collector_challenge', source: 'collector', platform: 'instagram' } };
  await db.insert(schema.settings).values({ key: 'risk.halts', value: halts }).onConflictDoUpdate({ target: schema.settings.key, set: { value: halts } });
  haltId = D8!.id;

  // ---------------------------------------------------------------- per role
  const att = (w: any) => w.attention.map((x: any) => [x.name.replace(`dbc-${tag}-`, ''), x.reason]);
  const ra = await dash(TA);
  const a = ra.body.widgets.devices;
  check('user A: only the devices widget', ra.status === 200 && same(ra.body.order, ['devices']), j(ra.body.order));
  check('user A: granted devices only, counted by state (5: ok 1, offline 1, not running 3)',
    a.total === 5 && same(a.byState, { ok: 1, busy: 0, offline: 1, notRunning: 3, halted: 0 }), j(a.byState));
  check('user A: needs attention = error, offline, stopped external (in that order; stopped local / creating not listed)',
    a.attentionTotal === 3 && same(att(a), [['d2-error', 'error'], ['d7-offline', 'offline'], ['d4-ext-stopped', 'stopped']]), j(att(a)));
  check('user A: attention rows carry id, status, external flag', a.attention[2].id === D4!.id && a.attention[2].external === true && a.attention[2].status === 'stopped' && a.attention[0].external === false);

  const rb = await dash(TB);
  const b = rb.body.widgets.devices;
  check('user B: 4 devices (busy 1, halted 1, not running 2)', b.total === 4 && same(b.byState, { ok: 0, busy: 1, offline: 0, notRunning: 2, halted: 1 }), j(b.byState));
  check('user B: needs attention = halted (with code + time) first, then error',
    same(att(b), [['d8-halted', 'halted'], ['d2-error', 'error']]) && b.attention[0].code === 'tracked.collector_challenge' && !!b.attention[0].at, j(b.attention));
  check("users never see each other's devices", !j(b).includes(D7!.id) && !j(b).includes(D4!.id) && !j(a).includes(D8!.id) && !j(a).includes(D6!.id));

  const adm = (await dash(T)).body.widgets.devices;
  const bs = base.widgets.devices.byState;
  check('admin: every device, +8 (ok +1, busy +1, offline +1, not running +4, halted +1)',
    adm.total - base.widgets.devices.total === 8 && adm.byState.ok - bs.ok === 1 && adm.byState.busy - bs.busy === 1 && adm.byState.offline - bs.offline === 1
    && adm.byState.notRunning - bs.notRunning === 4 && adm.byState.halted - bs.halted === 1, j(adm.byState));
  const mine = new Set(instIds);
  check('admin: needs attention +4, seeded ones in priority order (halted, error, offline, stopped external)', adm.attentionTotal - base.widgets.devices.attentionTotal === 4
    && (adm.attentionTotal > 10 || same(att({ attention: adm.attention.filter((x: any) => mine.has(x.id)) }), [['d8-halted', 'halted'], ['d2-error', 'error'], ['d7-offline', 'offline'], ['d4-ext-stopped', 'stopped']])), j(att(adm)));

  // ---------------------------------------------------------------- 媒体号分析 = GET /api/analytics/summary (the page's second request)
  const acc = await db.insert(schema.socialAccounts).values([
    { userId: A, platform: 'instagram', handle: `dbc${tag}a1`, loginStatus: 'logged_in' as const, instanceId: D5!.id, lastCheckedAt: ago(H), lastCheckCode: 'ok' },
    { userId: A, platform: 'instagram', handle: `dbc${tag}a2`, loginStatus: 'logged_out' as const },
    { userId: B, platform: 'instagram', handle: `dbc${tag}b1`, loginStatus: 'logged_out' as const, lastCheckedAt: ago(2 * H), lastCheckCode: 'logged_out' },
  ]).returning();
  const [SA1, SA2, SB1] = acc as (typeof acc[0])[];
  let r = await http('GET', '/api/analytics/summary?days=7', TA);
  const la = (x: any) => Object.fromEntries(x.body.accounts.map((y: any) => [y.handle, y.lastCheck ? [y.lastCheck.code, y.lastCheck.at] : null]));
  check('summary (user A): own accounts only, each with lastCheck (code + time) or null',
    r.status === 200 && r.body.days.length === 7 && same(la(r), { [SA1!.handle]: ['ok', ago(H).toISOString()], [SA2!.handle]: null }), j(la(r)));
  r = await http('GET', '/api/analytics/summary?days=30', TB);
  check('summary (user B, 30 days): own account + its last check', r.status === 200 && r.body.days.length === 30 && same(la(r), { [SB1!.handle]: ['logged_out', ago(2 * H).toISOString()] }), j(la(r)));
  r = await http('GET', `/api/analytics/summary?days=7&ownerId=${A}`, T);
  check("admin ?ownerId=A (dashboard 「以用户视角查看」) = A's accounts", r.status === 200 && same(la(r), { [SA1!.handle]: ['ok', ago(H).toISOString()], [SA2!.handle]: null }), j(la(r)));

  // ---------------------------------------------------------------- scope switch + RBAC
  const asA = await dash(T, `&userId=${A}`);
  check("admin ?userId=A returns exactly A's own dashboard", asA.status === 200 && same(asA.body.widgets, ra.body.widgets) && same(asA.body.order, ra.body.order) && asA.body.scope.userId === A && asA.body.scope.admin === false);
  r = await dash(TA, `&userId=${B}`);
  check("user A cannot view B's dashboard (403 dashboard.admin_only)", r.status === 403 && r.body.code === 'dashboard.admin_only', r.text.slice(0, 120));
  r = await dash(TA, `&userId=${A}`);
  check('user A ?userId=self is allowed', r.status === 200);
  r = await dash(T, `&userId=${randomUUID()}`);
  check('admin ?userId=unknown → 404', r.status === 404);
  r = await http('GET', '/api/dashboard?tz=Not/AZone', T);
  check('invalid time zone → 400', r.status === 400);
  r = await fetch(`${API}/api/dashboard`).then((x) => ({ status: x.status }) as any);
  check('dashboard requires login (401)', r.status === 401);

  // ---------------------------------------------------------------- seed for the task-retention part: contents + publish runs
  const cs = await db.insert(schema.contents).values([{ userId: A, title: `dbc-${tag}-c1`, stage: 'ready' as const, status: 'ready' as const }]).returning();
  const pub = (status: typeof schema.publishTasks.$inferInsert['status'], accountId: string, extra: Partial<typeof schema.publishTasks.$inferInsert> = {}) =>
    ({ userId: A, contentId: cs[0]!.id, accountId, platform: 'instagram', status, scheduledAt: ago(D), ...extra });
  const pubs = await db.insert(schema.publishTasks).values([
    pub('awaiting_operator', SA1!.id),
    pub('published', SA2!.id, { publishedAt: ago(D) }),
  ]).returning();


  // ---------------------------------------------------------------- settings: admin-only, write-only secrets
  const adminOnly = [['GET', '/api/settings/storage'], ['GET', '/api/settings/youtube'], ['GET', '/api/settings/tasks'], ['GET', '/api/settings/config'], ['GET', '/api/settings/system'],
    ['PUT', '/api/settings/tasks', { retentionDays: 5 }], ['POST', '/api/settings/tasks/cleanup'], ['GET', '/api/social/settings']] as const;
  const codes = await Promise.all(adminOnly.map(([m, p, body]) => http(m, p, TA, body).then((x) => x.status)));
  check('every settings route is admin-only (403 for a user)', codes.every((c) => c === 403), codes.join(','));
  r = await http('GET', '/api/settings/config', T);
  check('config: env publish defaults, no audit retention (a setting now)', r.status === 200 && !('maxAttempts' in r.body.publish) && r.body.publish.timeoutMs > 0 && !('auditRetentionDays' in r.body), j(r.body));
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

  const task = (v: Partial<typeof schema.tasks.$inferInsert>) => ({ type: 'dbc-test', payload: {}, ...v });
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
  // pubs[0] is awaiting_operator (unfinished), pubs[1] published (finished).
  await db.update(schema.publishTasks).set({ taskId: rt[2]!.id }).where(inArray(schema.publishTasks.id, [pubs[0]!.id]));
  await db.update(schema.publishTasks).set({ taskId: rt[3]!.id }).where(inArray(schema.publishTasks.id, [pubs[1]!.id]));

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
  await sqlClient.unsafe('drop trigger if exists dbc_test_pin on instances').catch(() => undefined);
  await sqlClient.unsafe('drop function if exists dbc_test_pin()').catch(() => undefined);
  if (haltId) {
    const [h] = await db.select().from(schema.settings).where(eq(schema.settings.key, 'risk.halts'));
    const rest = { ...((h?.value as Record<string, unknown>) ?? {}) };
    delete rest[haltId];
    await db.update(schema.settings).set({ value: rest }).where(eq(schema.settings.key, 'risk.halts'));
  }
  if (instIds.length) await redis.del(...instIds.map((id) => `tracked:collector:lock:${id}`));
  redis.disconnect();
  for (const id of userIds) await http('DELETE', `/api/users/${id}`, T);
  if (instIds.length) await db.delete(schema.instances).where(inArray(schema.instances.id, instIds));
  if (sourceId) await db.delete(schema.deviceSources).where(eq(schema.deviceSources.id, sourceId));
  const leftUsers = await db.select().from(schema.users).where(like(schema.users.username, `dbc-${tag}-%`));
  const leftRows = await db.select({ id: schema.instances.id }).from(schema.instances).where(like(schema.instances.name, `dbc-${tag}-%`));
  const leftTasks = await db.select({ id: schema.tasks.id }).from(schema.tasks).where(or(sql`${schema.tasks.type} = 'dbc-test'`, like(schema.tasks.instanceName, `dbc-${tag}-%`)));
  const [hl] = await db.select().from(schema.settings).where(eq(schema.settings.key, 'risk.halts'));
  check('cleanup: test users (and their accounts/content), devices, source, halt, trigger and tasks removed', leftUsers.length === 0 && leftRows.length === 0 && leftTasks.length === 0
    && !(haltId && hl && haltId in (hl.value as object)));
  await sqlClient.end();
  const failed = results.filter((x) => !x[1]).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}
