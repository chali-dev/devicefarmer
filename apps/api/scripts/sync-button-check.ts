/**
 * 同步 button = step 1 (account) → step 2 (帖子与评论), without a phone (real API, DB, BullMQ, task centre; no mocks):
 *
 *   E2E_API=http://127.0.0.1:<port> API_PORT=<port> [ENABLED_PLATFORMS=all] npx tsx --env-file=../../.env scripts/sync-button-check.ts
 *
 * Placeholder devices (adb ports 5591–5592, running in the DB, adb doesn't see them = offline), never a real phone.
 * What runs for real through the API under test:
 *  - social `POST /api/social/accounts/:id/sync`: RBAC (others' account 404, unauthenticated 401), codes before queueing
 *    (no phone account_sync.no_device, halted 409 account_sync.device_halted, already queued 409 account_sync.in_progress),
 *    202 + task account-device-sync with payload.feed; step 1 on the offline placeholder → result offline → NO step 2
 *    (no feed-collect task keyed after:<step 1>), audit social.account_sync.
 *  - tracked `POST /api/tracked-accounts/:id/sync`: RBAC (404), paused 409, 202 + tracked-refresh with payload.feed,
 *    step 1 fails on the account's offline 采集手机 placeholder (tracked.collector_offline) → NO step 2; audit tracked.sync;
 *    the list's lastRefresh carries `type`.
 *  - step 2 after a SUCCESSFUL step 1 (needs a phone to happen end to end): the step-1 code that queues it is run
 *    in-process with a successful outcome (sync.ts syncFeedStep / feed/collect.ts queueFeedAfter, same DB + Redis as
 *    the API): created/updated → a feed-collect task keyed after:<step 1> (idempotent), taken / not ok → none,
 *    linked elsewhere / halted / already queued / no 采集手机 → coded "not queued" log, no task. The queued task
 *    is run by the API's worker on the offline placeholder → fails feed.offline, and step 1's result (account check
 *    ok via recordSyncCheck, login status) stays.
 * NOT covered: a real phone (step 1 success and step 2 reading posts end to end), the UI in a browser.
 */
import { randomBytes } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db, schema, sqlClient } from '../src/db/index.js';
import { queueFeedAfter } from '../src/modules/feed/collect.js';
import { recordSyncCheck, syncFeedStep, syncFollowingStep } from '../src/modules/social/sync.js';
import { haltDevice } from '../src/modules/tracked/collector.js';
import { withCaptcha } from './lib/login.js';
import { linkAccount } from './lib/social-link.js';
import { placeholders } from './lib/placeholder.js';

const ph = placeholders('sbchk');

const API = process.env.E2E_API ?? `http://127.0.0.1:${process.env.API_PORT ?? 3000}`;
if (/:3000\b/.test(API)) throw new Error('refusing to run against the main API (port 3000): set E2E_API and API_PORT to the test API');
const results: [string, boolean][] = [];
const check = (name: string, ok: boolean, detail = '') => { results.push([name, ok]); console.log(`${ok ? '✓' : '✗'} ${name}${detail && !ok ? ` — ${detail}` : ''}`); };
async function http<T = any>(method: string, path: string, token: string | null, body?: unknown) {
  const res = await fetch(API + path, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
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
async function waitTask(id: string, ms = 60_000) {
  const t0 = Date.now();
  for (;;) {
    const [row] = await db.select().from(T).where(eq(T.id, id));
    if (row && ['success', 'failed', 'cancelled'].includes(row.status)) return row;
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for task ${id}`);
    await sleep(400);
  }
}
const afterTasks = (parent: string) => db.select().from(T).where(and(eq(T.type, 'feed-collect'), eq(T.idempotencyKey, `after:${parent}`)));
const afterFollowing = (parent: string) => db.select().from(T).where(and(eq(T.type, 'account-following'), eq(T.idempotencyKey, `after:${parent}`)));
const lines: string[] = [];
const log = async (_level: string, message: string) => { lines.push(message); };

const admin = await login(process.env.ADMIN_USERNAME!, process.env.ADMIN_PASSWORD!);
const tag = randomBytes(3).toString('hex');
const pw = randomBytes(12).toString('base64url');
const settingKeys = ['risk.halts', 'risk.device', 'rbac.userMenus'];
const saved = await db.select().from(schema.settings).where(inArray(schema.settings.key, settingKeys));
const t0 = new Date((await sqlClient`select now() as now`)[0]!.now as Date);
const userIds: string[] = [];
const devIds: string[] = [];

try {
  await db.delete(schema.settings).where(inArray(schema.settings.key, settingKeys));
  await http('PUT', '/api/risk/settings', admin, { feedCollectHours: null, accountCheckHours: null });
  for (const n of ['a', 'b']) {
    const u = await http('POST', '/api/users', admin, { username: `sb${n}${tag}`, password: pw, role: 'user' });
    userIds.push(u.body.user?.id ?? u.body.id);
  }
  const [uA] = userIds as [string, string];
  const A = await login(`sba${tag}`, pw);
  const B = await login(`sbb${tag}`, pw);
  const devs = await ph.insert([1, 2].map((n) => ({
    name: `sbchk-${tag}-${n}`, adbPort: 5590 + n, status: 'running' as const, adbState: 'device', bootCompleted: true,
  })));
  devIds.push(...devs.map((d) => d.id));
  const [D1, D2] = devs as [typeof devs[0], typeof devs[0]];
  await http('PUT', `/api/instances/${D1.id}/grants`, admin, { userIds: [uA] });
  const mk = async (handle: string, instanceId: string | null) => {
    const x = await http('POST', '/api/social/accounts', A, { platform: 'instagram', handle });
    if (x.status !== 201) throw new Error(`account: ${x.text}`);
    if (instanceId) await linkAccount(x.body.account.id, instanceId);
    return x.body.account.id as string;
  };
  const acc = await mk(`sb_a_${tag}`, D1.id);
  const accN = await mk(`sb_n_${tag}`, null);

  // ---------------------------------------------------------------- social: API, step 1 failure → no step 2
  let r = await http('POST', `/api/social/accounts/${acc}/sync`, B);
  check('social 同步 on another user\'s account → 404', r.status === 404, r.text);
  r = await http('POST', `/api/social/accounts/${acc}/sync`, null);
  check('social 同步 unauthenticated → 401', r.status === 401, r.text);
  r = await http('POST', `/api/social/accounts/${accN}/sync`, A);
  check('social 同步 without a phone → 400 account_sync.no_device', r.status === 400 && r.body.code === 'account_sync.no_device', r.text);
  await haltDevice(D1, { code: 'feed.challenge', source: 'feed', platform: 'instagram' });
  r = await http('POST', `/api/social/accounts/${acc}/sync`, A);
  check('social 同步 on a halted phone → 409 account_sync.device_halted (no task)', r.status === 409 && r.body.code === 'account_sync.device_halted', r.text);
  await http('POST', `/api/risk/devices/${D1.id}/resume`, admin);
  r = await http('POST', `/api/social/accounts/${acc}/sync`, A);
  const s1 = r.body?.task?.id as string;
  check('social 同步 → 202 + task', r.status === 202 && !!s1, r.text);
  const r2 = await http('POST', `/api/social/accounts/${acc}/sync`, A);
  check('social 同步 again while queued → 409 account_sync.in_progress', r2.status === 409 && r2.body.code === 'account_sync.in_progress', r2.text);
  const s1row = await waitTask(s1);
  check('step 1 = account-device-sync with payload.feed, owner follows the phone', s1row.type === 'account-device-sync' && (s1row.payload as any).feed === true && (s1row.payload as any).ownerId === uA && s1row.refId === D1.id);
  check('step 1 on the offline placeholder → result offline, no feed in the result', s1row.status === 'success' && (s1row.result as any)?.result === 'offline' && !(s1row.result as any)?.feed, JSON.stringify(s1row.result));
  await sleep(1500);
  check('step 1 failed → step 2 not run (no feed-collect task after it)', (await afterTasks(s1)).length === 0);
  check('step 1 failed → step 3 not run (no account-following task after it)', (await afterFollowing(s1)).length === 0 && !(s1row.result as any)?.following);
  const adminSync = await http('POST', `/api/social/accounts/${acc}/sync`, admin);
  check('admin may 同步 a user\'s account → 202', adminSync.status === 202, adminSync.text);
  if (adminSync.body?.task?.id) await waitTask(adminSync.body.task.id);

  // ---------------------------------------------------------------- social: step 2 after a successful step 1 (in-process)
  const step1 = { id: s1, createdBy: uA };
  await recordSyncCheck(D1, { result: 'ok', accountId: acc }, uA); // what step 1 writes on `updated`
  lines.length = 0;
  check('step 1 taken → no step 2', (await syncFeedStep({ result: 'taken' }, step1, log)) === undefined && (await afterTasks(s1)).length === 0);
  check('step 1 limit_reached → no step 2', (await syncFeedStep({ result: 'limit_reached' }, step1, log)) === undefined);
  const le = await syncFeedStep({ result: 'updated', accountId: acc, linkedElsewhere: true }, step1, log);
  check('account linked to another phone → not queued feed.linked_elsewhere + log line', (le as any)?.code === 'feed.linked_elsewhere' && lines.includes('feed collection not queued: feed.linked_elsewhere'), JSON.stringify(le));
  await haltDevice(D1, { code: 'feed.challenge', source: 'feed', platform: 'instagram' });
  const hl = await syncFeedStep({ result: 'updated', accountId: acc }, step1, log);
  check('phone halted between the steps → not queued feed.device_halted', (hl as any)?.code === 'feed.device_halted' && (await afterTasks(s1)).length === 0, JSON.stringify(hl));
  await http('POST', `/api/risk/devices/${D1.id}/resume`, admin);
  lines.length = 0;
  const q = await syncFeedStep({ result: 'updated', accountId: acc }, step1, log);
  const q2 = await syncFeedStep({ result: 'created', accountId: acc }, step1, log);
  const after = await afterTasks(s1);
  check('step 1 updated → step 2 feed-collect queued (key after:<step 1>, creator kept, log line)', !!(q as any)?.taskId && after.length === 1 && after[0]!.refId === acc
    && after[0]!.createdBy === uA && (after[0]!.payload as any).kind === 'social' && lines.includes('feed collection queued'), JSON.stringify(q));
  check('step 2 queued once (a second call while it waits → feed.in_progress, still one task)', (q2 as any)?.code === 'feed.in_progress' && after.length === 1, JSON.stringify(q2));
  const busy = await syncFeedStep({ result: 'updated', accountId: acc }, { id: randomBytes(8).toString('hex'), createdBy: uA }, log);
  check('step 2 already queued → not queued feed.in_progress', (busy as any)?.code === 'feed.in_progress', JSON.stringify(busy));
  const f = await waitTask((q as any).taskId);
  check('step 2 fails on the offline phone (feed.offline)', f.status === 'failed' && f.errorCode === 'feed.offline', `${f.status} ${f.errorCode}`);
  const [accRow] = await db.select().from(schema.socialAccounts).where(eq(schema.socialAccounts.id, acc));
  check('step 2 failure keeps step 1\'s result (logged_in, last check ok)', accRow!.loginStatus === 'logged_in' && accRow!.lastCheckCode === 'ok', `${accRow!.loginStatus} ${accRow!.lastCheckCode}`);
  r = await http('GET', `/api/social/accounts/${acc}/feed`, A);
  // ---------------------------------------------------------------- social: step 3 (追踪中) after a successful step 1
  lines.length = 0;
  check('step 1 taken → no step 3', (await syncFollowingStep({ result: 'taken' }, step1, log)) === undefined && (await afterFollowing(s1)).length === 0);
  const fle = await syncFollowingStep({ result: 'updated', accountId: acc, linkedElsewhere: true }, step1, log);
  check('step 3: linked to another phone → following.linked_elsewhere + log line', (fle as any)?.code === 'following.linked_elsewhere' && lines.includes('following sync not queued: following.linked_elsewhere'), JSON.stringify(fle));
  await haltDevice(D1, { code: 'feed.challenge', source: 'feed', platform: 'instagram' });
  const fhl = await syncFollowingStep({ result: 'updated', accountId: acc }, step1, log);
  check('step 3: phone halted → following.device_halted, no task', (fhl as any)?.code === 'following.device_halted' && (await afterFollowing(s1)).length === 0, JSON.stringify(fhl));
  await http('POST', `/api/risk/devices/${D1.id}/resume`, admin);
  lines.length = 0;
  const fq = await syncFollowingStep({ result: 'updated', accountId: acc }, step1, log);
  const fq2 = await syncFollowingStep({ result: 'created', accountId: acc }, step1, log);
  const fAfter = await afterFollowing(s1);
  check('step 1 updated → step 3 account-following queued (key after:<step 1>, creator kept, log line)', !!(fq as any)?.taskId && fAfter.length === 1 && fAfter[0]!.refId === acc
    && fAfter[0]!.createdBy === uA && (fAfter[0]!.payload as any).socialAccountId === acc && lines.includes('following sync queued'), JSON.stringify(fq));
  check('step 3 queued once (second call → following.in_progress)', (fq2 as any)?.code === 'following.in_progress' && fAfter.length === 1, JSON.stringify(fq2));
  const ft = await waitTask((fq as any).taskId);
  check('step 3 fails on the offline phone (following.offline), step 1 result kept', ft.status === 'failed' && ft.errorCode === 'following.offline', `${ft.status} ${ft.errorCode}`);
  r = await http('GET', `/api/social/accounts/${acc}/following`, A);
  check('追踪中 tab shows step 3 as the last run (failed following.offline)', r.status === 200 && r.body.last?.errorCode === 'following.offline', JSON.stringify(r.body?.last));
  r = await http('GET', `/api/social/accounts/${acc}/feed`, A);
  check('feed drawer shows step 2 as the last collection (failed feed.offline)', r.status === 200 && r.body.collect?.last?.errorCode === 'feed.offline', JSON.stringify(r.body?.collect?.last));

  // ---------------------------------------------------------------- tracked: API, step 1 failure → no step 2
  r = await http('POST', '/api/tracked-accounts', A, { input: `sbtr${tag}`, platform: 'instagram', instanceId: null });
  const tr = r.body?.account?.id as string;
  check('tracked IG account created', r.status === 201 && !!tr, r.text);
  r = await http('POST', `/api/tracked-accounts/${tr}/sync`, B);
  check('tracked 同步 on another user\'s account → 404', r.status === 404, r.text);
  r = await http('POST', `/api/tracked-accounts/${tr}/sync`, A);
  check('tracked 同步 without a 采集手机 → 400 tracked.no_phone', r.status === 400 && r.body.code === 'tracked.no_phone', r.text);
  lines.length = 0;
  const unset = await queueFeedAfter('tracked', tr, uA, randomBytes(8).toString('hex'), log);
  check('tracked step 2 without a 采集手机 → not queued tracked.no_phone', (unset as any).code === 'tracked.no_phone' && lines[0] === 'feed collection not queued: tracked.no_phone', JSON.stringify(unset));
  r = await http('PATCH', `/api/tracked-accounts/${tr}`, A, { instanceId: D2.id });
  check("采集手机 = D2 while D2 isn't A's → 400 tracked.phone_not_allowed", r.status === 400 && r.body.code === 'tracked.phone_not_allowed', r.text);
  await http('PUT', `/api/instances/${D2.id}/grants`, admin, { userIds: [uA] });
  r = await http('PATCH', `/api/tracked-accounts/${tr}`, A, { instanceId: D2.id });
  check("采集手机 = A's placeholder D2", r.status === 200 && r.body.account.instanceId === D2.id, r.text);
  await http('PATCH', `/api/tracked-accounts/${tr}`, A, { status: 'paused' });
  r = await http('POST', `/api/tracked-accounts/${tr}/sync`, A);
  check('tracked 同步 paused → 409 tracked.paused', r.status === 409 && r.body.code === 'tracked.paused', r.text);
  await http('PATCH', `/api/tracked-accounts/${tr}`, A, { status: 'active' });
  r = await http('POST', `/api/tracked-accounts/${tr}/sync`, A);
  const t1 = r.body?.taskId as string;
  check('tracked 同步 → 202, feed true', r.status === 202 && !!t1 && r.body.feed === true && r.body.manualOnly === false, r.text);
  const t1row = await waitTask(t1);
  check('step 1 = tracked-refresh with payload.feed, fails tracked.collector_offline', t1row.type === 'tracked-refresh' && (t1row.payload as any).feed === true
    && t1row.status === 'failed' && t1row.errorCode === 'tracked.collector_offline', `${t1row.status} ${t1row.errorCode}`);
  await sleep(1500);
  check('tracked step 1 failed → step 2 not run', (await afterTasks(t1)).length === 0);
  const before = (await db.select().from(schema.trackedAccounts).where(eq(schema.trackedAccounts.id, tr)))[0]!;
  lines.length = 0;
  const tq = await queueFeedAfter('tracked', tr, uA, t1, log);
  const tAfter = await afterTasks(t1);
  check('tracked step 2 after a successful step 1 → feed-collect (kind tracked) queued', !!(tq as any).taskId && tAfter.length === 1 && (tAfter[0]!.payload as any).kind === 'tracked' && tAfter[0]!.refType === 'tracked_account', JSON.stringify(tq));
  r = await http('GET', `/api/tracked-accounts?limit=50`, A);
  const listed = r.body.items?.find((x: any) => x.id === tr);
  check('list lastRefresh carries the task type (feed-collect while step 2 is the newest)', listed?.lastRefresh?.type === 'feed-collect', JSON.stringify(listed?.lastRefresh));
  const tf = await waitTask((tq as any).taskId);
  const afterRow = (await db.select().from(schema.trackedAccounts).where(eq(schema.trackedAccounts.id, tr)))[0]!;
  check('tracked step 2 fails feed.offline, the account row is untouched by it', tf.status === 'failed' && tf.errorCode === 'feed.offline'
    && afterRow.status === before.status && afterRow.lastErrorCode === before.lastErrorCode && String(afterRow.lastCheckedAt) === String(before.lastCheckedAt), `${tf.errorCode} ${afterRow.status}`);

  // YouTube (only with ENABLED_PLATFORMS=all on the API): 同步 = the refresh only, no feed step
  const plats = (await http('GET', '/api/platforms', A)).body;
  if ((plats?.enabled ?? []).includes('youtube')) {
    r = await http('POST', '/api/tracked-accounts', A, { input: `https://www.youtube.com/@sb${tag}` });
    const yt = r.body?.account?.id;
    r = await http('POST', `/api/tracked-accounts/${yt}/sync`, A);
    check('YouTube tracked 同步: refresh only (feed false) or refused for the missing key', (r.status === 202 && r.body.feed === false) || r.body?.code === 'tracked.youtube_no_api_key', r.text);
  }

  // ---------------------------------------------------------------- 权限管理: both endpoints belong to the menu 媒体管理 (social)
  const menus = (await http('GET', '/api/settings/role-menus', admin)).body.menus as string[];
  r = await http('PUT', '/api/settings/role-menus', admin, { menus: menus.filter((m) => m !== 'social') });
  const offS = await http('POST', `/api/social/accounts/${acc}/sync`, A);
  const offT = await http('POST', `/api/tracked-accounts/${tr}/sync`, A);
  check('menu 媒体管理 off for users → both 同步 endpoints 403 rbac.menu_disabled', r.status === 200 && offS.status === 403 && offS.body.code === 'rbac.menu_disabled'
    && offT.status === 403 && offT.body.code === 'rbac.menu_disabled', `${offS.text} ${offT.text}`);
  await http('PUT', '/api/settings/role-menus', admin, { menus });

  // ---------------------------------------------------------------- audit
  await sleep(500);
  const audits = await db.select().from(schema.auditLogs).where(and(inArray(schema.auditLogs.action, ['social.account_sync', 'tracked.sync']), sql`${schema.auditLogs.at} >= ${t0.toISOString()}::timestamptz`));
  check('audit social.account_sync (202 with taskId, 404, 400, 409) + tracked.sync (202 with feed, 404, 409)',
    audits.some((a) => a.action === 'social.account_sync' && a.status === 202 && !!(a.detail as any)?.taskId)
    && ['404', '400', '409'].every((s) => audits.some((a) => a.action === 'social.account_sync' && String(a.status) === s))
    && audits.some((a) => a.action === 'tracked.sync' && a.status === 202 && (a.detail as any)?.feed === true)
    && audits.some((a) => a.action === 'tracked.sync' && a.status === 404) && audits.some((a) => a.action === 'tracked.sync' && a.status === 409),
  audits.map((a) => `${a.action}:${a.status}`).join(','));
} catch (err) {
  check(`unexpected error: ${(err as Error).stack}`, false);
} finally {
  await db.update(T).set({ status: 'cancelled', finishedAt: new Date() }).where(and(inArray(T.status, ['pending', 'scheduled']), sql`${T.createdAt} >= ${t0.toISOString()}::timestamptz`));
  for (const id of userIds) await http('DELETE', `/api/users/${id}`, admin);
  if (devIds.length) {
    await db.delete(schema.riskEvents).where(inArray(schema.riskEvents.instanceId, devIds));
    await db.delete(schema.alertStates).where(inArray(schema.alertStates.key, devIds.map((id) => `${id}:instagram`)));
    await db.delete(schema.instances).where(inArray(schema.instances.id, devIds));
  }
  await ph.cleanup();
  await db.delete(schema.settings).where(inArray(schema.settings.key, settingKeys));
  if (saved.length) await db.insert(schema.settings).values(saved);
  const failed = results.filter(([, ok]) => !ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  await sqlClient.end();
  process.exit(failed ? 1 : 0);
}
