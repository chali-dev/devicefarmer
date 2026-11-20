/**
 * App library test (real API, no mocks, no phone): upload an APK into the library (admin only, package and version
 * read from the manifest), re-upload replaces, junk refused, a user gets 403 on every /api/library* route, the removed
 * 预装 PATCH is 404, audit. Import / install against an inert placeholder phone (scripts/lib/placeholder.ts: running +
 * adb device in the DB, nothing listens on its adb port) are accepted as tasks and fail on adb. An import from a real
 * phone (byte-identical base.apk) needs one and is not covered any more: local test devices went with redroid
 * (2026-11-20); library-ui-check.ts --bit reads the BitBrowser phone read only.
 * Usage: npx tsx --env-file=../../.env scripts/library-check.ts <test.apk>   (E2E_API / API_PORT for another API)
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { inArray } from 'drizzle-orm';
import { db, schema, sqlClient } from '../src/db/index.js';
import { withCaptcha } from './lib/login.js';
import { placeholders } from './lib/placeholder.js';

const API = process.env.E2E_API ?? `http://127.0.0.1:${process.env.API_PORT ?? 3000}`;
const apk = process.argv[2];
if (!apk) throw new Error('usage: library-check.ts <test.apk>');
const PKG = 'org.fdroid.fdroid';
const results: [string, boolean][] = [];
const check = (n: string, ok: boolean, d = '') => { results.push([n, ok]); console.log(`${ok ? '✓' : '✗'} ${n}${d ? ` — ${d}` : ''}`); };
async function http<T = any>(method: string, path: string, token: string, body?: unknown) {
  const isForm = body instanceof FormData;
  const res = await fetch(API + path, { method, headers: { authorization: `Bearer ${token}`, ...(body !== undefined && !isForm ? { 'content-type': 'application/json' } : {}) }, body: isForm ? body : body !== undefined ? JSON.stringify(body) : undefined });
  return { status: res.status, body: (await res.json().catch(() => null)) as T };
}
async function waitFor<T>(label: string, fn: () => Promise<T | null | false | undefined>, ms = 240_000): Promise<T> {
  const t0 = Date.now();
  for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() - t0 > ms) throw new Error(`timeout: ${label}`); await new Promise((r) => setTimeout(r, 2000)); }
}
const T: string = (await (await fetch(`${API}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(await withCaptcha(API, { username: process.env.ADMIN_USERNAME, password: process.env.ADMIN_PASSWORD })) })).json()).token;
const task = (id: string) => waitFor('task', async () => {
  const t = (await http('GET', '/api/tasks?limit=200', T)).body.tasks.find((x: any) => x.id === id);
  return t && ['success', 'failed'].includes(t.status) ? t : null;
});

let libId = '';
const ph = placeholders('libchk');
try {
  // ---- upload (no device needed)
  const upload = (token: string, bytes: Buffer, name: string) => { const fd = new FormData(); fd.append('file', new Blob([bytes]), name); return http('POST', '/api/library/upload', token, fd); };
  const apkBytes = fs.readFileSync(apk);
  let up = await upload(T, apkBytes, 'some-name.apk');
  const u = up.body?.app;
  check('admin uploads an APK into the library', up.status === 200 && u?.package === PKG && /^\d+$/.test(u.versionCode), `${u?.package} ${u?.versionName} (${u?.versionCode})`);
  check('uploaded entry: one base APK, sha256 of the file, source upload:<admin>',
    u?.files.length === 1 && u.files[0].sha256 === createHash('sha256').update(apkBytes).digest('hex') && u.sourceInstance === `upload:${process.env.ADMIN_USERNAME}`);
  up = await upload(T, apkBytes, 'again.apk');
  check('re-upload of the same version replaces the entry (same id)', up.status === 200 && up.body.app.id === u.id);
  up = await upload(T, Buffer.from('not a zip at all'), 'junk.apk');
  check('junk .apk refused with library.bad_apk', up.status === 400 && up.body?.code === 'library.bad_apk', up.body?.error);
  up = await upload(T, Buffer.from('hello'), 'notes.txt');
  check('other file types refused', up.status === 400 && up.body?.code === 'apps.unsupported_type');
  const uname = `libup${Date.now() % 1e6}`;
  const cu = await http('POST', '/api/users', T, { username: uname, password: 'test-pass-123', role: 'user' });
  const UT: string = (await (await fetch(`${API}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(await withCaptcha(API, { username: uname, password: 'test-pass-123' })) })).json()).token;
  up = await upload(UT, apkBytes, 'user.apk');
  check('non-admin upload refused (403 auth.admin_only)', up.status === 403 && up.body?.code === 'auth.admin_only');
  // The whole library is admin only (2026-11-18): list, targets, logs, install, import, delete.
  const userRes = await Promise.all(([
    ['GET', '/api/library'], ['GET', `/api/library/${u.id}/targets`], ['GET', `/api/library/${u.id}/logs`],
    ['POST', `/api/library/${u.id}/install`, { instanceIds: [crypto.randomUUID()] }], ['POST', '/api/library/import', { instanceId: crypto.randomUUID(), package: PKG }],
    ['DELETE', `/api/library/${u.id}`],
  ] as [string, string, unknown?][]).map(([m, p, b]) => http(m, p, UT, b).then((x) => [`${m} ${p}`, x.status] as const)));
  check('non-admin gets 403 on every other library route', userRes.every(([, st]) => st === 403), userRes.filter(([, st]) => st !== 403).map(([k, st]) => `${k}=${st}`).join(', '));
  await http('DELETE', `/api/users/${cu.body.user.id}`, T);
  const pr = await http('PATCH', `/api/library/${u.id}`, T, { preinstall: true });
  check('the removed 预装 PATCH /api/library/:id → 404', pr.status === 404, String(pr.status));
  // audit writes are fire-and-forget: poll briefly
  const audited = await waitFor('audit entry', async () => ((await http('GET', '/api/audit?action=library.upload&pageSize=5', T)).body?.items ?? []).find((e: any) => String(e.target ?? '').startsWith(PKG)), 10_000).catch(() => null);
  check('upload is in the audit log with package as target', !!audited, audited?.target);
  const d0 = await http('DELETE', `/api/library/${u.id}`, T);
  check('uploaded entry deleted', d0.status === 204 && !fs.existsSync(`var/library/${PKG}/${u.versionCode}`));

  // ---- import / install against an inert placeholder phone: accepted, then fail on adb (nothing listens)
  const [dev] = await ph.insert({ name: `libchk-${Date.now() % 1e6}`, adbPort: 5579, status: 'running', adbState: 'device', bootCompleted: true });
  up = await upload(T, apkBytes, 'again.apk');
  libId = up.body.app.id;
  let r = await http('POST', '/api/library/import', T, { instanceId: dev!.id, package: PKG });
  const ti = r.status === 202 ? await task(r.body.taskId) : null;
  check('import from an unreachable phone: task accepted, fails cleanly', r.status === 202 && ti?.status === 'failed' && ti.type === 'import-app', `${r.status} ${ti?.status} ${ti?.error ?? ''}`);
  r = await http('POST', `/api/library/${libId}/install`, T, { instanceIds: [dev!.id] });
  const tl = r.status === 202 && r.body.accepted.length === 1 ? await task(r.body.accepted[0].taskId) : null;
  check('install from the library onto an unreachable phone: one task, fails cleanly, device not marked error',
    tl?.status === 'failed' && tl.refType === 'library_app' && tl.refId === libId
    && (await http('GET', `/api/instances/${dev!.id}`, T)).body.instance?.status === 'running', `${r.status} ${tl?.status} ${tl?.error ?? ''}`);
  await db.delete(schema.tasks).where(inArray(schema.tasks.instanceId, [dev!.id]));
} catch (err) {
  check(`unexpected error: ${(err as Error).message}`, false);
} finally {
  await ph.cleanup().catch((e) => console.log(`cleanup placeholder: ${e}`));
  if (libId) {
    const d = await http('DELETE', `/api/library/${libId}`, T);
    check('library entry and files removed', d.status === 204 && !fs.existsSync(`var/library/${PKG}`) || (fs.existsSync(`var/library/${PKG}`) && fs.readdirSync(`var/library/${PKG}`).length === 0));
  }
  const failed = results.filter((x) => !x[1]).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  await sqlClient.end();
  process.exit(failed ? 1 : 0);
}
