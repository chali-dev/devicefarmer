/**
 * 压测 (load test) against a TEST API: real HTTP, WebSocket, DB and Redis, no mocks. Refuses the main API (port 3000),
 * the main DB (`cloudphone`) and the main Redis db 0. Seeds a volume (scripts/lib/load-seed.ts, LOAD_SCALE=1|10),
 * runs the scenarios, prints one table per scenario and removes what it created (LOAD_KEEP=1 keeps it).
 *
 * Scenarios (LOAD_SCENARIOS csv, default all, in this order):
 *  browse  closed loop of VUS virtual users for DURATION s over the list endpoints every page calls, weighted like real
 *          use (polled ones such as instances/automation and the notification bell most). 70 % users, 30 % admin.
 *  ws      WS_CLIENTS /api/events clients (half admin, half the users) receive task events while VUS/2 writers create
 *          and edit contents, distribute them to accounts on placeholder phones (the round fails at once: device
 *          offline), enter comments + reply drafts and read settings; the script also creates `test.echo` tasks
 *          (ECHO_RPS/s, API started with TASKS_TEST_HANDLERS=1) so events flow steadily. Fan-out latency = arrival −
 *          the server's stamp (task.updated → task.updatedAt, task.log → log.ts; same host clock).
 *  login   burst of LOGIN_ATTEMPTS captcha + login pairs at LOGIN_CONCURRENCY: the per-IP captcha limit
 *          (LOGIN_CAPTCHA_RATE per minute) must hold. 429 auth.captcha_rate_limited is expected, not an error; the
 *          check fails if more challenges than the limit were served inside one minute window, or a solved login failed.
 *  soak    the browse mix open-loop at SOAK_RPS for SOAK_SEC, sampling the API's RSS (ps on the pid listening on the
 *          API port; local APIs only) and the Postgres connections of the DB (pg_stat_activity) every 10 s.
 *
 * Pass/fail: error rate (non-2xx except the expected 4xx above, network errors) ≤ 1 % per scenario, p95 per endpoint
 * ≤ P95_MS (reads, default 1000 ms: a page fires 3–6 such calls in parallel, so > 1 s per call makes the page feel
 * broken), ≤ P95_WRITE_MS for writes and login (default 2000 ms: a distribute is several transactions, a login a
 * password hash), WS fan-out p95 ≤ P95_WS_MS (default 1000 ms), no leak in the soak (RSS of the last third ≤ first
 * third + max(64 MB, 25 %); DB connections of the last sample ≤ first + 5).
 *
 * Parameters (env or --name=value, e.g. --vus=40): LOAD_SCALE (1), VUS (20), DURATION (30 s), WS_CLIENTS (100),
 * ECHO_RPS (5), LOGIN_ATTEMPTS (LOGIN_CAPTCHA_RATE + 40), LOGIN_CONCURRENCY (20), SOAK_RPS (5), SOAK_SEC (180),
 * P95_MS, P95_WRITE_MS, P95_WS_MS, LOAD_SCENARIOS, LOAD_KEEP, API_PID (else found with lsof).
 *
 *   E2E_API=http://127.0.0.1:<port> API_PORT=<port> LOAD_SCALE=1 npx tsx --env-file=../../.env scripts/load-check.ts
 *
 * The API must run with ENABLED_PLATFORMS=all or the default (instagram) and TASKS_TEST_HANDLERS=1 for the echo
 * tasks (without it ws runs without them). The login scenario consumes the captcha budget of this IP for a minute.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import WebSocket from 'ws';
import { eq, sql } from 'drizzle-orm';
import { db, schema, sqlClient } from '../src/db/index.js';
import { events } from '../src/lib/events.js';
import { closeTaskQueues, createTask } from '../src/modules/tasks/core.js';
import '../src/modules/tasks/test-handlers.js';
import { cleanupLoad, seedLoad, type LoadSeed } from './lib/load-seed.js';
import { dragTrail, storedCaptcha, withCaptcha, type CaptchaAnswer } from './lib/login.js';

// ---------------------------------------------------------------- parameters + guards
const argv = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => {
  const [k, v] = a.slice(2).split('=');
  return [k!.toUpperCase().replace(/-/g, '_'), v ?? '1'];
}));
const P = (k: string, d: number) => Number(argv[k] ?? process.env[k] ?? d);
const API = process.env.E2E_API ?? `http://127.0.0.1:${process.env.API_PORT ?? 3000}`;
const apiUrl = new URL(API);
const apiPort = Number(apiUrl.port || (apiUrl.protocol === 'https:' ? 443 : 80));
const dbName = new URL(process.env.DATABASE_URL ?? 'postgres://x/cloudphone').pathname.replace(/^\//, '');
const redisDb = new URL(process.env.REDIS_URL ?? 'redis://x/0').pathname.replace(/^\//, '') || '0';
if (apiPort === 3000 || dbName === 'cloudphone' || redisDb === '0') {
  console.error(`refusing to run: load tests only against a test API/DB/Redis (API port ${apiPort}, DB ${dbName}, Redis db ${redisDb})`);
  process.exit(2);
}
const SCALE = P('LOAD_SCALE', 1);
const VUS = P('VUS', 20);
const DURATION = P('DURATION', 30);
const WS_CLIENTS = P('WS_CLIENTS', 100);
const ECHO_RPS = P('ECHO_RPS', 5);
const CAPTCHA_RATE = Number(process.env.LOGIN_CAPTCHA_RATE ?? 60);
const LOGIN_ATTEMPTS = P('LOGIN_ATTEMPTS', CAPTCHA_RATE + 40);
const LOGIN_CONCURRENCY = P('LOGIN_CONCURRENCY', 20);
const SOAK_RPS = P('SOAK_RPS', 5);
const SOAK_SEC = P('SOAK_SEC', 180);
const P95_MS = P('P95_MS', 1000);
const P95_WRITE_MS = P('P95_WRITE_MS', 2000);
const P95_WS_MS = P('P95_WS_MS', 1000);
const SCENARIOS = new Set(String(argv.LOAD_SCENARIOS ?? process.env.LOAD_SCENARIOS ?? 'browse,ws,login,soak').split(',').map((s) => s.trim()));
const KEEP = (argv.LOAD_KEEP ?? process.env.LOAD_KEEP) === '1';

// ---------------------------------------------------------------- measurement
interface Stat { name: string; kind: 'read' | 'write'; lat: number[]; n: number; errors: number; expected: number; codes: Map<string, number> }
type Outcome = 'ok' | 'expected' | 'error';
class Recorder {
  stats = new Map<string, Stat>();
  t0 = Date.now();
  t1 = 0;
  add(name: string, kind: 'read' | 'write', ms: number, outcome: Outcome, code: string) {
    let s = this.stats.get(name);
    if (!s) this.stats.set(name, s = { name, kind, lat: [], n: 0, errors: 0, expected: 0, codes: new Map() });
    s.n++;
    s.lat.push(ms);
    if (outcome === 'error') { s.errors++; s.codes.set(code, (s.codes.get(code) ?? 0) + 1); }
    if (outcome === 'expected') s.expected++;
  }
  stop() { this.t1 = Date.now(); }
}
const pct = (sorted: number[], p: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]! : NaN);
const fmt = (n: number) => (Number.isFinite(n) ? (n >= 100 ? n.toFixed(0) : n.toFixed(1)) : '-');
const failures: string[] = [];

function report(title: string, r: Recorder, opts: { maxErrorRate?: number } = {}) {
  const secs = ((r.t1 || Date.now()) - r.t0) / 1000;
  const rows = [...r.stats.values()].sort((a, b) => b.n - a.n);
  console.log(`\n### ${title} (${secs.toFixed(0)} s)\n`);
  console.log('| endpoint | req | err | exp 4xx | p50 ms | p95 ms | p99 ms | max ms | req/s |');
  console.log('|---|---:|---:|---:|---:|---:|---:|---:|---:|');
  let n = 0;
  let e = 0;
  for (const s of rows) {
    const sorted = [...s.lat].sort((a, b) => a - b);
    const p95 = pct(sorted, 95);
    console.log(`| ${s.name} | ${s.n} | ${s.errors} | ${s.expected} | ${fmt(pct(sorted, 50))} | ${fmt(p95)} | ${fmt(pct(sorted, 99))} | ${fmt(sorted.at(-1) ?? NaN)} | ${(s.n / secs).toFixed(1)} |`);
    n += s.n;
    e += s.errors;
    const limit = s.kind === 'read' ? P95_MS : P95_WRITE_MS;
    if (p95 > limit) failures.push(`${title}: ${s.name} p95 ${fmt(p95)} ms > ${limit} ms`);
    if (s.errors) console.log(`|  ↳ errors | ${[...s.codes].map(([c, k]) => `${c}×${k}`).join(', ')} |||||||| `);
  }
  console.log(`| **total** | ${n} | ${e} | | | | | | ${(n / secs).toFixed(1)} |`);
  const rate = n ? e / n : 0;
  if (rate > (opts.maxErrorRate ?? 0.01)) failures.push(`${title}: error rate ${(rate * 100).toFixed(2)} % > ${((opts.maxErrorRate ?? 0.01) * 100).toFixed(0)} %`);
}

/** One HTTP call, timed until the body is read. `expect` classifies non-2xx statuses that are part of the scenario. */
async function call(r: Recorder, name: string, method: string, path: string, token: string | null, body?: unknown,
  opts: { kind?: 'read' | 'write'; expect?: (status: number, code: string) => boolean } = {}): Promise<{ status: number; json: any }> {
  const t = performance.now();
  let status = 0;
  let json: any = null;
  let code = '';
  try {
    const res = await fetch(API + path, {
      method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
    status = res.status;
    const text = await res.text();
    try { json = JSON.parse(text); } catch { /* empty */ }
    code = json?.code ?? String(status);
  } catch (err) {
    code = (err as Error).name === 'TimeoutError' ? 'timeout' : `net:${(err as { cause?: { code?: string } }).cause?.code ?? (err as Error).message}`;
  }
  const ms = performance.now() - t;
  const outcome: Outcome = status >= 200 && status < 300 ? 'ok' : status && opts.expect?.(status, code) ? 'expected' : 'error';
  r.add(name, opts.kind ?? (method === 'GET' ? 'read' : 'write'), ms, outcome, `${status || ''} ${code}`.trim());
  return { status, json };
}

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
const rnd = <T>(a: readonly T[]) => a[Math.floor(Math.random() * a.length)]!;
function weighted<T>(items: readonly (readonly [number, T])[]): () => T {
  const total = items.reduce((s, [w]) => s + w, 0);
  return () => {
    let x = Math.random() * total;
    for (const [w, v] of items) { if ((x -= w) < 0) return v; }
    return items.at(-1)![1];
  };
}
async function closedLoop(seconds: number, vus: number, fn: (vu: number) => Promise<void>) {
  const end = Date.now() + seconds * 1000;
  await Promise.all(Array.from({ length: vus }, async (_, vu) => { while (Date.now() < end) await fn(vu); }));
}
async function openLoop(seconds: number, rps: number, fn: () => Promise<void>) {
  const end = Date.now() + seconds * 1000;
  const inflight = new Set<Promise<void>>();
  for (let next = Date.now(); next < end; next += 1000 / rps) {
    const wait = next - Date.now();
    if (wait > 0) await sleep(wait);
    const p = fn().finally(() => inflight.delete(p));
    inflight.add(p);
  }
  await Promise.all(inflight);
}

// ---------------------------------------------------------------- resources of the API under test
function apiPid(): number | null {
  if (process.env.API_PID) return Number(process.env.API_PID);
  if (!['127.0.0.1', 'localhost'].includes(apiUrl.hostname)) return null;
  try { return Number(execFileSync('lsof', ['-nP', `-iTCP:${apiPort}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' }).trim().split('\n')[0]) || null; } catch { return null; }
}
const PID = apiPid();
function rssMb(): number | null {
  if (!PID) return null;
  try { return Number(execFileSync('ps', ['-o', 'rss=', '-p', String(PID)], { encoding: 'utf8' }).trim()) / 1024; } catch { return null; }
}
const pgPort = new URL(process.env.DATABASE_URL ?? 'postgres://x').port || '5432';
/**
 * `api` = the API process's established Postgres connections (lsof on its pid; its pool is 10), `total` = every
 * connection to the DB in pg_stat_activity (also this script's own pool and other processes on the same DB).
 */
async function dbConns(): Promise<{ total: number; api: number | null }> {
  const [r] = await sqlClient`select count(*)::int as total from pg_stat_activity where datname = current_database()`;
  let api: number | null = null;
  if (PID) {
    try {
      api = execFileSync('lsof', ['-nP', '-a', '-p', String(PID), `-iTCP:${pgPort}`, '-sTCP:ESTABLISHED'], { encoding: 'utf8' }).trim().split('\n').length - 1;
    } catch { api = 0; } // lsof exits 1 when nothing matches
  }
  return { total: r!.total as number, api };
}
const resources = async () => ({ rss: rssMb(), db: await dbConns() });

// ---------------------------------------------------------------- setup
async function login(username: string, password: string): Promise<string> {
  const res = await fetch(`${API}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(await withCaptcha(API, { username, password })) });
  const j = await res.json() as { token?: string };
  if (!j.token) throw new Error(`login ${username}: ${res.status} ${JSON.stringify(j)}`);
  return j.token;
}
const tag = randomBytes(3).toString('hex');
const pw = randomBytes(12).toString('base64url');
const setup = new Recorder();
console.log(`load-check ${tag}: API ${API} (pid ${PID ?? 'n/a'}), DB ${dbName}, Redis db ${redisDb}, scale ${SCALE}, ${VUS} VUs × ${DURATION} s, scenarios ${[...SCENARIOS].join(',')}`);
const before = await resources();
const ADMIN = await login(process.env.ADMIN_USERNAME!, process.env.ADMIN_PASSWORD!);
const [adminRow] = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.username, process.env.ADMIN_USERNAME!));
const USERS = 4;
const users: { id: string; name: string; token: string }[] = [];
let seed: LoadSeed | null = null;
let exitCode = 0;

try {
  for (let i = 0; i < USERS; i++) {
    const name = `ld${tag}u${i}`;
    const r = await call(setup, 'POST /api/users', 'POST', '/api/users', ADMIN, { username: name, password: pw, role: 'user' });
    if (r.status !== 201 && r.status !== 200) throw new Error(`create user: ${r.status} ${JSON.stringify(r.json)}`);
    users.push({ id: r.json.user?.id ?? r.json.id, name, token: '' });
  }
  for (const u of users) u.token = await login(u.name, pw);
  const ts = Date.now();
  seed = await seedLoad(tag, SCALE, adminRow!.id, users.map((u) => u.id));
  // A bulk seed leaves the planner without statistics until autovacuum runs (minutes); production tables have them, so
  // measure with fresh statistics, as a long-running DB would have (else every list plans like an empty table).
  await db.execute(sql`analyze`);
  console.log(`seeded in ${((Date.now() - ts) / 1000).toFixed(1)} s: ${Object.entries(seed.counts).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  const S = seed;
  const tokenFor = (vu: number) => (vu % 10 < 3 ? { token: ADMIN, user: null } : { token: users[vu % USERS]!.token, user: users[vu % USERS]! });

  // ---------------------------------------------------------------- the browsing mix (paths as the pages send them)
  const BROWSE = weighted([
    [15, '/api/instances/automation'], // 我的云机 polls it every 10 s
    [12, '/api/notifications?limit=5&read=all'], // bell (every page)
    [10, '/api/dashboard?tz=Asia%2FShanghai'],
    [10, '/api/instances'],
    [10, '/api/contents?page=1&pageSize=20'],
    [8, '/api/social/accounts?page=1&pageSize=20'],
    [6, '/api/tracked-accounts?page=1&pageSize=20'],
    [6, '/api/publish/tasks?group=content&limit=20&offset=0&sort=updated_desc'], // 发文日志
    [6, '/api/tasks?limit=20&offset=0'],
    [5, '/api/comments?limit=20&offset=0'],
    [5, '/api/media?page=1&pageSize=24'],
    [4, '/api/analytics/summary?days=30'],
    [3, '/api/auth/me'],
  ] as const);
  const browseOnce = async (r: Recorder, vu: number) => {
    const path = BROWSE();
    await call(r, `GET ${path.split('?')[0]}`, 'GET', path, tokenFor(vu).token);
  };

  if (SCENARIOS.has('browse')) {
    const r = new Recorder();
    let vuCounter = 0;
    await closedLoop(DURATION, VUS, async () => browseOnce(r, vuCounter++));
    r.stop();
    report(`browse: ${VUS} VUs closed loop`, r);
  }

  // ---------------------------------------------------------------- WebSocket fan-out while writes run
  if (SCENARIOS.has('ws')) {
    const lags: number[] = [];
    let received = 0;
    let closedEarly = 0;
    const perClient: number[] = [];
    const sockets: WebSocket[] = [];
    let stopping = false;
    const tOpen = Date.now();
    await Promise.all(Array.from({ length: WS_CLIENTS }, (_, i) => new Promise<void>((resolve) => {
      const token = i % 2 === 0 ? ADMIN : users[i % USERS]!.token;
      const ws = new WebSocket(`${API.replace(/^http/, 'ws')}/api/events`);
      sockets.push(ws);
      perClient[i] = 0;
      let ready = false;
      const fail = setTimeout(() => { if (!ready) resolve(); }, 15_000);
      ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', token })));
      ws.on('message', (raw) => {
        const at = Date.now();
        const ev = JSON.parse(raw.toString());
        if (ev.type === 'ready') { ready = true; clearTimeout(fail); resolve(); return; }
        received++;
        perClient[i]!++;
        const stamp = ev.type === 'task.updated' ? ev.task?.updatedAt : ev.type === 'task.log' ? ev.log?.ts : null;
        if (stamp) lags.push(at - new Date(stamp).getTime());
      });
      ws.on('close', () => { if (!stopping) closedEarly++; resolve(); });
      ws.on('error', () => undefined);
    })));
    const readyCount = sockets.filter((s) => s.readyState === WebSocket.OPEN).length;
    console.log(`\nws: ${readyCount}/${WS_CLIENTS} clients ready in ${Date.now() - tOpen} ms`);

    const r = new Recorder();
    const accountsOf = (u: string) => S.accounts.filter((a) => a.userId === u && a.instanceId);
    const writeOnce = async (vu: number) => {
      const u = users[vu % USERS]!;
      const acc = rnd(accountsOf(u.id));
      const kind = Math.random();
      if (kind < 0.5) {
        const c = await call(r, 'POST /api/contents', 'POST', '/api/contents', u.token, { title: `ld-${tag} w${vu}`, body: 'load write', mediaIds: [rnd(S.publicMedia)], targetIds: [acc.id], stage: 'ready' });
        const id = c.json?.content?.id ?? c.json?.id;
        if (!id) return;
        await call(r, 'PUT /api/contents/:id', 'PUT', `/api/contents/${id}`, u.token, { body: 'load write, edited' });
        await call(r, 'POST /api/contents/:id/distribute', 'POST', `/api/contents/${id}/distribute`, u.token, { targets: [{ accountId: acc.id }] });
      } else if (kind < 0.9) {
        const c = await call(r, 'POST /api/comments', 'POST', '/api/comments', u.token, { accountId: acc.id, text: `nice ${vu}`, authorName: 'fan', externalPostId: 'post-1' });
        const id = c.json?.comment?.id;
        if (id) await call(r, 'POST /api/comments/:id/replies', 'POST', `/api/comments/${id}/replies`, u.token, { text: `thanks ${vu}` });
      } else {
        await call(r, 'GET /api/comments/settings', 'GET', '/api/comments/settings', u.token);
        await call(r, 'GET /api/media/limits', 'GET', '/api/media/limits', u.token);
      }
    };
    let echoes = 0;
    const echo = (async () => {
      if (!ECHO_RPS) return;
      await openLoop(DURATION, ECHO_RPS, async () => {
        try { await createTask({ type: 'test.echo', label: `ld-${tag} echo`, payload: { sleepMs: 50 } }); echoes++; } catch { /* counted below */ }
      });
    })();
    const writers = Math.max(1, Math.floor(VUS / 2));
    await Promise.all([closedLoop(DURATION, writers, writeOnce), echo]);
    await sleep(3000); // let the last rounds' events arrive
    r.stop();
    stopping = true;
    for (const s of sockets) s.close();
    report(`ws + writes: ${writers} writer VUs, ${WS_CLIENTS} WS clients, ${echoes} echo tasks`, r);
    const sorted = lags.sort((a, b) => a - b);
    const per = perClient.slice().sort((a, b) => a - b);
    console.log(`\n| WS fan-out | clients | events received | per client min / median / max | lag p50 ms | p95 ms | p99 ms | max ms | dropped connections |`);
    console.log('|---|---:|---:|---|---:|---:|---:|---:|---:|');
    console.log(`| /api/events | ${readyCount} | ${received} | ${per[0]} / ${pct(per, 50)} / ${per.at(-1)} | ${fmt(pct(sorted, 50))} | ${fmt(pct(sorted, 95))} | ${fmt(pct(sorted, 99))} | ${fmt(sorted.at(-1) ?? NaN)} | ${closedEarly} |`);
    if (readyCount < WS_CLIENTS) failures.push(`ws: only ${readyCount}/${WS_CLIENTS} clients authenticated`);
    if (closedEarly) failures.push(`ws: ${closedEarly} connections closed by the server`);
    if (pct(sorted, 95) > P95_WS_MS) failures.push(`ws: fan-out p95 ${fmt(pct(sorted, 95))} ms > ${P95_WS_MS} ms`);
    if (!received) failures.push('ws: no events received');
    const [pt] = await sqlClient`select count(*) filter (where status in ('pending','scheduled','running'))::int as open, count(*)::int as total
      from publish_tasks where user_id = any(${users.map((u) => u.id)}::uuid[]) and created_at > ${new Date(r.t0).toISOString()}::timestamptz`;
    console.log(`publish rounds created during ws: ${pt!.total}, still unfinished 3 s later: ${pt!.open}`);
    // backlog of the publish queue (worker concurrency 4): how long until every round of the run has ended
    const tDrain = Date.now();
    let open = pt!.open as number;
    while (open > 0 && Date.now() - tDrain < 300_000) {
      await sleep(1000);
      [{ open }] = await sqlClient`select count(*)::int as open from publish_tasks where user_id = any(${users.map((u) => u.id)}::uuid[])
        and status in ('pending','scheduled','running')` as unknown as [{ open: number }];
    }
    const drain = (Date.now() - tDrain) / 1000;
    console.log(`publish backlog drained in ${drain.toFixed(0)} s${open ? ` (still ${open} open after 300 s)` : ''}: ≈ ${((pt!.total as number) / ((Date.now() - r.t0) / 1000)).toFixed(1)} rounds/s end to end`);
  }

  // ---------------------------------------------------------------- login burst: the captcha limit must hold
  if (SCENARIOS.has('login')) {
    const r = new Recorder();
    const served = new Map<number, number>();
    let i = 0;
    await Promise.all(Array.from({ length: LOGIN_CONCURRENCY }, async () => {
      while (i < LOGIN_ATTEMPTS) {
        i++;
        const u = rnd(users);
        const minute = Math.floor(Date.now() / 60_000);
        const t = performance.now();
        let cap: CaptchaAnswer | null = null;
        const res = await fetch(`${API}/api/auth/captcha`).catch(() => null);
        const ms = performance.now() - t;
        if (!res) { r.add('GET /api/auth/captcha', 'read', ms, 'error', 'net'); continue; }
        const j = await res.json().catch(() => ({})) as { id?: string; enabled?: boolean; code?: string };
        if (res.status === 429 && j.code === 'auth.captcha_rate_limited') { r.add('GET /api/auth/captcha', 'read', ms, 'expected', '429'); continue; }
        if (!res.ok) { r.add('GET /api/auth/captcha', 'read', ms, 'error', String(res.status)); continue; }
        r.add('GET /api/auth/captcha', 'read', ms, 'ok', '200');
        served.set(minute, (served.get(minute) ?? 0) + 1);
        if (j.enabled === false) cap = null;
        else {
          const s = await storedCaptcha(j.id!);
          cap = s ? { id: j.id!, x: s.x, trail: dragTrail(s.x) } : null;
        }
        await call(r, 'POST /api/auth/login', 'POST', '/api/auth/login', null, { username: u.name, password: pw, ...(cap ? { captcha: cap } : {}) });
      }
    }));
    r.stop();
    report(`login burst: ${LOGIN_ATTEMPTS} attempts at ${LOGIN_CONCURRENCY} concurrent (captcha limit ${CAPTCHA_RATE}/min/IP)`, r);
    const maxServed = Math.max(0, ...served.values());
    console.log(`challenges served per minute window: ${[...served].map(([m, n]) => `${new Date(m * 60_000).toISOString().slice(11, 16)}Z ${n}`).join(', ')}`);
    // the window also counts the challenges of this run's earlier logins (≤ 5) and of anything else from this IP
    if (maxServed > CAPTCHA_RATE) failures.push(`login: ${maxServed} challenges served in one minute > limit ${CAPTCHA_RATE}`);
    const limited = r.stats.get('GET /api/auth/captcha')?.expected ?? 0;
    if (LOGIN_ATTEMPTS > CAPTCHA_RATE + 5 && !limited && served.size === 1) failures.push('login: the captcha limit never answered 429');
  }

  // ---------------------------------------------------------------- soak: low rate, resources must not grow
  if (SCENARIOS.has('soak')) {
    const r = new Recorder();
    const samples: { t: number; rss: number | null; db: number }[] = [];
    const sample = async () => { const x = await resources(); samples.push({ t: Math.round((Date.now() - r.t0) / 1000), rss: x.rss, db: x.db.api ?? x.db.total }); };
    await sample();
    const timer = setInterval(() => void sample(), 10_000);
    let vu = 0;
    await openLoop(SOAK_SEC, SOAK_RPS, () => browseOnce(r, vu++));
    clearInterval(timer);
    await sample();
    r.stop();
    report(`soak: browse mix at ${SOAK_RPS} req/s open loop`, r);
    console.log(`\nsoak samples (t s: RSS MB / API DB connections): ${samples.map((s) => `${s.t}: ${s.rss ? s.rss.toFixed(0) : 'n/a'}/${s.db}`).join(' · ')}`);
    const third = Math.max(1, Math.floor(samples.length / 3));
    const med = (xs: number[]) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
    const rs = samples.map((s) => s.rss).filter((x): x is number => x != null);
    if (rs.length >= 3) {
      const a = med(rs.slice(0, third));
      const b = med(rs.slice(-third));
      console.log(`RSS median first third ${a.toFixed(0)} MB → last third ${b.toFixed(0)} MB`);
      if (b > a + Math.max(64, a * 0.25)) failures.push(`soak: RSS grew ${a.toFixed(0)} → ${b.toFixed(0)} MB`);
    }
    if (samples.at(-1)!.db > samples[0]!.db + 5) failures.push(`soak: DB connections grew ${samples[0]!.db} → ${samples.at(-1)!.db}`);
  }
} catch (err) {
  console.error('load-check aborted:', err);
  exitCode = 1;
} finally {
  const after = await resources().catch(() => null);
  console.log(`\nresources before → after: RSS ${before.rss?.toFixed(0) ?? 'n/a'} → ${after?.rss?.toFixed(0) ?? 'n/a'} MB, API Postgres connections ${before.db.api ?? 'n/a'} → ${after?.db.api ?? 'n/a'}, all connections to the DB ${before.db.total} → ${after?.db.total ?? 'n/a'}`);
  if (!KEEP) {
    await sleep(2000); // last publish rounds / echo tasks finish
    await cleanupLoad(tag, users.map((u) => u.id), adminRow!.id).catch((e) => console.error('cleanup failed:', e));
    console.log(`cleanup: run ${tag} removed`);
  } else console.log(`LOAD_KEEP=1: run ${tag} kept`);
  await closeTaskQueues().catch(() => undefined);
  await events.close().catch(() => undefined);
  await sqlClient.end({ timeout: 5 });
}

if (failures.length) {
  console.log(`\nFAILED (${failures.length}):\n${failures.map((f) => `- ${f}`).join('\n')}`);
  exitCode = 1;
} else if (!exitCode) console.log('\nPASSED: error rate ≤ 1 %, p95 within limits, no growth in the soak');
process.exit(exitCode);
