/**
 * App library test (real devices, no mocks): upload an APK into the library (admin only, package and
 * version read from the manifest), then import an installed app from instance A, flag it for preinstall,
 * create instance B and verify it was installed automatically.
 * Usage: npx tsx --env-file=../../.env scripts/library-check.ts <test.apk>
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { withCaptcha } from './lib/login.js';

const API = 'http://127.0.0.1:3000';
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
const create = async (prefix: string) => {
  const c = await http('POST', '/api/instances', T, { profile: 'redroid-12', count: 1, namePrefix: prefix });
  if (c.status !== 202) throw new Error(`create failed: ${c.body?.error}`);
  const id = c.body.instances[0].id as string;
  await waitFor('running', async () => { const i = (await http('GET', `/api/instances/${id}`, T)).body.instance; if (i.status === 'error') throw new Error(i.lastError); return i.status === 'running' && i.stfReady; });
  return id;
};
const del = async (id: string) => {
  await http('POST', '/api/instances/actions', T, { action: 'delete', ids: [id] });
  await waitFor('deleted', async () => (await http('GET', `/api/instances/${id}`, T)).status === 404, 120_000);
};
const apps = async (id: string) => (await http('GET', `/api/instances/${id}/apps`, T)).body.apps as any[];

let a = '', b = '', libId = '';
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
  check('non-admin upload refused (403 library.upload_admin_only)', up.status === 403 && up.body?.code === 'library.upload_admin_only');
  await http('DELETE', `/api/users/${cu.body.user.id}`, T);
  // audit writes are fire-and-forget: poll briefly
  const audited = await waitFor('audit entry', async () => ((await http('GET', '/api/audit?action=library.upload&pageSize=5', T)).body?.items ?? []).find((e: any) => String(e.target ?? '').startsWith(PKG)), 10_000).catch(() => null);
  check('upload is in the audit log with package as target', !!audited, audited?.target);
  const d0 = await http('DELETE', `/api/library/${u.id}`, T);
  check('uploaded entry deleted', d0.status === 204 && !fs.existsSync(`var/library/${PKG}/${u.versionCode}`));

  a = await create('liba');
  const fd = new FormData(); fd.append('instanceIds', JSON.stringify([a])); fd.append('file', new Blob([fs.readFileSync(apk)]), 'test.apk');
  const inst = await http('POST', '/api/apps/install', T, fd);
  check('install test app on A', (await task(inst.body.accepted[0].taskId)).status === 'success');
  const verA = (await apps(a)).find((x) => x.package === PKG);

  let r = await http('POST', '/api/library/import', T, { instanceId: a, package: PKG });
  const t1 = await task(r.body.taskId);
  check('import installed app from A into library', t1.status === 'success', t1.error ?? '');
  let lib = (await http('GET', '/api/library', T)).body.apps.filter((x: any) => x.package === PKG);
  check('library entry has version, files and sha256', lib.length === 1 && lib[0].versionCode === verA.versionCode && lib[0].files.every((f: any) => /^[0-9a-f]{64}$/.test(f.sha256)),
    `${lib[0]?.versionName} (${lib[0]?.versionCode}), ${lib[0]?.files.length} file(s), ${(lib[0]?.files.reduce((s: number, f: any) => s + f.size, 0) / 1048576).toFixed(1)} MB`);
  libId = lib[0].id;
  const apkSha = (await import('node:crypto')).createHash('sha256').update(fs.readFileSync(apk)).digest('hex');
  check('pulled base.apk is byte-identical to the installed package', lib[0].files[0].sha256 === apkSha);

  r = await http('POST', '/api/library/import', T, { instanceId: a, package: PKG });
  await task(r.body.taskId);
  lib = (await http('GET', '/api/library', T)).body.apps.filter((x: any) => x.package === PKG);
  check('re-import of same version is idempotent', lib.length === 1);

  r = await http('PATCH', `/api/library/${libId}`, T, { preinstall: true });
  check('flag for preinstall', r.status === 200 && r.body.app.preinstall === true);
  const imp = await http('POST', '/api/library/import', T, { instanceId: a, package: 'com.example.notinstalled' });
  const tbad = await task(imp.body.taskId);
  check('import of a package that is not installed fails cleanly', tbad.status === 'failed', tbad.error);
  await del(a); a = '';

  b = await create('libb');
  const pre = await waitFor('preinstall task', async () => {
    const t = (await http('GET', '/api/tasks?limit=50', T)).body.tasks.find((x: any) => x.instanceId === b && x.type === 'install-apk');
    return t && ['success', 'failed'].includes(t.status) ? t : null;
  }, 120_000);
  check('new instance got a preinstall task', pre.status === 'success', pre.instanceName);
  const onB = (await apps(b)).find((x) => x.package === PKG);
  check('preinstalled app present on B with the same version', !!onB && onB.versionCode === verA.versionCode, onB?.versionName ?? 'missing');

  r = await http('POST', `/api/library/${libId}/install`, T, { instanceIds: [b] });
  check('install from library onto existing instance (update path)', (await task(r.body.accepted[0].taskId)).status === 'success');
} catch (err) {
  check(`unexpected error: ${(err as Error).message}`, false);
} finally {
  for (const id of [a, b]) if (id) await del(id).catch(() => undefined);
  if (libId) {
    const d = await http('DELETE', `/api/library/${libId}`, T);
    check('library entry and files removed', d.status === 204 && !fs.existsSync(`var/library/${PKG}`) || (fs.existsSync(`var/library/${PKG}`) && fs.readdirSync(`var/library/${PKG}`).length === 0));
  }
  const failed = results.filter((x) => !x[1]).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}
