/**
 * 追踪中 on bit-ins-02 (owner authorisation 2026-11-18 for this list): real API, DB, BullMQ, adb and the real Instagram
 * app (no mocks). Read only: `dumpsys account`, `instagram://profile` (own profile), ONE tap on the 关注 counter,
 * uiautomator dumps, swipes in the list left of the row buttons, BACK, HOME. Never a row's buttons, never a profile
 * from the list, never follow / unfollow. ≤ 4 Instagram screens (2 runs × profile + list; swipes only when the list
 * is longer than one screen).
 *
 *   E2E_API=http://127.0.0.1:<port> API_PORT=<port> MAIN_LOCK_DEVICE=<bit-ins-02 id in the main DB> \
 *     npx tsx --env-file=../../.env scripts/following-device-check.ts [--handle conchadoroperto650 --external-id 78090361572]
 *
 * Device access like account-sync-device-check: an inert external device row in THIS API's DB on the adb port the main
 * API's tunnel keeps open (BIT_ADB_PORT, default 5700); its source config is invalid, so this API never powers the
 * phone or opens a second tunnel. MAIN_LOCK_DEVICE: holds the main API's per-device automation lock (Redis
 * MAIN_REDIS_URL, default REDIS_URL with db 0) for the run, so the main API's scheduled work defers meanwhile. The phone
 * must be on (adb `device`), else the script stops before anything touches it; a scrcpy viewer stops it too.
 * Checks: run 1 complete (as many entries as the tab count, positions, handles lowercase), run 2 the same (nothing
 * new, nothing gone, first_seen kept), screens ≤ 4, launcher + no dump left.
 */
import { randomBytes } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { db, schema, sqlClient } from '../src/db/index.js';
import { adb } from '../src/services.js';
import { withCaptcha } from './lib/login.js';
import { linkAccount } from './lib/social-link.js';

const API = process.env.E2E_API ?? `http://127.0.0.1:${process.env.API_PORT ?? 3000}`;
if (/:3000\b/.test(API)) throw new Error('refusing to run against the main API (port 3000): set E2E_API and API_PORT to the test API');
const BIT_PORT = Number(process.env.BIT_ADB_PORT ?? 5700);
const arg = (n: string, d: string) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1]! : d; };
const HANDLE = arg('--handle', 'conchadoroperto650');
const EXTERNAL_ID = arg('--external-id', '78090361572');
const MAX_SCREENS = 4;
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
async function waitTask(id: string, ms = 600_000) {
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

const tag = randomBytes(3).toString('hex');
const pw = randomBytes(12).toString('base64url');
const userIds: string[] = [];
const ext: { source?: string; instance?: string } = {};
const taskIds: string[] = [];
const settingKeys = ['risk.device', 'social.limits'];
const saved = await db.select().from(schema.settings).where(inArray(schema.settings.key, settingKeys));
let admin = '';
let mainLock: { redis: Redis; key: string; token: string; timer: NodeJS.Timeout } | null = null;

try {
  const serial = adb.serialFor(BIT_PORT);
  if ((await adb.states()).get(serial) !== 'device') throw new Error(`${serial} is not attached: bit-ins-02 is off or the main API's tunnel is down — stopping before anything touches it`);
  if (process.env.MAIN_LOCK_DEVICE) {
    const redis = new Redis(process.env.MAIN_REDIS_URL ?? process.env.REDIS_URL!.replace(/\/\d+$/, '').replace(/\/$/, '') + '/0', { maxRetriesPerRequest: 2 });
    const key = `tracked:collector:lock:${process.env.MAIN_LOCK_DEVICE}`;
    const token = `following-device-check-${tag}|following|${Date.now()}`;
    for (let i = 0; ; i++) {
      if ((await redis.set(key, token, 'PX', 15 * 60_000, 'NX')) === 'OK') break;
      if (i > 120) throw new Error('the main API keeps the phone busy');
      await sleep(5000);
    }
    mainLock = { redis, key, token, timer: setInterval(() => { void redis.set(key, token, 'PX', 15 * 60_000, 'XX'); }, 5 * 60_000) };
    console.log('   main API lock held for the run');
  }
  const procs = await adb.shell(BIT_PORT, 'ps -A -o ARGS | grep -c "[s]crcpy"');
  if (Number(procs.trim()) > 0) throw new Error('a scrcpy viewer is on the phone (someone is watching it): stopping');
  admin = await login(process.env.ADMIN_USERNAME!, process.env.ADMIN_PASSWORD!);
  check('pace 10 s, every schedule off for the run', (await http('PUT', '/api/risk/settings', admin, {
    minIntervalSec: 10, accountCheckHours: null, feedCollectHours: null, followingSyncHours: null, accountDiscovery: false,
  })).status === 200);
  const u = await http('POST', '/api/users', admin, { username: `fwd${tag}`, password: pw, role: 'user' });
  const uid = u.body.user?.id ?? u.body.id;
  userIds.push(uid);
  const U = await login(`fwd${tag}`, pw);
  const [src] = await db.insert(schema.deviceSources).values({ type: 'bitbrowser', name: `fwdchk-src-${tag}`, config: { apiUrl: 'not a url' } }).returning();
  ext.source = src!.id;
  const [phone] = await db.insert(schema.instances).values({
    name: `fwdchk-bit-${tag}`, engine: 'bitbrowser', sourceId: src!.id, externalId: 'fwdchk-bit',
    adbPort: BIT_PORT, status: 'running', adbState: 'device', bootCompleted: true, spec: { width: 720, height: 1280, dpi: 320 },
  }).returning();
  ext.instance = phone!.id;
  await http('PUT', `/api/instances/${phone!.id}/grants`, admin, { userIds: [uid] });
  const acc = await http('POST', '/api/social/accounts', admin, { platform: 'instagram', handle: HANDLE, ownerId: uid, externalId: EXTERNAL_ID });
  if (acc.status !== 201) throw new Error(`account: ${acc.text}`);
  const accId = acc.body.account.id as string;
  await linkAccount(accId, phone!.id);

  // run 1
  let r = await http('POST', `/api/social/accounts/${accId}/following/sync`, U);
  check('同步 by the owner → 202', r.status === 202, r.text);
  let w = await waitTask(r.body.task.id); taskIds.push(...w.ids);
  const res1 = w.final.result as any;
  console.log(`   run 1: ${w.final.status} ${w.final.errorCode ?? ''} ${JSON.stringify(res1)}`);
  check('run 1: synced, complete, entries = the tab count, nothing gone', w.final.status === 'success' && res1?.outcome === 'synced' && res1.complete === true
    && res1.seen === res1.tabCount && res1.gone === 0 && res1.added === res1.seen, JSON.stringify(res1));
  let g = await http('GET', `/api/social/accounts/${accId}/following?limit=200`, U);
  console.log(`   following: ${g.body.items?.map((x: any) => `${x.handle}${x.displayName ? ` (${x.displayName})` : ''}`).join(', ')}`);
  check('GET: as many current entries as read, handles lowercase, positions 0..n-1, last run complete', g.body.following === res1?.seen && g.body.items.every((x: any, i: number) => x.handle === x.handle.toLowerCase() && x.position === i)
    && g.body.lastSynced?.result?.complete === true, g.text.slice(0, 300));
  const first = new Map<string, string>(g.body.items.map((x: any) => [x.handle, x.firstSeenAt]));

  // run 2
  r = await http('POST', `/api/social/accounts/${accId}/following/sync`, U);
  w = await waitTask(r.body.task.id); taskIds.push(...w.ids);
  const res2 = w.final.result as any;
  console.log(`   run 2: ${w.final.status} ${w.final.errorCode ?? ''} ${JSON.stringify(res2)}`);
  check('run 2: same list, nothing new, nothing gone', res2?.outcome === 'synced' && res2.complete === true && res2.seen === res1?.seen && res2.added === 0 && res2.gone === 0, JSON.stringify(res2));
  g = await http('GET', `/api/social/accounts/${accId}/following?limit=200`, U);
  check('first_seen kept on the second run', g.body.items.every((x: any) => first.get(x.handle) === x.firstSeenAt));

  // budget + phone state
  const screens = (res1?.screens ?? 99) + (res2?.screens ?? 99);
  check(`Instagram screens ${screens} (≤ ${MAX_SCREENS}), swipes ${(res1?.swipes ?? 0) + (res2?.swipes ?? 0)}`, screens <= MAX_SCREENS);
  const top = await adb.shell(BIT_PORT, 'dumpsys activity activities | grep " ResumedActivity"');
  check('phone back on the launcher', !top.includes('com.instagram.android'), top.trim().slice(0, 160));
  const dumps = await adb.shell(BIT_PORT, 'ls /data/local/tmp/ | grep -c "^cp-ig-"');
  check('no dump left', Number(dumps.trim()) === 0, dumps.trim());
} catch (err) {
  check('run', false, String((err as Error).message ?? err));
} finally {
  if (mainLock) {
    clearInterval(mainLock.timer);
    await mainLock.redis.eval("if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end", 1, mainLock.key, mainLock.token).catch(() => undefined);
    mainLock.redis.disconnect();
  }
  if (taskIds.length) await db.delete(T).where(inArray(T.id, taskIds));
  if (ext.instance) {
    const left = await db.select({ id: T.id }).from(T).where(eq(T.refId, ext.instance));
    if (left.length) await db.delete(T).where(inArray(T.id, left.map((x) => x.id)));
  }
  for (const id of userIds) await http('DELETE', `/api/users/${id}`, admin);
  if (ext.instance) {
    await db.delete(schema.riskEvents).where(eq(schema.riskEvents.instanceId, ext.instance));
    await db.delete(schema.notifications).where(and(eq(schema.notifications.refType, 'instance'), eq(schema.notifications.refId, ext.instance)));
    await db.delete(schema.instances).where(eq(schema.instances.id, ext.instance));
  }
  if (ext.source) await db.delete(schema.deviceSources).where(eq(schema.deviceSources.id, ext.source));
  await db.delete(schema.settings).where(inArray(schema.settings.key, settingKeys));
  if (saved.length) await db.insert(schema.settings).values(saved);
  const failed = results.filter(([, ok]) => !ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  await sqlClient.end();
  process.exit(failed ? 1 : 0);
}
