/**
 * 从云手机同步 + 自动发现 on bit-ins-02 (real API, DB, BullMQ, adb and the real Instagram app; no mocks). Read only:
 * `dumpsys account`, `instagram://profile` (the logged-in account's own profile), uiautomator dump, HOME. At most 3
 * Instagram screens (MAX_IG_OPENS): sync → created, sync again → updated (no duplicate), then the account is deleted
 * in the test DB and 自动发现 (single assigned user) creates it again.
 *
 *   E2E_API=http://127.0.0.1:<port> API_PORT=<port> [MAIN_DEVICE_ID=<bit-ins-02 id in the main DB>] \
 *     npx tsx --env-file=../../.env scripts/account-sync-device-check.ts [--handle conchadoroperto650 --external-id 78090361572]
 *
 * Device access like account-device-check: an inert external device row in THIS API's DB points at the adb port
 * (BIT_ADB_PORT, default 5700) whose tunnel the main API keeps open; its source config is invalid, so this API never
 * powers it or opens a second tunnel. The phone must be on (adb `device`), else the script stops before anything
 * touches it; a scrcpy viewer on the phone stops it too. The main API's Redis (db 0) is only READ (MAIN_DEVICE_ID:
 * waits while its device lock is held). Checks: created (owner, phone linked, externalId, counts in today's stats
 * row), updated (same row), auto-discovered for the only assigned user, opens ≤ 3, launcher + no dump left.
 */
import { randomBytes } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { db, schema, sqlClient } from '../src/db/index.js';
import { adb } from '../src/services.js';
import { withCaptcha } from './lib/login.js';

const API = process.env.E2E_API ?? `http://127.0.0.1:${process.env.API_PORT ?? 3000}`;
if (/:3000\b/.test(API)) throw new Error('refusing to run against the main API (port 3000): set E2E_API and API_PORT to the test API');
const BIT_PORT = Number(process.env.BIT_ADB_PORT ?? 5700);
const arg = (n: string, d: string) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1]! : d; };
const HANDLE = arg('--handle', 'conchadoroperto650');
const EXTERNAL_ID = arg('--external-id', '78090361572');
const MAX_IG_OPENS = 3;
const results: [string, boolean][] = [];
const check = (name: string, ok: boolean, detail = '') => { results.push([name, ok]); console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`); };
async function http<T = any>(method: string, path: string, token: string | null, body?: unknown) {
  const res = await fetch(API + path, {
    method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
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
const T = schema.tasks;
async function waitTask(id: string, ms = 180_000) {
  const t0 = Date.now();
  const seen = [id];
  for (;;) {
    const [row] = await db.select().from(T).where(eq(T.id, id));
    if (row && ['success', 'failed', 'cancelled'].includes(row.status)) {
      const next = (row.result as any)?.outcome === 'deferred' ? (row.result as any).taskId : null;
      if (!next) return { final: row, ids: seen };
      id = next; seen.push(id);
    }
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for task ${id}`);
    await sleep(1000);
  }
}
const mainRedis = process.env.MAIN_DEVICE_ID ? new Redis(process.env.MAIN_REDIS_URL ?? process.env.REDIS_URL!.replace(/\/\d+$/, '').replace(/\/$/, '') + '/0', { maxRetriesPerRequest: 2 }) : null;
async function phoneFree(): Promise<void> {
  const procs = await adb.shell(BIT_PORT, 'ps -A -o ARGS | grep -c "[s]crcpy"');
  if (Number(procs.trim()) > 0) throw new Error('a scrcpy viewer is on the phone (someone is watching it): stopping');
  if (!mainRedis) return;
  for (let i = 0; await mainRedis.get(`tracked:collector:lock:${process.env.MAIN_DEVICE_ID}`); i++) {
    if (i > 120) throw new Error('the main API keeps the phone busy for 10 min: stopping');
    await sleep(5000);
  }
}

const tag = randomBytes(3).toString('hex');
const pw = randomBytes(12).toString('base64url');
const userIds: string[] = [];
const ext: { source?: string; instance?: string } = {};
const taskIds: string[] = [];
const settingKeys = ['risk.device', 'social.limits'];
const saved = await db.select().from(schema.settings).where(inArray(schema.settings.key, settingKeys));
let admin = '';

try {
  const serial = adb.serialFor(BIT_PORT);
  if ((await adb.states()).get(serial) !== 'device') throw new Error(`${serial} is not attached: bit-ins-02 is off or the main API's tunnel is down — stopping before anything touches it`);
  admin = await login(process.env.ADMIN_USERNAME!, process.env.ADMIN_PASSWORD!);
  await phoneFree();
  check('pace 10 s, scheduled checks / feed off for the run', (await http('PUT', '/api/risk/settings', admin, { minIntervalSec: 10, accountCheckHours: null, feedCollectHours: null, accountDiscovery: true })).status === 200);
  const u = await http('POST', '/api/users', admin, { username: `asd${tag}`, password: pw, role: 'user' });
  const uid = u.body.user?.id ?? u.body.id;
  userIds.push(uid);
  const U = await login(`asd${tag}`, pw);
  const [src] = await db.insert(schema.deviceSources).values({ type: 'bitbrowser', name: `asdchk-src-${tag}`, config: { apiUrl: 'not a url' } }).returning();
  ext.source = src!.id;
  const [phone] = await db.insert(schema.instances).values({
    name: `asdchk-bit-${tag}`, engine: 'bitbrowser', sourceId: src!.id, externalId: 'asdchk-bit', profile: 'bitbrowser', image: '',
    adbPort: BIT_PORT, status: 'running', adbState: 'device', bootCompleted: true, spec: { width: 720, height: 1280, dpi: 320 },
  }).returning();
  ext.instance = phone!.id;
  await http('PUT', `/api/users/${uid}/grants`, admin, { instanceIds: [phone!.id] });

  // 1. sync → created
  let r = await http('POST', '/api/social/sync-from-device', U, { instanceId: phone!.id });
  check('user syncs the assigned phone → 202', r.status === 202, r.text);
  let w = await waitTask(r.body.task.id); taskIds.push(...w.ids);
  let res = w.final.result as any;
  console.log(`   result: ${JSON.stringify(res)}`);
  check(`created @${HANDLE}`, res?.result === 'created' && res.handle === HANDLE && res.externalId === EXTERNAL_ID, JSON.stringify(res));
  const [acc] = await db.select().from(schema.socialAccounts).where(eq(schema.socialAccounts.handle, HANDLE));
  check('row: owner = user, phone linked, externalId, logged in', acc?.userId === uid && acc.instanceId === phone!.id && acc.externalId === EXTERNAL_ID && acc.loginStatus === 'logged_in');
  const st = acc ? await db.select().from(schema.socialAccountStats).where(eq(schema.socialAccountStats.socialAccountId, acc.id)) : [];
  check('today\'s stats row (source device)', st.length === 1 && st[0]!.source === 'device', JSON.stringify(st[0] ?? null));
  console.log(`   counts: followers ${st[0]?.followers} following ${st[0]?.following} posts ${st[0]?.posts} approx ${st[0]?.approx ?? '[]'}`);

  // 2. sync again → updated, no second row
  await phoneFree();
  r = await http('POST', '/api/social/sync-from-device', U, { instanceId: phone!.id });
  w = await waitTask(r.body.task.id); taskIds.push(...w.ids);
  res = w.final.result as any;
  check('second sync → updated, same account, no duplicate', res?.result === 'updated' && res.accountId === acc?.id
    && (await db.select().from(schema.socialAccounts).where(eq(schema.socialAccounts.handle, HANDLE))).length === 1, JSON.stringify(res));

  // 3. 自动发现 with a single assigned user: delete the account in the test DB, discover
  await http('DELETE', `/api/social/accounts/${acc!.id}`, U);
  await phoneFree();
  r = await http('POST', '/api/social/discover', admin);
  check('自动发现: phone read (dumpsys only), one sync queued', r.body.discovery?.read === 1 && r.body.discovery.synced === 1, r.text);
  const autoRows = (await db.select().from(T).where(and(eq(T.type, 'account-device-sync'), eq(T.refId, phone!.id)))).filter((x) => x.createdBy === null);
  if (autoRows[0]) { w = await waitTask(autoRows[0].id); taskIds.push(...w.ids); }
  res = w.final.result as any;
  const [again] = await db.select().from(schema.socialAccounts).where(eq(schema.socialAccounts.handle, HANDLE));
  check('auto task → created for the assigned user', autoRows.length === 1 && res?.result === 'created' && again?.userId === uid && again.instanceId === phone!.id, JSON.stringify(res));

  // budget + phone state
  const opens = (await db.select({ id: schema.taskLogs.id }).from(schema.taskLogs).where(and(inArray(schema.taskLogs.taskId, taskIds), eq(schema.taskLogs.message, 'collector: profile link opened')))).length;
  check(`Instagram opened ${opens} times (≤ ${MAX_IG_OPENS})`, opens <= MAX_IG_OPENS);
  const top = await adb.shell(BIT_PORT, 'dumpsys activity activities | grep " ResumedActivity"');
  check('phone back on the launcher', !top.includes('com.instagram.android'), top.trim().slice(0, 160));
  const dumps = await adb.shell(BIT_PORT, 'ls /data/local/tmp/ | grep -c "^cp-ig-"');
  check('no dump left', Number(dumps.trim()) === 0, dumps.trim());
} catch (err) {
  check('run', false, String((err as Error).message ?? err));
} finally {
  if (taskIds.length) await db.delete(T).where(inArray(T.id, taskIds));
  if (ext.instance) {
    const left = await db.select({ id: T.id }).from(T).where(eq(T.refId, ext.instance));
    if (left.length) await db.delete(T).where(inArray(T.id, left.map((x) => x.id)));
  }
  for (const id of userIds) await http('DELETE', `/api/users/${id}`, admin);
  if (ext.instance) {
    await db.delete(schema.riskEvents).where(eq(schema.riskEvents.instanceId, ext.instance));
    await db.delete(schema.notifications).where(eq(schema.notifications.refId, ext.instance));
    await db.delete(schema.instances).where(eq(schema.instances.id, ext.instance));
  }
  if (ext.source) await db.delete(schema.deviceSources).where(eq(schema.deviceSources.id, ext.source));
  await db.delete(schema.settings).where(inArray(schema.settings.key, settingKeys));
  if (saved.length) await db.insert(schema.settings).values(saved);
  mainRedis?.disconnect();
  const failed = results.filter(([, ok]) => !ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  await sqlClient.end();
  process.exit(failed ? 1 : 0);
}
