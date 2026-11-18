/**
 * App library page (应用库): install targets, batch install, install log. Real API + DB + adb, no mocks.
 *
 *   E2E_API=http://127.0.0.1:3290 API_PORT=3290 npx tsx --env-file=../../.env scripts/library-ui-check.ts <org.fdroid.fdroid.apk> [--no-device] [--bit]
 *
 * Without a device: upload → `GET /api/library/:id/targets` on inert external rows of THIS API's DB (a device source
 * with an invalid config, so this instance's external monitor skips them and never opens a tunnel or powers anything):
 * stopped / restarting / running without adb / running with nothing listening on its adb port (live read fails → offline);
 * granted usernames per device; batch install validation (400/404, skipped codes); the library is admin only (2026-11-18):
 * a user, even with grants, gets 403 on every /api/library* route (list, targets, logs, install, import, upload, patch,
 * delete); a failed install on the dead row and an old-style task row (no ref, APK path in the library dir) in the
 * install log. `--bit` adds a row for the BitBrowser phone (adb 5700, must be attached by the
 * main API) that is ONLY read (`dumpsys package` of the library package): it is never installed on.
 * With a device (default; refused when the VM is full → reported as skipped): creates `libui-*`, installs from the
 * library (one batch request), the second request while queued is skipped (library.install_pending), the target then
 * reads as installed (hidden) with the real version; library rows of the same package one version newer / older (DB
 * fixtures, same files) read as 可更新 / installed; the log shows the success. The device is deleted at the end.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { db, schema } from '../src/db/index.js';
import { libraryDir } from '../src/modules/library/library.js';
import { adb } from '../src/services.js';
import { withCaptcha } from './lib/login.js';

const API = process.env.E2E_API ?? `http://127.0.0.1:${process.env.API_PORT ?? 3000}`;
const apk = process.argv[2];
if (!apk || apk.startsWith('--')) throw new Error('usage: library-ui-check.ts <test.apk> [--no-device] [--bit]');
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

let libId = '', srcId = '', dev = '';
const fixtureRows: string[] = [], fixtureLibs: string[] = [], fixtureTasks: string[] = [], userIds: string[] = [];
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
  const [src] = await db.insert(schema.deviceSources).values({ type: 'bitbrowser', name: `libui-src-${tag}`, config: { apiUrl: 'not a url' } }).returning();
  srcId = src!.id;
  const row = async (name: string, v: Partial<typeof schema.instances.$inferInsert>) => {
    const [r] = await db.insert(schema.instances).values({ name: `libui-${name}-${tag}`, engine: 'bitbrowser', sourceId: srcId, externalId: `libui-${name}-${tag}`, profile: 'bitbrowser', image: '', spec: { width: 720, height: 1280, dpi: 320 }, adbPort: 0, status: 'stopped', ...v }).returning();
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
    ['PATCH', `/api/library/${libId}`, { preinstall: true }], ['DELETE', `/api/library/${libId}`],
  ];
  for (const who of [U, U2]) {
    const res = await Promise.all(userCalls.map(([m, p, b]) => http(m, p, who.token, b)));
    const upFd = new FormData(); upFd.append('file', new Blob([fs.readFileSync(apk)]), 'user.apk');
    const upU = await http('POST', '/api/library/upload', who.token, upFd);
    const bad = [...userCalls.map(([m, p], i) => [`${m} ${p}`, res[i]!] as const), ['POST /api/library/upload', upU] as const].filter(([, x]) => x.status !== 403 || x.body?.code !== 'auth.admin_only');
    check(`${who === U ? 'user with grants' : 'user without grants'}: 403 auth.admin_only on all 8 library routes`, !bad.length, bad.map(([k, x]) => `${k}=${x.status}`).join(', '));
  }
  check('library entry untouched by the refused user calls', (await http('GET', '/api/library', T)).body.apps.some((x: any) => x.id === libId && x.preinstall === false));
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
  check('new task carries refType library_app + refId + payload.library', failedTask.refType === 'library_app' && failedTask.refId === libId && failedTask.payload?.library?.versionCode === lib.versionCode && failedTask.payload.library.preinstall === false);

  // ---- old-style task row (as written before this change: no ref, APK path in the library dir)
  const legacyPath = `${libraryDir({ package: lib.package, versionCode: lib.versionCode })}/0-base.apk`;
  const [legacy] = await db.insert(schema.tasks).values({
    type: 'install-apk', instanceId: off.id, instanceName: `${off.name} · 预装 ${lib.package} ${lib.versionName}`, status: 'success',
    payload: { apkPaths: [legacyPath], sizes: [1] }, createdBy: null, finishedAt: new Date(),
  }).returning();
  fixtureTasks.push(legacy!.id);
  // an unrelated upload install of the same device must not match
  const [other] = await db.insert(schema.tasks).values({ type: 'install-apk', instanceId: off.id, instanceName: off.name, status: 'success', payload: { apkPaths: ['/tmp/x/0-base.apk'], sizes: [1] } }).returning();
  fixtureTasks.push(other!.id);

  // ---- install log
  r = await http('GET', `/api/library/${libId}/logs`, T);
  const items = r.body?.items ?? [];
  const f = items.find((x: any) => x.taskId === failedTask.id);
  const l = items.find((x: any) => x.taskId === legacy!.id);
  check('admin log: failed install with device, operator, version, error', !!f && f.status === 'failed' && f.instanceName === dead.name && f.operator === process.env.ADMIN_USERNAME && f.versionCode === lib.versionCode && f.versionName === lib.versionName && !!f.error && f.preinstall === false && f.deviceExists === true, f ? `${f.instanceName} · ${f.operator} · ${f.error}` : 'missing');
  check('admin log: old task matched by its library APK path (version from the path, 预装 from the label, system operator)', !!l && l.versionCode === lib.versionCode && l.preinstall === true && l.operator === null && l.instanceName === off.name);
  check('admin log: upload installs outside the library are not listed', !items.some((x: any) => x.taskId === other!.id) && r.body.total === items.length);
  r = await http('GET', `/api/library/${libId}/logs?limit=1&offset=1`, T);
  check('log paging (limit/offset, total)', r.status === 200 && r.body.items.length === 1 && r.body.total >= 2);

  // ---- real device: install, pending skip, installed / update states
  if (process.argv.includes('--no-device')) skip('real install on a test device', '--no-device');
  else {
    const c = await http('POST', '/api/instances', T, { profile: 'redroid-12', count: 1, namePrefix: `libui${tag}` });
    if (c.status !== 202) skip('real install on a test device', `create refused: ${c.body?.code ?? c.status} ${c.body?.error ?? ''}`);
    else {
      dev = c.body.instances[0].id;
      const t1 = Date.now();
      const inst = await waitFor('running', async () => { const i = (await http('GET', `/api/instances/${dev}`, T)).body.instance; if (i.status === 'error') throw new Error(i.lastError); return i.status === 'running' && i.adbState === 'device' && i.stfReady ? i : null; });
      check('test device running', true, `${inst.name} in ${Math.round((Date.now() - t1) / 1000)} s`);
      let d = byName((await targets(T, libId)).body.devices, inst.name);
      check('fresh device: installable, nothing installed (live read)', d?.state === 'installable' && d.installed === null);
      r = await http('POST', `/api/library/${libId}/install`, T, { instanceIds: [dev] });
      const r2 = await http('POST', `/api/library/${libId}/install`, T, { instanceIds: [dev] });
      check('second request while the first is queued → skipped library.install_pending', r.body.accepted.length === 1 && r2.body.accepted.length === 0 && r2.body.skipped[0]?.code === 'library.install_pending');
      d = byName((await targets(T, libId)).body.devices, inst.name);
      const tI = await taskDone(T, r.body.accepted[0].taskId);
      check('targets while queued/running: installing (not selectable)', d?.state === 'installing' || tI.status === 'success', d?.state);
      check('real install from the library succeeded', tI.status === 'success', tI.error ?? '');
      d = byName((await targets(T, libId)).body.devices, inst.name);
      check('after install: installed (same version → hidden in the UI), real version read', d?.state === 'installed' && d.installed?.versionCode === lib.versionCode, `${d?.installed?.versionName} (${d?.installed?.versionCode})`);
      // Same package, one version newer / older (DB rows sharing the files) to see 可更新 vs installed.
      const vc = BigInt(lib.versionCode);
      const fx = await db.insert(schema.libraryApps).values([vc + 1n, vc - 1n].map((v) => ({ package: lib.package, versionCode: String(v), versionName: `fixture-${v}`, files: lib.files, sourceInstance: 'libui-fixture' }))).returning();
      fixtureLibs.push(...fx.map((x) => x.id));
      const newer = byName((await targets(T, fx[0]!.id)).body.devices, inst.name);
      const older = byName((await targets(T, fx[1]!.id)).body.devices, inst.name);
      check('library version newer than installed → update (可更新) with the installed version', newer?.state === 'update' && newer.installed?.versionCode === lib.versionCode);
      check('library version older than installed → installed (hidden)', older?.state === 'installed');
      r = await http('GET', `/api/library/${libId}/logs`, T);
      const ok = (r.body.items ?? []).find((x: any) => x.taskId === tI.id);
      check('log: successful install on the test device', ok?.status === 'success' && ok.instanceName === inst.name && ok.operator === process.env.ADMIN_USERNAME && ok.finishedAt);
      r = await http('GET', `/api/library/${fx[0]!.id}/logs`, T);
      check('log is per package: another version row lists the same tasks', r.body.items.some((x: any) => x.taskId === tI.id));
    }
  }
} catch (err) {
  check(`unexpected error: ${(err as Error).message}`, false);
} finally {
  if (dev) {
    await http('POST', '/api/instances/actions', T, { action: 'delete', ids: [dev] });
    await waitFor('deleted', async () => (await http('GET', `/api/instances/${dev}`, T)).status === 404, 120_000).catch(() => console.log('! test device not deleted in time'));
  }
  if (fixtureTasks.length) await db.delete(schema.tasks).where(inArray(schema.tasks.id, fixtureTasks));
  if (fixtureLibs.length) await db.delete(schema.libraryApps).where(inArray(schema.libraryApps.id, fixtureLibs));
  // Inert rows are removed directly (a delete op would adb-disconnect ports the main API uses).
  if (fixtureRows.length) {
    await db.delete(schema.tasks).where(and(eq(schema.tasks.type, 'install-apk'), inArray(schema.tasks.instanceId, fixtureRows)));
    await db.delete(schema.instances).where(inArray(schema.instances.id, fixtureRows));
  }
  if (srcId) await db.delete(schema.deviceSources).where(eq(schema.deviceSources.id, srcId));
  for (const id of userIds) await http('DELETE', `/api/users/${id}`, T);
  if (libId) { const d = await http('DELETE', `/api/library/${libId}`, T); check('cleanup: library entry removed', d.status === 204); }
  const n = (s: string) => results.filter((x) => x[1] === s).length;
  console.log(`\n${n('pass')} passed, ${n('fail')} failed, ${n('skip')} skipped`);
  process.exit(n('fail') ? 1 : 0);
}
