/**
 * Tracked accounts read on their 采集手机 (Instagram app, owner decisions 2026-11-18 / 2026-11-19). Real API, DB, BullMQ,
 * adb and the real Instagram app on the BitBrowser phone (no mocks). At most 5 profile visits on the phone
 * (natgeo, instagram, natgeo again by the scheduler, one username that does not exist); every other check
 * ends before a visit. Navigation + reading the screen only: no taps, no typing, no likes/follows.
 *
 *   TRACKED_DEVICE_MIN_INTERVAL_SEC=10 <API> ...                       # start the API with a short pace for the test
 *   E2E_API=http://127.0.0.1:3160 TRACKED_DEVICE_MIN_INTERVAL_SEC=10 npx tsx --env-file=../../.env scripts/tracked-device-check.ts [--dump <uiautomator xml>]
 *
 * Device access: like egress-check --bit, an external device row in THIS API's DB points at the adb port of the
 * phone (BIT_ADB_PORT, default 5700) whose tunnel the main API keeps open. Its source config is deliberately
 * invalid, so this API's external monitor skips it (never powers it, never opens a second tunnel); the rows are
 * removed directly from the DB at the end (no delete op: that would adb-disconnect the port the main API uses).
 * The phone must be on (running); the script stops before any visit otherwise.
 *
 * The accounts belong to the admin (an admin owner may use any phone as 采集手机), set with the batch
 * POST /api/tracked-accounts/phone. NOT re-run since the global collector setting was replaced (2026-11-19).
 *
 * Checks: count parsing (zh 万/亿, en K/M/B, commas, decimals) incl. a real dump file (--dump); RBAC (a user can't set the
 * phone on their account: not theirs → tracked.phone_not_allowed; can't list the admin's phones → 403); new Instagram
 * accounts get 定时采集 every 24 h; no 采集手机 → refresh refused with tracked.no_phone and the scheduler skips with that
 * code (no task, no alert); offline device → task fails
 * tracked.collector_offline; a viewer session on the device → deferred tracked.collector_busy; two refreshes at
 * once run one after the other with ≥ the minimum interval between their visits (the second deferred, not
 * dropped); real values (> 0, approx flags, snapshot source device, verified); a scheduled run goes through the
 * same pace; a username that does not exist → tracked.collector_profile_unavailable; halt (challenge) → refusal
 * tracked.collector_halted + collector.blocked alert, resume clears both; the phone is back on the launcher and
 * no dump file is left in /data/local/tmp; audit tracked.phone_batch.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { and, eq, inArray, sql } from 'drizzle-orm';
import WebSocket from 'ws';
import { db, schema } from '../src/db/index.js';
import { adb } from '../src/services.js';
import { classifyIgDump, parseCompactCount, parseUiDump } from '../src/modules/tracked/instagram-device.js';
import { haltDevice } from '../src/modules/tracked/collector.js';
import { withCaptcha } from './lib/login.js';

const API = process.env.E2E_API ?? `http://127.0.0.1:${process.env.API_PORT ?? 3000}`;
const BIT_PORT = Number(process.env.BIT_ADB_PORT ?? 5700);
const MIN_INTERVAL = Number(process.env.TRACKED_DEVICE_MIN_INTERVAL_SEC ?? 30);
const MAX_VISITS = 8;
const NO_SUCH_USER = 'cpnx.nosuchuser.7f3k2q';
let failed = 0;
let skipped = 0;
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed++;
}
function skip(name: string, why: string) { skipped++; console.log(`- ${name} skipped — ${why}`); }
async function http<T = any>(method: string, p: string, token: string, body?: unknown) {
  const res = await fetch(API + p, { method, headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
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
async function waitTask(taskId: string, ms = 60_000) {
  const t0 = Date.now();
  for (;;) {
    const [t] = await db.select().from(T).where(eq(T.id, taskId));
    if (t && ['success', 'failed', 'cancelled'].includes(t.status)) return t;
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for task ${taskId} (${t?.status})`);
    await sleep(500);
  }
}
/** Follows deferrals: the refresh's final task (not deferred) for this account created after `since`. */
async function waitRefreshDone(accountId: string, since: Date, ms = 120_000) {
  const t0 = Date.now();
  for (;;) {
    const rows = await db.select().from(T).where(and(eq(T.refType, 'tracked_account'), eq(T.refId, accountId), sql`${T.createdAt} >= ${since.toISOString()}::timestamptz`));
    const open = rows.filter((r) => !['success', 'failed', 'cancelled'].includes(r.status));
    const done = rows.filter((r) => r.status === 'failed' || (r.status === 'success' && (r.result as any)?.outcome !== 'deferred'));
    if (!open.length && done.length) return { final: done[done.length - 1]!, all: rows };
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for the refresh of ${accountId}`);
    await sleep(1000);
  }
}
async function visitLogs(taskIds: string[]) {
  if (!taskIds.length) return [];
  return db.select().from(schema.taskLogs).where(and(inArray(schema.taskLogs.taskId, taskIds), eq(schema.taskLogs.message, 'collector: visit started')));
}
const allVisits = new Set<string>();
async function countVisits(taskIds: string[]) {
  for (const l of await visitLogs(taskIds)) allVisits.add(l.id);
}

const startedAt = new Date();
const admin = await login(process.env.ADMIN_USERNAME!, process.env.ADMIN_PASSWORD!);
const tag = randomBytes(3).toString('hex');
const pw = randomBytes(12).toString('hex');
let userId: string | null = null;
const accountIds: string[] = [];
const extRows: { source: string; instance: string }[] = [];
const touchedTasks: string[] = [];

async function extDevice(name: string, adbPort: number, running: boolean) {
  const [src] = await db.insert(schema.deviceSources).values({ type: 'bitbrowser', name: `tdchk-src-${name}-${tag}`, config: { apiUrl: 'not a url' } }).returning();
  const [row] = await db.insert(schema.instances).values({
    name: `tdchk-${name}-${tag}`, engine: 'bitbrowser', sourceId: src!.id, externalId: `tdchk-${name}`, profile: 'bitbrowser', image: '',
    adbPort, status: running ? 'running' : 'stopped', adbState: running ? 'device' : null, bootCompleted: running, spec: { width: 720, height: 1280, dpi: 320 },
  }).returning();
  extRows.push({ source: src!.id, instance: row!.id });
  return row!;
}
/** 采集手机 of the test accounts (batch, as the admin who owns them). */
const setPhone = (instanceId: string | null, token = admin) => http('POST', '/api/tracked-accounts/phone', token, { ids: accountIds, instanceId });
const account = async (id: string) => (await http('GET', `/api/tracked-accounts/${id}`, admin)).body.account;

try {
  // ---------------------------------------------------------------- parsing (pure functions, real strings)
  const cases: [string, number, boolean][] = [
    ['195', 195, false], ['1,234', 1234, false], ['12,345,678', 12345678, false], ['3.2万', 32000, true], ['2.6亿', 260000000, true],
    ['12万', 120000, true], ['1.5億', 150000000, true], ['12.5K', 12500, true], ['1M', 1000000, true], ['2.3B', 2300000000, true],
    ['1,5M', 1500000, true], ['999', 999, false], ['１２３', 123, false],
  ];
  const badParse = cases.filter(([s, v, a]) => { const r = parseCompactCount(s); return !r || r.value !== v || r.approx !== a; });
  check(`count parsing: ${cases.length} forms (万/亿, K/M/B, commas, decimals)`, badParse.length === 0, badParse.map((c) => c[0]).join(' '));
  check('count parsing rejects non-numbers', ['', 'abc', '1.2.3万', '12.5'].every((s) => parseCompactCount(s) === null));
  const dumpArg = process.argv.indexOf('--dump');
  if (dumpArg > 0) {
    const nodes = parseUiDump(readFileSync(process.argv[dumpArg + 1]!, 'utf8'));
    const s = classifyIgDump(nodes, 'natgeo');
    check('real natgeo dump: profile, 2.6亿 / 195 / 3.2万, approx flags, verified, name, bio',
      s.kind === 'profile' && s.counts.followers?.value === 260_000_000 && s.counts.followers.approx && s.counts.following?.value === 195 && !s.counts.following.approx
      && s.counts.posts?.value === 32_000 && s.counts.posts.approx && s.verified && s.displayName === 'National Geographic' && !!s.bio?.startsWith('Step into wonder'),
      JSON.stringify(s).slice(0, 300));
    check('real natgeo dump: another handle on screen is not taken as the profile', classifyIgDump(nodes, 'instagram').kind === 'other');
  } else skip('real dump parsing', 'pass --dump <uiautomator xml of a profile>');

  // ---------------------------------------------------------------- RBAC + validation
  const u = await http('POST', '/api/users', admin, { username: `tdc${tag}`, password: pw, role: 'user' });
  userId = u.body.user?.id ?? u.body.id;
  const user = await login(`tdc${tag}`, pw);
  const meId = (await http('GET', '/api/auth/me', admin)).body.user.id as string;
  const ru = await http('GET', `/api/tracked-accounts/phones?ownerId=${meId}`, user);
  check("a user can't list the admin's phones (403 tracked.admin_only)", ru.status === 403 && ru.body?.code === 'tracked.admin_only', `${ru.status}`);

  // ---------------------------------------------------------------- default schedule + unset collector
  const mk = async (input: string) => {
    const r = await http('POST', '/api/tracked-accounts', admin, { input, instanceId: null });
    if (r.status !== 201) throw new Error(`create ${input}: ${r.status} ${r.text}`);
    accountIds.push(r.body.account.id);
    return r.body.account;
  };
  const natgeo = await mk('https://www.instagram.com/natgeo/');
  const insta = await mk('https://www.instagram.com/instagram/');
  const nouser = await mk(`https://www.instagram.com/${NO_SUCH_USER}/`);
  check('new Instagram tracked accounts: 定时采集 every 24 h by default, next slot within the hour',
    [natgeo, insta, nouser].every((a) => a.refreshIntervalHours === 24 && a.nextRefreshAt && Date.parse(a.nextRefreshAt) - Date.now() <= 3600_000 && Date.parse(a.nextRefreshAt) > Date.now() - 60_000));
  check('no 采集手机: dataMode device_unconfigured', natgeo.dataMode === 'device_unconfigured', natgeo.dataMode);
  let r = await http('POST', `/api/tracked-accounts/${natgeo.id}/refresh`, admin);
  check('no 采集手机: refresh refused 400 tracked.no_phone', r.status === 400 && r.body?.code === 'tracked.no_phone', r.text.slice(0, 120));
  // Scheduler with no phone: skipped with the code, no task.
  await db.update(schema.trackedAccounts).set({ nextRefreshAt: new Date(Date.now() - 60_000) }).where(eq(schema.trackedAccounts.id, natgeo.id));
  const run1 = await http('POST', '/api/collection/run', admin);
  await waitTask(run1.body.task.id);
  const n1 = await account(natgeo.id);
  const t1 = await db.select().from(T).where(and(eq(T.refType, 'tracked_account'), eq(T.refId, natgeo.id)));
  check('no 采集手机: scheduled slot skipped with tracked.no_phone, no task, next slot advanced',
    n1.scheduleSkipCode === 'tracked.no_phone' && t1.length === 0 && Date.parse(n1.nextRefreshAt) > Date.now(), `${n1.scheduleSkipCode} tasks=${t1.length}`);
  const alertsUnset = await db.select().from(schema.notifications).where(sql`${schema.notifications.createdAt} >= ${startedAt.toISOString()}::timestamptz and ${schema.notifications.kind} in ('task.failed', 'collector.blocked')`);
  check('no 采集手机: no alert raised', alertsUnset.length === 0);

  // ---------------------------------------------------------------- offline device
  const off = await extDevice('off', 5798, false);
  const otherUserPhone = await http('PATCH', `/api/tracked-accounts/${natgeo.id}`, user, { instanceId: off.id });
  check("a user can't touch the admin's account (404)", otherUserPhone.status === 404);
  const offSet = await setPhone(off.id);
  check('admin sets an (offline) 采集手机 on the 3 accounts (batch)', offSet.status === 200 && offSet.body.updated.length === 3, offSet.text.slice(0, 160));
  r = await http('POST', `/api/tracked-accounts/${natgeo.id}/refresh`, admin);
  const offTask = await waitTask(r.body.taskId);
  touchedTasks.push(offTask.id);
  check('offline 采集手机: task fails tracked.collector_offline (no visit)', offTask.status === 'failed' && offTask.errorCode === 'tracked.collector_offline', `${offTask.status} ${offTask.errorCode}`);
  check('offline 采集手机: account error with the code', (await account(natgeo.id)).lastErrorCode === 'tracked.collector_offline');

  // ---------------------------------------------------------------- the real phone
  const serial = adb.serialFor(BIT_PORT);
  if ((await adb.states()).get(serial) !== 'device') throw new Error(`${serial} not attached: the phone is off or the main API's tunnel is down — stopping before any visit`);
  const top = await adb.shell(BIT_PORT, 'dumpsys activity activities | grep " ResumedActivity"');
  console.log(`   phone before: ${top.trim().slice(0, 140)}`);
  const phone = await extDevice('bit', BIT_PORT, true);
  const set = await setPhone(phone.id);
  const pv = (await account(natgeo.id)).phone;
  const pace = (await http('GET', '/api/tracked-accounts/capacity', admin)).body.pace;
  check('采集手机 set to the phone: the account shows it online, not halted; pace as configured',
    set.status === 200 && pv?.id === phone.id && pv.online === true && !pv.halted && pace.minIntervalSec === MIN_INTERVAL, JSON.stringify({ pv, pace }));
  check('dataMode device; /platforms reports a device source for Instagram',
    (await account(natgeo.id)).dataMode === 'device' && (await http('GET', '/api/tracked-accounts/platforms', admin)).body.platforms.find((p: any) => p.id === 'instagram')?.api?.kind === 'device');

  // ---- viewer busy (a remote-control session open on the phone, no input sent)
  const ws = new WebSocket(`${API.replace(/^http/, 'ws')}/api/instances/${phone.id}/session`);
  const ready = await new Promise<string>((resolve) => {
    const timer = setTimeout(() => resolve('timeout'), 15_000);
    ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', token: admin })));
    ws.on('message', (d, bin) => { if (bin) return; const m = JSON.parse(d.toString()); if (m.type === 'ready' || m.type === 'error') { clearTimeout(timer); resolve(m.type === 'ready' ? 'ready' : m.message); } });
    ws.on('error', (e) => { clearTimeout(timer); resolve(e.message); });
  });
  if (ready !== 'ready') skip('viewer busy', `session did not open: ${ready}`);
  else {
    const since = new Date();
    r = await http('POST', `/api/tracked-accounts/${natgeo.id}/refresh`, admin);
    const bt = await waitTask(r.body.taskId);
    touchedTasks.push(bt.id);
    const res = bt.result as any;
    const next = res?.taskId ? (await db.select().from(T).where(eq(T.id, res.taskId)))[0] : undefined;
    check('viewer on the device: refresh deferred (tracked.collector_busy), new scheduled task, no visit',
      bt.status === 'success' && res?.outcome === 'deferred' && res.code === 'tracked.collector_busy' && next?.status === 'scheduled'
      && (await visitLogs([bt.id])).length === 0, JSON.stringify(res));
    if (next) { touchedTasks.push(next.id); await http('POST', `/api/tasks/${next.id}/cancel`, admin); }
    void since;
  }
  ws.close();
  await sleep(1000);

  // ---- two refreshes at once: serial, ≥ MIN_INTERVAL apart, real values
  const since2 = new Date();
  r = await http('POST', '/api/tracked-accounts/refresh', admin, { ids: [natgeo.id, insta.id] });
  check('batch refresh queued both', r.status === 202 && r.body.queued.length === 2, r.text.slice(0, 160));
  const [dn, di] = await Promise.all([waitRefreshDone(natgeo.id, since2), waitRefreshDone(insta.id, since2)]);
  const pairTasks = [...dn.all, ...di.all].map((t) => t.id);
  touchedTasks.push(...pairTasks);
  await countVisits(pairTasks);
  const visits = (await visitLogs(pairTasks)).map((l) => Date.parse((l.data as any).at)).sort((a, b) => a - b);
  const deferred = [...dn.all, ...di.all].filter((t) => (t.result as any)?.outcome === 'deferred').map((t) => (t.result as any).code);
  check(`two refreshes: one visit each, ≥ ${MIN_INTERVAL} s apart (the other deferred, not dropped)`,
    visits.length === 2 && visits[1]! - visits[0]! >= MIN_INTERVAL * 1000 && deferred.length >= 1 && dn.final.status === 'success' && di.final.status === 'success',
    `gap ${visits.length === 2 ? ((visits[1]! - visits[0]!) / 1000).toFixed(1) : '?'} s, deferred: ${deferred.join(',')}`);
  for (const d of [dn, di]) {
    if (d.final.status === 'success') continue;
    const logs = await db.select().from(schema.taskLogs).where(eq(schema.taskLogs.taskId, d.final.id));
    console.log(`   ${d.final.instanceName}: ${d.final.status} ${d.final.errorCode} ${d.final.error}`);
    for (const l of logs) console.log(`     ${l.level} ${l.message} ${l.data ? JSON.stringify(l.data).slice(0, 400) : ''}`);
  }
  const an = await account(natgeo.id);
  const ai = await account(insta.id);
  console.log(`   natgeo: followers ${an.latest?.followers} following ${an.latest?.following} posts ${an.latest?.posts} approx ${an.latest?.approx} name "${an.displayName}" verified ${an.verified}`);
  console.log(`   instagram: followers ${ai.latest?.followers} following ${ai.latest?.following} posts ${ai.latest?.posts} approx ${ai.latest?.approx} name "${ai.displayName}" verified ${ai.verified}`);
  for (const [h, a] of [['natgeo', an], ['instagram', ai]] as const) {
    check(`${h}: followers / following / posts > 0, snapshot source device, account active`,
      a.latest?.source === 'device' && a.latest.followers > 0 && a.latest.following > 0 && a.latest.posts > 0 && a.lastSource === 'device' && a.status === 'active' && !a.lastErrorCode);
    check(`${h}: followers marked approximate (the app abbreviates ≥ 10 000), verified, display name read`,
      a.latest?.approx.includes('followers') && a.latest.followers >= 1e6 && a.verified === true && !!a.displayName);
  }
  check('natgeo: following is exact (not abbreviated), posts approximate', an.latest?.approx && !an.latest.approx.includes('following') && an.latest.approx.includes('posts'));
  const snaps = await db.select().from(schema.trackedAccountSnapshots).where(inArray(schema.trackedAccountSnapshots.trackedAccountId, [natgeo.id, insta.id]));
  check('snapshots stored with source device and approx list', snaps.length === 2 && snaps.every((s) => s.source === 'device' && (s.approx ?? []).includes('followers')));

  // ---- a scheduled run goes through the same pace
  const since3 = new Date();
  await db.update(schema.trackedAccounts).set({ nextRefreshAt: new Date(Date.now() - 60_000), scheduleSkipCode: null }).where(eq(schema.trackedAccounts.id, natgeo.id));
  const run2 = await http('POST', '/api/collection/run', admin);
  await waitTask(run2.body.task.id);
  const ds = await waitRefreshDone(natgeo.id, since3);
  touchedTasks.push(...ds.all.map((t) => t.id));
  await countVisits(ds.all.map((t) => t.id));
  const first = ds.all.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0]!;
  const sv = (await visitLogs(ds.all.map((t) => t.id))).map((l) => Date.parse((l.data as any).at));
  const lastPair = Math.max(...visits);
  check('scheduled refresh (key scheduled:…) reads the profile again, paced after the previous visit',
    (first.payload as any).scheduled === true && !!first.idempotencyKey?.startsWith('scheduled:') && ds.final.status === 'success' && sv.length === 1 && sv[0]! - lastPair >= MIN_INTERVAL * 1000,
    `${ds.all.length} task(s), ${(sv[0]! - lastPair) / 1000} s after the previous visit`);
  const n3 = await account(natgeo.id);
  check('scheduled: next slot advanced by 24 h, no skip code', !n3.scheduleSkipCode && Date.parse(n3.nextRefreshAt) > Date.now() + 22 * 3600_000);

  // ---- a username that does not exist
  const since4 = new Date();
  r = await http('POST', `/api/tracked-accounts/${nouser.id}/refresh`, admin);
  const dx = await waitRefreshDone(nouser.id, since4);
  touchedTasks.push(...dx.all.map((t) => t.id));
  await countVisits(dx.all.map((t) => t.id));
  const ax = await account(nouser.id);
  check('unknown username: task fails tracked.collector_profile_unavailable, account error with that code',
    dx.final.status === 'failed' && dx.final.errorCode === 'tracked.collector_profile_unavailable' && ax.status === 'error' && ax.lastErrorCode === 'tracked.collector_profile_unavailable',
    `${dx.final.status} ${dx.final.errorCode}`);
  const excerpt = (await db.select().from(schema.taskLogs).where(and(eq(schema.taskLogs.taskId, dx.final.id), eq(schema.taskLogs.message, 'collector: profile not available'))))[0];
  check('failure log keeps a short excerpt, not the dump', !!excerpt && String((excerpt.data as any)?.excerpt ?? '').length <= 300 && !String((excerpt.data as any)?.excerpt).includes('<node'));

  // ---- halt (as on a challenge screen) → refusal + alert; resume clears both
  await haltDevice(phone, { code: 'tracked.collector_challenge', source: 'collector', platform: 'instagram' });
  const h1 = { halted: (await http('GET', '/api/instances/automation', admin)).body.devices?.[phone.id]?.halted };
  r = await http('POST', `/api/tracked-accounts/${insta.id}/refresh`, admin);
  const [blocked] = await db.select().from(schema.notifications).where(and(eq(schema.notifications.kind, 'collector.blocked'), eq(schema.notifications.refId, phone.id)));
  check('halted: state shows it, refresh refused 409 tracked.collector_halted, collector.blocked alert to admins',
    !!h1.halted && h1.halted.code === 'tracked.collector_challenge' && r.status === 409 && r.body?.code === 'tracked.collector_halted' && !!blocked && !blocked.recovered,
    `${r.status} ${r.body?.code}`);
  check('halted: dataMode device_unconfigured', (await account(insta.id)).dataMode === 'device_unconfigured');
  const resumed = await http('POST', `/api/risk/devices/${phone.id}/resume`, admin);
  const [st] = await db.select().from(schema.alertStates).where(and(eq(schema.alertStates.kind, 'collector.blocked'), eq(schema.alertStates.key, `${phone.id}:instagram`)));
  check('resume (device card): halt cleared, alert state recovered', resumed.status === 200 && resumed.body.resumed === true && !(await account(insta.id)).phone?.halted && st?.active === false);
  const audit = await db.select().from(schema.auditLogs).where(and(eq(schema.auditLogs.action, 'tracked.phone_batch'), sql`${schema.auditLogs.at} >= ${startedAt.toISOString()}::timestamptz`));
  check('采集手机 changes are audited (tracked.phone_batch)', audit.length >= 2);

  // ---- the phone afterwards
  const after = await adb.shell(BIT_PORT, 'dumpsys activity activities | grep " ResumedActivity"; ls /data/local/tmp');
  check('phone back on the launcher, no dump file left in /data/local/tmp', /Launcher/.test(after) && !/cp-ig-.*\.xml/.test(after), after.split('\n')[0]?.trim().slice(0, 140));
  check(`profile visits in this run: ${allVisits.size} (≤ ${MAX_VISITS})`, allVisits.size <= MAX_VISITS && allVisits.size === 4);
} catch (err) {
  failed++;
  console.error('✗', (err as Error).message);
} finally {
  if (accountIds.length) await db.delete(schema.trackedAccounts).where(inArray(schema.trackedAccounts.id, accountIds));
  for (const e of extRows) {
    await db.delete(schema.tasks).where(eq(schema.tasks.instanceId, e.instance));
    await db.delete(schema.instances).where(eq(schema.instances.id, e.instance));
    await db.delete(schema.deviceSources).where(eq(schema.deviceSources.id, e.source));
  }
  if (touchedTasks.length) await db.delete(schema.tasks).where(inArray(schema.tasks.id, touchedTasks));
  if (userId) await http('DELETE', `/api/users/${userId}`, admin);
  console.log(`\n${failed ? `${failed} FAILED` : 'all passed'}${skipped ? `, ${skipped} skipped` : ''}`);
  process.exit(failed ? 1 : 0);
}
