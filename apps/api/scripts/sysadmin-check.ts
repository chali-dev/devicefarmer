/**
 * System management (系统管理) test against the real API + DB + storage + pg_dump (no mocks):
 * - Database backups: back up now → file in the storage backend → listed → downloadable (custom-format
 *   magic PGDMP, and `pg_restore --list` through PG_RESTORE_CMD or PG_DUMP_CMD with pg_dump→pg_restore) →
 *   retention keeps N → delete; the daily schedule is idempotent; no DB password in payloads/logs/audit.
 * - System logs: ring + daily file, level/text/time filters, redaction of secret-looking values.
 * - Connection monitoring: status history written by repo.updateInstance (directly and by the monitor)
 *   on placeholder device rows (adb ports 5595–5597, no containers), offline counts, RBAC.
 * - Admin-only routes (a user gets 403) and audit entries.
 * Usage (from apps/api, API running): E2E_API=http://127.0.0.1:3104 npx tsx --env-file=../../.env scripts/sysadmin-check.ts
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { and, eq, gte, inArray, like } from 'drizzle-orm';
import { config } from '../src/config.js';
import { db, schema, sqlClient } from '../src/db/index.js';
import { events } from '../src/lib/events.js';
import { updateInstance } from '../src/modules/instances/repo.js';
import { storageFor } from '../src/modules/settings/storage.js';
import { REDACTED, redactLog } from '../src/modules/system/logs.js';
import { withCaptcha } from './lib/login.js';

const API = process.env.E2E_API ?? 'http://127.0.0.1:3000';
const results: [string, boolean][] = [];
const check = (name: string, ok: boolean, detail = '') => { results.push([name, ok]); console.log(`${ok ? '✓' : '✗'} ${name}${detail && !ok ? ` — ${detail}` : ''}`); };

async function http<T = any>(method: string, p: string, token: string | null, body?: unknown) {
  const res = await fetch(API + p, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const buf = Buffer.from(await res.arrayBuffer());
  let json: any = null;
  try { json = JSON.parse(buf.toString('utf8')); } catch { /* binary / 204 */ }
  return { status: res.status, body: json as T, buf, headers: res.headers };
}
async function login(username: string, password: string): Promise<string> {
  const r = await fetch(`${API}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(await withCaptcha(API, { username, password })) });
  return (await r.json()).token;
}
async function waitFor<T>(label: string, fn: () => Promise<T | null | false | undefined>, ms = 60_000): Promise<T> {
  const t0 = Date.now();
  for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() - t0 > ms) throw new Error(`timeout: ${label}`); await new Promise((r) => setTimeout(r, 500)); }
}
const waitTask = (T: string, id: string) => waitFor(`task ${id}`, async () => {
  const t = (await http('GET', `/api/tasks/${id}`, T)).body?.task;
  return t && ['success', 'failed', 'cancelled'].includes(t.status) ? t : null;
}, 120_000);

/** `pg_restore --list` on a dump (stdin), via PG_RESTORE_CMD or PG_DUMP_CMD with its last word pg_dump → pg_restore. */
async function pgRestoreList(dump: Buffer): Promise<{ ok: boolean; out: string; skipped?: string }> {
  const base = process.env.PG_RESTORE_CMD ?? (/(^|\s)pg_dump$/.test(config.PG_DUMP_CMD.trim()) ? config.PG_DUMP_CMD.trim().replace(/pg_dump$/, 'pg_restore') : null);
  if (!base) return { ok: false, out: '', skipped: 'no pg_restore command derivable' };
  const [cmd, ...args] = base.split(/\s+/);
  return new Promise((resolve) => {
    const child = spawn(cmd!, [...args, '--list'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d: Buffer) => { out += d.toString('utf8'); });
    child.stderr.on('data', (d: Buffer) => { out += d.toString('utf8'); });
    child.on('error', (err) => resolve({ ok: false, out: '', skipped: `${cmd}: ${err.message}` }));
    child.on('close', (code) => resolve({ ok: code === 0, out }));
    child.stdin.end(dump);
  });
}

const T = await login(process.env.ADMIN_USERNAME!, process.env.ADMIN_PASSWORD!);
const tag = randomBytes(3).toString('hex');
const dbPassword = decodeURIComponent(new URL(config.DATABASE_URL).password);
// A password that is part of the user/database name (dev default) can't be searched for on its own:
// then look for the forms it would leak in (URL credentials, PGPASSWORD=…, the DATABASE_URL itself).
const dbUrl = new URL(config.DATABASE_URL);
const distinctive = dbPassword.length >= 4 && !decodeURIComponent(dbUrl.username).includes(dbPassword) && !dbUrl.pathname.includes(dbPassword);
if (!distinctive) console.log('  (DB password is part of the user/db name: checking for URL credentials / PGPASSWORD= instead of the bare value)');
const leaks = (s: string) => (distinctive ? s.includes(dbPassword) : false) || s.includes(config.DATABASE_URL) || s.includes(`:${dbPassword}@`) || /PGPASSWORD=[^\s"]/.test(s);
let userId = '';
const fakeIds: string[] = [];
const backupIds: string[] = [];
const t0 = new Date((await sqlClient`select now() as now`)[0]!.now as Date);
const before = (await http('GET', '/api/system/settings', T)).body?.settings;

try {
  // ---------------------------------------------------------------- setup
  check('admin can read system settings', !!before?.backup, JSON.stringify(before));
  const pw = randomBytes(12).toString('base64url');
  const u = await http('POST', '/api/users', T, { username: `sys${tag}`, password: pw, role: 'user' });
  userId = u.body.user?.id ?? u.body.id;
  const U = await login(`sys${tag}`, pw);

  // ---------------------------------------------------------------- admin only
  const denied = await Promise.all([
    http('GET', '/api/system/settings', U), http('PUT', '/api/system/settings', U, { logRetentionDays: 3 }),
    http('GET', '/api/system/backups', U), http('POST', '/api/system/backups', U),
    http('GET', '/api/system/logs', U), http('GET', '/api/system/logs/files', U), http('POST', '/api/system/maintenance', U),
  ]);
  check('user gets 403 on every admin system route', denied.every((r) => r.status === 403), denied.map((r) => r.status).join(','));

  // ---------------------------------------------------------------- settings
  const put = await http('PUT', '/api/system/settings', T, { backup: { enabled: true, hour: 0, keep: 2 } });
  check('settings saved (partial update keeps the rest)', put.status === 200 && put.body.settings.backup.keep === 2 && put.body.settings.logRetentionDays === before.logRetentionDays, JSON.stringify(put.body));
  const bad = await http('PUT', '/api/system/settings', T, { backup: { enabled: true, hour: 24, keep: 2 } });
  check('invalid hour refused (400)', bad.status === 400);

  // ---------------------------------------------------------------- backup now ×3 (keep 2)
  const runs: any[] = [];
  for (let i = 0; i < 3; i++) {
    const r = await http('POST', '/api/system/backups', T);
    if (i === 0) check('backup now → 202 + task', r.status === 202 && !!r.body.task?.id, JSON.stringify(r.body));
    const task = await waitTask(T, r.body.task.id);
    runs.push(task);
    const list = (await http('GET', '/api/system/backups', T)).body.backups as any[];
    const row = list.find((b) => b.taskId === task.id);
    if (row) backupIds.push(row.id);
    if (i === 0) {
      check('backup task succeeded', task.status === 'success', `${task.status} ${task.errorCode ?? ''} ${task.error ?? ''}`);
      check('backup listed with size/time/status', !!row && row.status === 'ok' && row.size > 0 && !!row.finishedAt && row.key.startsWith('backups/'), JSON.stringify(row));
      if (row) {
        const stored = await new Promise<Buffer>(async (resolve, reject) => {
          try {
            const s = await (await storageFor(row.storage)).getStream(row.key);
            const parts: Buffer[] = []; s.on('data', (c: Buffer) => parts.push(c)); s.on('end', () => resolve(Buffer.concat(parts))); s.on('error', reject);
          } catch (err) { reject(err); }
        });
        check(`file present in the ${row.storage} storage backend`, stored.length === row.size, `${stored.length} vs ${row.size}`);
        const dl = await http('GET', `/api/system/backups/${row.id}/download`, T);
        check('download streams the dump (admin)', dl.status === 200 && dl.buf.length === row.size && /attachment/.test(dl.headers.get('content-disposition') ?? ''), `${dl.status} ${dl.buf.length}`);
        check('dump has the custom-format magic PGDMP', dl.buf.subarray(0, 5).toString('latin1') === 'PGDMP');
        const ls = await pgRestoreList(dl.buf);
        if (ls.skipped) console.log(`  (pg_restore --list skipped: ${ls.skipped})`);
        else check('pg_restore --list reads the dump and lists our tables', ls.ok && /TABLE public db_backups/.test(ls.out) && /TABLE DATA public instances/.test(ls.out), ls.out.slice(0, 300));
        const udl = await http('GET', `/api/system/backups/${row.id}/download`, U);
        check('user cannot download (403)', udl.status === 403);
      }
    }
  }
  check('all three backups succeeded', runs.every((r) => r.status === 'success'), runs.map((r) => r.status).join(','));
  const after = (await http('GET', '/api/system/backups', T)).body.backups as any[];
  const okRows = after.filter((b) => b.status === 'ok');
  check('retention keeps the newest 2 successful backups', okRows.length === 2 && okRows.every((b) => backupIds.slice(1).includes(b.id)), okRows.map((b) => b.id).join(','));
  const first = await db.select().from(schema.dbBackups).where(eq(schema.dbBackups.id, backupIds[0] ?? '00000000-0000-0000-0000-000000000000'));
  check('oldest backup row removed by retention', first.length === 0);

  // ---------------------------------------------------------------- delete
  const victim = okRows[okRows.length - 1];
  if (victim) {
    const del = await http('DELETE', `/api/system/backups/${victim.id}`, T);
    check('delete backup → 204', del.status === 204, String(del.status));
    const gone = await (await storageFor(victim.storage)).getStream(victim.key).then((s) => { s.destroy(); return false; }, () => true);
    check('deleted backup file is gone from storage', gone);
    const list2 = (await http('GET', '/api/system/backups', T)).body.backups as any[];
    check('deleted backup no longer listed', !list2.some((b) => b.id === victim.id));
    check('download of a deleted backup → 404', (await http('GET', `/api/system/backups/${victim.id}/download`, T)).status === 404);
    check('user cannot delete (403)', (await http('DELETE', `/api/system/backups/${okRows[0]!.id}`, U)).status === 403);
  }

  // ---------------------------------------------------------------- daily schedule idempotent
  const m1 = await http('POST', '/api/system/maintenance', T);
  const m2 = await http('POST', '/api/system/maintenance', T);
  check('maintenance runs (admin)', m1.status === 200 && m2.status === 200, `${m1.status} ${m2.status}`);
  const b1 = m1.body.result?.backup; const b2 = m2.body.result?.backup;
  check('daily backup scheduled once (same task, second call created nothing)', !!b1?.taskId && b1.taskId === b2?.taskId && b2.created === false, JSON.stringify([b1, b2]));
  const daily = await db.select().from(schema.tasks).where(and(eq(schema.tasks.type, 'db-backup'), like(schema.tasks.idempotencyKey, 'daily:%'), gte(schema.tasks.createdAt, new Date(Date.now() - 2 * 86_400_000))));
  const keys = daily.map((d) => d.idempotencyKey);
  check('one scheduled task per local day', new Set(keys).size === keys.length, keys.join(','));
  if (b1?.created) await waitTask(T, b1.taskId);
  await http('PUT', '/api/system/settings', T, { backup: { enabled: false, hour: 0, keep: 2 } });
  const m3 = await http('POST', '/api/system/maintenance', T);
  check('disabled schedule creates no task', m3.body.result?.backup === null, JSON.stringify(m3.body.result));

  // ---------------------------------------------------------------- secrets
  const backupTasks = await db.select().from(schema.tasks).where(and(eq(schema.tasks.type, 'db-backup'), gte(schema.tasks.createdAt, t0)));
  const taskLogs = backupTasks.length ? await db.select().from(schema.taskLogs).where(inArray(schema.taskLogs.taskId, backupTasks.map((x) => x.id))) : [];
  check('no DB password in backup task payloads, results, errors or logs', !leaks(JSON.stringify(backupTasks)) && !leaks(JSON.stringify(taskLogs)) && taskLogs.length > 0);

  // ---------------------------------------------------------------- system logs
  const fake = `cpfake${randomBytes(8).toString('hex')}`;
  await fetch(`${API}/api/health?probe=${tag}&access_token=${fake}&apiKey=${fake}`);
  const logs = await waitFor('log line', async () => {
    const r = await http('GET', `/api/system/logs?q=probe%3D${tag}&limit=50`, T);
    return r.body?.entries?.length ? r.body : null;
  }, 10_000);
  const logText = JSON.stringify(logs.entries);
  check('request log is in the ring (text filter)', logs.source === 'memory' && logText.includes(`probe=${tag}`));
  check('fake token redacted in the ring', !logText.includes(fake) && logText.includes(REDACTED), logText.slice(0, 300));
  const lvl = await http('GET', `/api/system/logs?level=warn&limit=200`, T);
  check('level filter: only warn and above', lvl.status === 200 && (lvl.body.entries as any[]).every((e) => e.level >= 40));
  check('level filter excludes our info line', !(lvl.body.entries as any[]).some((e) => JSON.stringify(e).includes(`probe=${tag}`)));
  const future = new Date(Date.now() + 3600_000).toISOString();
  const tf = await http('GET', `/api/system/logs?from=${encodeURIComponent(future)}`, T);
  check('time filter (from in the future → nothing)', tf.status === 200 && tf.body.entries.length === 0);
  const past = await http('GET', `/api/system/logs?q=probe%3D${tag}&to=${encodeURIComponent(new Date(Date.now() - 3600_000).toISOString())}`, T);
  check('time filter (to before the request → nothing)', past.body.entries.length === 0);
  const today = new Date().toISOString().slice(0, 10);
  const files = (await http('GET', '/api/system/logs/files', T)).body.files as any[];
  check("today's log file listed", files.some((f) => f.date === today && f.size > 0), JSON.stringify(files));
  const fromFile = await http('GET', `/api/system/logs?date=${today}&q=probe%3D${tag}`, T);
  check('daily file has the request log, redacted', fromFile.body.source === 'file' && fromFile.body.entries.length > 0 && !JSON.stringify(fromFile.body.entries).includes(fake));
  const raw = fs.readFileSync(path.resolve(config.LOG_DIR, `api-${today}.log`), 'utf8');
  check('fake token never written to the log file', raw.includes(`probe=${tag}`) && !raw.includes(fake));
  check('no DB password in the log file', !leaks(raw));
  const red = JSON.stringify(redactLog({ token: 'abc123', nested: { password: 'p4ss', ok: 'visible' }, msg: 'auth Bearer eyJabc.def connect postgres://u:hunter2@h/db', err: { message: 'secret=xyz failed' } }));
  check('key/value redaction rules (keys, Bearer, URL credentials, k=v)', !/abc123|p4ss|eyJabc|hunter2|xyz/.test(red) && red.includes('visible'), red);
  // log file retention: an old file is deleted by the hourly maintenance
  const oldFile = path.resolve(config.LOG_DIR, 'api-2000-01-01.log');
  fs.writeFileSync(oldFile, '{}\n');
  const m4 = await http('POST', '/api/system/maintenance', T);
  check('maintenance deletes log files past retention', !fs.existsSync(oldFile) && (m4.body.result?.logFilesDeleted ?? []).includes('2000-01-01'), JSON.stringify(m4.body.result));

  // ---------------------------------------------------------------- connection history
  const fakes = await db.insert(schema.instances).values([
    { name: `sysfake-${tag}-1`, image: 'none', adbPort: 5595, status: 'running' as const, adbState: 'device', spec: { width: 720, height: 1280, dpi: 320 } },
    { name: `sysfake-${tag}-2`, image: 'none', adbPort: 5596, status: 'stopped' as const, spec: { width: 720, height: 1280, dpi: 320 } },
    { name: `sysfake-${tag}-3`, image: 'none', adbPort: 5597, status: 'stopped' as const, spec: { width: 720, height: 1280, dpi: 320 } },
  ]).returning();
  fakeIds.push(...fakes.map((f) => f.id));
  const [D1, D2, D3] = fakes as [typeof fakes[0], typeof fakes[0], typeof fakes[0]];
  // D2: deliberate stop cycle through repo.updateInstance (no offline event), and a write without status/adb (no row)
  await updateInstance(D2.id, { status: 'starting' });
  await updateInstance(D2.id, { status: 'stopping' });
  await updateInstance(D2.id, { status: 'stopped' });
  await updateInstance(D2.id, { lastError: 'x' });
  await updateInstance(D2.id, { status: 'stopped' }); // unchanged: no row
  // D1: "running" with adb "device" but no container → the monitor marks it error and clears adb (an offline event).
  const panelD1 = await waitFor('monitor transition', async () => {
    const r = await http('GET', '/api/system/connections', T);
    const d = (r.body.devices as any[]).find((x) => x.id === D1.id);
    return d && d.offline24h >= 1 ? d : null;
  }, 30_000);
  check('monitor transition recorded (running → error, adb lost) and counted as offline', panelD1.status === 'error' && panelD1.offline24h >= 1 && !!panelD1.lastOfflineAt, JSON.stringify(panelD1));
  const h1 = (await http('GET', `/api/system/connections/${D1.id}/history`, T)).body.events as any[];
  check('D1 history: status running→error and adb device→null, both offline', h1.some((e) => e.field === 'status' && e.from === 'running' && e.to === 'error' && e.offline)
    && h1.some((e) => e.field === 'adb' && e.from === 'device' && e.to === null && e.offline), JSON.stringify(h1));
  const h2 = (await http('GET', `/api/system/connections/${D2.id}/history`, T)).body.events as any[];
  check('D2 history: exactly the 3 real status changes, no offline event', h2.length === 3 && h2.every((e) => e.field === 'status' && !e.offline)
    && h2.map((e) => `${e.from}>${e.to}`).join(',') === 'stopping>stopped,starting>stopping,stopped>starting', JSON.stringify(h2));
  const panel = (await http('GET', '/api/system/connections', T)).body.devices as any[];
  const p2 = panel.find((x) => x.id === D2.id);
  check('panel row: changes/offline counts, adb/STF/scrcpy/proxy fields', p2?.changes24h === 3 && p2.offline24h === 0 && 'stfReady' in p2 && 'adbRttMs' in p2 && p2.scrcpy === null && 'proxyStatus' in p2, JSON.stringify(p2));
  check('admin sees all placeholder devices', fakeIds.every((id) => panel.some((x) => x.id === id)));

  // RBAC
  await http('PUT', `/api/users/${userId}/grants`, T, { instanceIds: [D1.id] });
  const up = await http('GET', '/api/system/connections', U);
  check('user sees only granted devices', up.status === 200 && up.body.devices.length === 1 && up.body.devices[0].id === D1.id, JSON.stringify(up.body).slice(0, 200));
  check('user can read history of a granted device', (await http('GET', `/api/system/connections/${D1.id}/history`, U)).status === 200);
  check('user cannot read history of another device (403)', (await http('GET', `/api/system/connections/${D3.id}/history`, U)).status === 403);
  check('anonymous refused (401)', (await http('GET', '/api/system/connections', null)).status === 401);

  // ---------------------------------------------------------------- audit
  await new Promise((r) => setTimeout(r, 500)); // audit writes are fire-and-forget
  const audit = await db.select().from(schema.auditLogs).where(and(gte(schema.auditLogs.at, t0), like(schema.auditLogs.action, 'system.%')));
  const acts = new Set(audit.filter((a) => a.ok).map((a) => a.action));
  check('audit: backup create/delete, settings, maintenance', ['system.backup_create', 'system.backup_delete', 'system.settings', 'system.maintenance'].every((a) => acts.has(a)), [...acts].join(','));
  const delEntry = audit.find((a) => a.action === 'system.backup_delete' && a.ok);
  check('audit: delete names the backup file', !!delEntry?.target?.endsWith('.dump'), JSON.stringify(delEntry));
  check('audit: refused user attempts recorded (403)', audit.some((a) => a.action === 'system.backup_create' && a.status === 403));
  check('no DB password in audit entries', !leaks(JSON.stringify(audit)));
} catch (err) {
  check(`unexpected error: ${(err as Error).message}`, false);
} finally {
  if (fakeIds.length) await db.delete(schema.instances).where(inArray(schema.instances.id, fakeIds));
  if (userId) await http('DELETE', `/api/users/${userId}`, T);
  for (const id of backupIds) await http('DELETE', `/api/system/backups/${id}`, T);
  if (before) await http('PUT', '/api/system/settings', T, { backup: before.backup, logRetentionDays: before.logRetentionDays, historyRetentionDays: before.historyRetentionDays });
  const passed = results.filter(([, ok]) => ok).length;
  console.log(`\n${passed}/${results.length} passed`);
  await events.close();
  await sqlClient.end();
  process.exit(passed === results.length ? 0 : 1);
}
