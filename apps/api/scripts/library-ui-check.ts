/**
 * App library page (应用库): install targets, batch install, install log. Real API + DB + adb, no mocks.
 *
 *   E2E_API=http://127.0.0.1:3290 API_PORT=3290 npx tsx --env-file=../../.env scripts/library-ui-check.ts <org.fdroid.fdroid.apk> [--bit]
 *
 * No phone: upload → `GET /api/library/:id/targets` on inert external rows of THIS API's DB (scripts/lib/placeholder.ts:
 * a device source with an invalid config, so the monitor skips them and never opens a tunnel or powers anything):
 * stopped / restarting / running without adb / running with nothing listening on its adb port (live read fails → offline);
 * granted usernames per device; batch install validation (400/404, skipped codes); the library is admin only (2026-11-18):
 * a user, even with grants, gets 403 on every /api/library* route (list, targets, logs, install, import, upload,
 * delete); the removed PATCH (预装 flag, gone with redroid on 2026-11-20) is 404; a failed install on the dead row and
 * a system install row (no operator) in the install log, an unrelated upload install not listed. `--bit` adds a row for
 * the BitBrowser phone (adb 5700, must be attached by the main API) that is ONLY read (`dumpsys package` of the library
 * package): it is never installed on. A real install on a phone (installing / installed / update states) is not
 * covered any more: local test devices were removed with redroid.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { db, schema } from '../src/db/index.js';
import { adb } from '../src/services.js';
import { withCaptcha } from './lib/login.js';
import { placeholders, type PlaceholderRow } from './lib/placeholder.js';

const API = process.env.E2E_API ?? `http://127.0.0.1:${process.env.API_PORT ?? 3000}`;
const apk = process.argv[2];
if (!apk || apk.startsWith('--')) throw new Error('usage: library-ui-check.ts <test.apk> [--bit]');
const BIT_PORT = Number(process.env.BIT_ADB_PORT ?? 5700);
const tag = Date.now().toString(36).slice(-5);
const results: [string, 'pass' | 'fail' | 'skip'][] = [];
const check = (n: string, ok: boolean, d = '') => { results.push([n, ok ? 'pass' : 'fail']); console.log(`${ok ? '✓' : '✗'} ${n}${d ? ` — ${d}` : ''}`); };
const skip = (n: string, why: string) => { results.push([n, 'skip']); console.log(`- ${n} — skipped: ${why}`); };
async function http<T = any>(method: string, path: string, token: string, body?: unknown) {
  const isForm = body instanceof FormData;
  const res = await fetch(API + path, { method, headers: { authorization: `Bearer ${token}`, ...(body !== undefined && !isForm ? { 'content-type': 'application/json' } : {}) }, body: isForm ? body : body !== undefined ? JSON.stringify(body) : undefined });
  return { status: res.status, body: (await res.json().catch(() => null)) as T };
}
async function waitFor<T>(label: string, fn: () => Promise<T | null | false | undefined>, ms = 240_000): Promise<T> {
  const t0 = Date.now();
  for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() - t0 > ms) throw new Error(`timeout: ${label}`); await new Promise((r) => setTimeout(r, 1500)); }
}
const login = async (username: string, password: string): Promise<string> =>
  (await (await fetch(`${API}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(await withCaptcha(API, { username, password })) })).json()).token;
const T = await login(process.env.ADMIN_USERNAME!, process.env.ADMIN_PASSWORD!);
const taskDone = (token: string, id: string) => waitFor('task', async () => {
  const t = (await http('GET', `/api/tasks/${id}`, token)).body?.task;
  return t && ['success', 'failed', 'cancelled'].includes(t.status) ? t : null;
});
const targets = async (token: string, libId: string) => http<{ devices: any[] }>('GET', `/api/library/${libId}/targets`, token);
const byName = (devs: any[], name: string) => devs.find((d) => d.name === name);

let libId = '';
const ph = placeholders('libui');
const fixtureRows: string[] = [], fixtureTasks: string[] = [], userIds: string[] = [];
try {
  // ---- library entry
  const fd = new FormData(); fd.append('file', new Blob([fs.readFileSync(apk)]), 'test.apk');
  const up = await http('POST', '/api/library/upload', T, fd);
  if (up.status !== 200) throw new Error(`upload failed: ${up.status} ${up.body?.error}`);
  const lib = up.body.app; libId = lib.id;
  check('library entry uploaded', !!libId, `${lib.package} ${lib.versionName} (${lib.versionCode})`);

  // ---- users: U (operator, grants), U2 (no grants)
  const mk = async (n: string) => {
    const r = await http('POST', '/api/users', T, { username: n, password: 'test-pass-123', role: 'user' });
    userIds.push(r.body.user.id); return { id: r.body.user.id as string, token: await login(n, 'test-pass-123'), name: n };
  };
  const U = await mk(`libui${tag}a`), U2 = await mk(`libui${tag}b`);

  // ---- inert external rows (this DB only; invalid source config → skipped by the external monitor)
  const row = async (name: string, v: Omit<PlaceholderRow, 'name'>) => {
    const [r] = await ph.insert({ name: `libui-${name}-${tag}`, ...v });
    fixtureRows.push(r!.id); return r!;
  };
  const off = await row('off', { adbPort: 5551, status: 'stopped' });
  const busy = await row('busy', { adbPort: 5552, status: 'restarting' });
  const dead = await row('dead', { adbPort: 5553, status: 'running', adbState: 'device', bootCompleted: true });
  const noadb = await row('noadb', { adbPort: 5554, status: 'running', adbState: null });
  let bit: typeof off | null = null;
  if (process.argv.includes('--bit')) {
    const st = (await adb.states()).get(adb.serialFor(BIT_PORT));
    if (st === 'device') bit = await row('bit', { adbPort: BIT_PORT, status: 'running', adbState: 'device', bootCompleted: true });
    else skip('read-only probe of the BitBrowser phone', `${adb.serialFor(BIT_PORT)} ${st ?? 'absent'}`);
  }
  let r = await http('PUT', `/api/users/${U.id}/grants`, T, { instanceIds: [off.id, dead.id] });
  check('grants set (U: off + dead)', r.status === 200);

  // ---- targets: admin
  let t0 = Date.now();
  r = await targets(T, libId);
  const ms = Date.now() - t0;
  const A = r.body?.devices ?? [];
  check('admin: targets list every device of this DB', r.status === 200 && fixtureRows.every((id) => A.some((d: any) => d.id === id)), `${A.length} devices, ${ms} ms`);
  check('admin: granted usernames per device (one grouped query)', byName(A, off.name)?.users?.join() === U.name && byName(A, dead.name)?.users?.join() === U.name && Array.isArray(byName(A, busy.name)?.users) && byName(A, busy.name).users.length === 0);
  check('stopped → offline (reason = status)', byName(A, off.name)?.state === 'offline' && byName(A, off.name)?.reason === 'stopped');
  check('restarting → busy', byName(A, busy.name)?.state === 'busy' && byName(A, busy.name)?.reason === 'restarting');
  check('running without adb → offline (adb)', byName(A, noadb.name)?.state === 'offline' && byName(A, noadb.name)?.reason === 'adb');
  check('running but nothing on its adb port → live read fails → offline (probe), bounded time', byName(A, dead.name)?.state === 'offline' && byName(A, dead.name)?.reason === 'probe' && ms < 12_000, `${ms} ms`);
  if (bit) {
    const direct = await adb.packageVersion(BIT_PORT, lib.package);
    const b = byName(A, bit.name);
    const expect = !direct ? 'installable' : BigInt(direct.versionCode) >= BigInt(lib.versionCode) ? 'installed' : 'update';
    check('BitBrowser phone (read only): state matches a direct dumpsys read', b?.state === expect && (b?.installed?.versionCode ?? null) === (direct?.versionCode ?? null), `${b?.state}, installed ${direct ? direct.versionCode : 'none'}`);
  }

  // ---- users: admin only (2026-11-18), also for a user with grants on the devices
  const userCalls: [string, string, unknown?][] = [
    ['GET', '/api/library'], ['GET', `/api/library/${libId}/targets`], ['GET', `/api/library/${libId}/logs`],
    ['POST', `/api/library/${libId}/install`, { instanceIds: [dead.id] }], ['POST', '/api/library/import', { instanceId: dead.id, package: lib.package }],
    ['DELETE', `/api/library/${libId}`],
  ];
  for (const who of [U, U2]) {
    const res = await Promise.all(userCalls.map(([m, p, b]) => http(m, p, who.token, b)));
    const upFd = new FormData(); upFd.append('file', new Blob([fs.readFileSync(apk)]), 'user.apk');
    const upU = await http('POST', '/api/library/upload', who.token, upFd);
    const bad = [...userCalls.map(([m, p], i) => [`${m} ${p}`, res[i]!] as const), ['POST /api/library/upload', upU] as const].filter(([, x]) => x.status !== 403 || x.body?.code !== 'auth.admin_only');
    check(`${who === U ? 'user with grants' : 'user without grants'}: 403 auth.admin_only on all 7 library routes`, !bad.length, bad.map(([k, x]) => `${k}=${x.status}`).join(', '));
  }
  const lst = (await http('GET', '/api/library', T)).body.apps.find((x: any) => x.id === libId);
  check('library entry untouched by the refused user calls (no preinstall field any more)', !!lst && !('preinstall' in lst));
  r = await http('PATCH', `/api/library/${libId}`, T, { preinstall: true });
  check('the removed PATCH /api/library/:id (预装) → 404', r.status === 404, String(r.status));
  r = await targets(T, randomUUID());
  check('unknown library id → 404 library.not_found', r.status === 404 && r.body?.code === 'library.not_found');

  // ---- batch install validation (never on the BitBrowser row)
  r = await http('POST', `/api/library/${libId}/install`, T, { instanceIds: [] });
  check('empty selection → 400', r.status === 400);
  r = await http('POST', `/api/library/${libId}/install`, T, { instanceIds: Array.from({ length: 101 }, () => randomUUID()) });
  check('more than 100 devices → 400', r.status === 400);
  r = await http('POST', `/api/library/${randomUUID()}/install`, T, { instanceIds: [off.id] });
  check('unknown library id → 404', r.status === 404 && r.body?.code === 'library.not_found');
  const ghost = randomUUID();
  r = await http('POST', `/api/library/${libId}/install`, T, { instanceIds: [off.id, busy.id, ghost, off.id] });
  const codes = (r.body?.skipped ?? []).map((s: any) => `${s.code}`).sort();
  check('admin batch: one request, duplicates merged, coded skips', r.status === 202 && r.body.accepted.length === 0 && codes.join() === 'instances.not_found,instances.not_running,instances.not_running', codes.join());
  r = await http('POST', `/api/library/${libId}/install`, T, { instanceIds: [dead.id] });
  check('admin: install on a running device accepted', r.status === 202 && r.body.accepted.length === 1);
  const failedTask = await taskDone(T, r.body.accepted[0].taskId);
  check('install on the dead row fails (adb)', failedTask.status === 'failed', failedTask.error);
  check('new task carries refType library_app + refId + payload.library (no preinstall flag)', failedTask.refType === 'library_app' && failedTask.refId === libId && failedTask.payload?.library?.versionCode === lib.versionCode && !('preinstall' in failedTask.payload.library));

  // an install task row of the system (no operator)
  const [pre] = await db.insert(schema.tasks).values({
    type: 'install-apk', instanceId: off.id, instanceName: `${off.name} · ${lib.package} ${lib.versionName}`, status: 'success',
    refType: 'library_app', refId: libId, payload: { library: { package: lib.package, versionCode: lib.versionCode, versionName: lib.versionName } },
    createdBy: null, finishedAt: new Date(),
  }).returning();
  fixtureTasks.push(pre!.id);
  // an unrelated upload install of the same device must not match
  const [other] = await db.insert(schema.tasks).values({ type: 'install-apk', instanceId: off.id, instanceName: off.name, status: 'success', payload: { apkPaths: ['/tmp/x/0-base.apk'], sizes: [1] } }).returning();
  fixtureTasks.push(other!.id);

  // ---- install log
  r = await http('GET', `/api/library/${libId}/logs`, T);
  const items = r.body?.items ?? [];
  const f = items.find((x: any) => x.taskId === failedTask.id);
  const l = items.find((x: any) => x.taskId === pre!.id);
  check('admin log: failed install with device, operator, version, error', !!f && f.status === 'failed' && f.instanceName === dead.name && f.operator === process.env.ADMIN_USERNAME && f.versionCode === lib.versionCode && f.versionName === lib.versionName && !!f.error && !('preinstall' in f) && f.deviceExists === true, f ? `${f.instanceName} · ${f.operator} · ${f.error}` : 'missing');
  check('admin log: system install row (version from payload.library, no operator)', !!l && l.versionCode === lib.versionCode && l.operator === null && l.instanceName === off.name);
  check('admin log: upload installs outside the library are not listed', !items.some((x: any) => x.taskId === other!.id) && r.body.total === items.length);
  r = await http('GET', `/api/library/${libId}/logs?limit=1&offset=1`, T);
  check('log paging (limit/offset, total)', r.status === 200 && r.body.items.length === 1 && r.body.total >= 2);

} catch (err) {
  check(`unexpected error: ${(err as Error).message}`, false);
} finally {
  if (fixtureTasks.length) await db.delete(schema.tasks).where(inArray(schema.tasks.id, fixtureTasks));
  // Inert rows are removed directly (a delete op would adb-disconnect ports the main API uses).
  if (fixtureRows.length) {
    await db.delete(schema.tasks).where(and(eq(schema.tasks.type, 'install-apk'), inArray(schema.tasks.instanceId, fixtureRows)));
    await db.delete(schema.instances).where(inArray(schema.instances.id, fixtureRows));
  }
  await ph.cleanup();
  for (const id of userIds) await http('DELETE', `/api/users/${id}`, T);
  if (libId) { const d = await http('DELETE', `/api/library/${libId}`, T); check('cleanup: library entry removed', d.status === 204); }
  const n = (s: string) => results.filter((x) => x[1] === s).length;
  console.log(`\n${n('pass')} passed, ${n('fail')} failed, ${n('skip')} skipped`);
  process.exit(n('fail') ? 1 : 0);
}
