/**
 * 社交号自动检测 on a real cloud phone (owner decision 2026-11-18): real API, DB, BullMQ, adb and the real Instagram
 * app on the BitBrowser phone bit-ins-02 (no mocks). At most 4 Instagram screens are opened (MAX_IG_OPENS; this run
 * opens 2: the own profile for the matching account and again for an account whose handle does not match); every
 * other case ends before the app is opened. Navigation + reading the screen only: no taps, no typing.
 *
 *   E2E_API=http://127.0.0.1:<port> API_PORT=<port> npx tsx --env-file=../../.env scripts/account-device-check.ts [--handle conchadoroperto650 --external-id 78090361572]
 *
 * Device access like tracked-device-check / egress-check --bit: an inert external device row in THIS API's DB points
 * at the adb port (BIT_ADB_PORT, default 5700) whose tunnel the main API keeps open; its source config is invalid,
 * so this API's monitor never powers it or opens a second tunnel; rows are removed from the DB at the end. The phone
 * must be on (adb `device`), otherwise the script stops before anything touches it. The automatic schedule is
 * switched off for the run (no extra visits), the pace set to 10 s.
 *
 * Checks: unsupported platform / no device → coded 400 before queueing; RBAC (another user 404, owner + admin 202);
 * 立即检测 = task account-device-check on its own queue; a second request while one is queued → 409; offline device
 * → result offline (no risk event, login status kept); externalId not among the phone's accounts → wrong_account
 * without opening the app; the real account → ok, logged_in, counts in today's social_account_stats row (source
 * device, approx flags), account log, analytics summary shows it; a fake handle on the same phone → wrong_account
 * with the username actually seen, account.problem alert, risk event; phone back on the launcher, no dump left.
 */
import { randomBytes } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db, schema, sqlClient } from '../src/db/index.js';
import { adb } from '../src/services.js';
import { withCaptcha } from './lib/login.js';
import { linkAccount } from './lib/social-link.js';

const API = process.env.E2E_API ?? `http://127.0.0.1:${process.env.API_PORT ?? 3000}`;
const BIT_PORT = Number(process.env.BIT_ADB_PORT ?? 5700);
const arg = (n: string, d: string) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1]! : d; };
const HANDLE = arg('--handle', 'conchadoroperto650');
const EXTERNAL_ID = arg('--external-id', '78090361572');
const MAX_IG_OPENS = 4;
const results: [string, boolean][] = [];
const check = (name: string, ok: boolean, detail = '') => { results.push([name, ok]); console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`); };
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
/** The check of this account created after `since`, following pace deferrals to the final task. */
async function waitCheck(accountId: string, since: Date, ms = 150_000) {
  const t0 = Date.now();
  for (;;) {
    const rows = await db.select().from(T).where(and(eq(T.type, 'account-device-check'), eq(T.refId, accountId), sql`${T.createdAt} >= ${since.toISOString()}::timestamptz`));
    const open = rows.filter((r) => !['success', 'failed', 'cancelled'].includes(r.status));
    const done = rows.filter((r) => r.status === 'failed' || (r.status === 'success' && (r.result as any)?.outcome !== 'deferred'));
    if (!open.length && done.length) return { final: done[done.length - 1]!, all: rows };
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for the check of ${accountId}`);
    await sleep(1000);
  }
}
const account = async (token: string, id: string) => (await http('GET', `/api/social/accounts/${id}`, token)).body.account;

const admin = await login(process.env.ADMIN_USERNAME!, process.env.ADMIN_PASSWORD!);
const tag = randomBytes(3).toString('hex');
const pw = randomBytes(12).toString('base64url');
const userIds: string[] = [];
const extRows: { source: string; instance: string }[] = [];
const touchedTasks = new Set<string>();
const settingKeys = ['risk.device', 'social.limits'];
const savedSettings = await db.select().from(schema.settings).where(inArray(schema.settings.key, settingKeys));
const accIds: string[] = [];

async function extDevice(name: string, adbPort: number, running: boolean) {
  const [src] = await db.insert(schema.deviceSources).values({ type: 'bitbrowser', name: `adchk-src-${name}-${tag}`, config: { apiUrl: 'not a url' } }).returning();
  const [row] = await db.insert(schema.instances).values({
    name: `adchk-${name}-${tag}`, engine: 'bitbrowser', sourceId: src!.id, externalId: `adchk-${name}`, profile: 'bitbrowser', image: '',
    adbPort, status: running ? 'running' : 'stopped', adbState: running ? 'device' : null, bootCompleted: running, spec: { width: 720, height: 1280, dpi: 320 },
  }).returning();
  extRows.push({ source: src!.id, instance: row!.id });
  return row!;
}
const igOpens = async (taskIds: string[]) => taskIds.length
  ? (await db.select({ id: schema.taskLogs.id }).from(schema.taskLogs).where(and(inArray(schema.taskLogs.taskId, taskIds), eq(schema.taskLogs.message, 'collector: profile link opened')))).length : 0;

try {
  // ---------------------------------------------------------------- the phone must be on (read-only probe)
  const serial = adb.serialFor(BIT_PORT);
  if ((await adb.states()).get(serial) !== 'device') throw new Error(`${serial} is not attached: bit-ins-02 is off or the main API's tunnel is down — stopping before anything touches it`);
  const before = await adb.shell(BIT_PORT, 'dumpsys activity activities | grep " ResumedActivity"');
  console.log(`   phone before: ${before.trim().slice(0, 140)}`);

  // No scheduled checks during the run (only the ones requested here), a short pace, room for 3 IG accounts on the phone.
  check('pace 10 s, automatic schedule off for the run', (await http('PUT', '/api/risk/settings', admin, { minIntervalSec: 10, accountCheckHours: null })).status === 200);
  await http('PUT', '/api/social/settings', admin, { limits: { instagram: 3 } });

  for (const n of ['u', 'v']) {
    const r = await http('POST', '/api/users', admin, { username: `ad${n}${tag}`, password: pw, role: 'user' });
    userIds.push(r.body.user?.id ?? r.body.id);
  }
  const [uU] = userIds as [string, string];
  const U = await login(`adu${tag}`, pw);
  const V = await login(`adv${tag}`, pw);

  const phone = await extDevice('bit', BIT_PORT, true);
  const off = await extDevice('off', 5798, false);
  const mk = async (body: Record<string, unknown>) => {
    const r = await http('POST', '/api/social/accounts', admin, { platform: 'instagram', ownerId: uU, ...body });
    if (r.status !== 201) throw new Error(`account create failed: ${r.text}`);
    accIds.push(r.body.account.id);
    // device link: read only in the API since 2026-11-18 (set by 从云手机同步); written with the sync's rules (lib/social-link.ts)
    if (typeof body.instanceId === 'string') {
      await linkAccount(r.body.account.id, body.instanceId);
      return (await http('GET', `/api/social/accounts/${r.body.account.id}`, admin)).body.account as { id: string; autoCheckUnsupported: string | null };
    }
    return r.body.account as { id: string; autoCheckUnsupported: string | null };
  };
  const real = await mk({ handle: HANDLE, externalId: EXTERNAL_ID, instanceId: phone.id });
  const fake = await mk({ handle: `cpnx_fake_${tag}`, instanceId: phone.id });
  const wrongId = await mk({ handle: `cpnx_wid_${tag}`, externalId: '1', instanceId: phone.id });
  const noDev = await mk({ handle: `cpnx_nodev_${tag}` });
  const offAcc = await mk({ handle: `cpnx_off_${tag}`, instanceId: off.id });
  const [tt] = await db.insert(schema.socialAccounts).values({ userId: uU, platform: 'tiktok', handle: `cpnx_tt_${tag}`, instanceId: phone.id }).returning();
  accIds.push(tt!.id);

  // ---------------------------------------------------------------- refusals before queueing, RBAC
  let r = await http('POST', `/api/social/accounts/${noDev.id}/check`, U);
  check('no device → 400 account_check.no_device (list says so too)', r.status === 400 && r.body.code === 'account_check.no_device' && noDev.autoCheckUnsupported === 'account_check.no_device', r.text);
  r = await http('POST', `/api/social/accounts/${tt!.id}/check`, U);
  const ttItem = await account(U, tt!.id);
  check('not Instagram → 400 account_check.unsupported_platform', r.status === 400 && r.body.code === 'account_check.unsupported_platform' && ttItem.autoCheckUnsupported === 'account_check.unsupported_platform', r.text);
  r = await http('POST', `/api/social/accounts/${offAcc.id}/check`, V);
  check('another user → 404 social.not_found', r.status === 404 && r.body.code === 'social.not_found', r.text);

  // ---------------------------------------------------------------- offline device (no adb): result offline, nothing opened
  let since = new Date(Date.now() - 2000);
  r = await http('POST', `/api/social/accounts/${offAcc.id}/check`, U);
  const dupe = await http('POST', `/api/social/accounts/${offAcc.id}/check`, U);
  const offRun = await waitCheck(offAcc.id, since);
  offRun.all.forEach((x) => touchedTasks.add(x.id));
  const offA = await account(U, offAcc.id);
  const offRisk = await db.select().from(schema.riskEvents).where(eq(schema.riskEvents.socialAccountId, offAcc.id));
  check('立即检测 by the owner → 202, task account-device-check', r.status === 202 && !!r.body.task?.id && offRun.final.type === 'account-device-check', r.text);
  check('second request while queued/running → 409 account_check.in_progress (or the first already finished)',
    dupe.status === 409 ? dupe.body.code === 'account_check.in_progress' : dupe.status === 202, dupe.text);
  if (dupe.status === 202) touchedTasks.add(dupe.body.task.id);
  check('offline device: result offline, login status kept, no risk event, no app opened',
    (offRun.final.result as any)?.result === 'offline' && offA.lastCheckCode === 'offline' && offA.loginStatus === 'unknown' && !!offA.lastCheckedAt && offRisk.length === 0
    && (await igOpens(offRun.all.map((x) => x.id))) === 0, JSON.stringify(offRun.final.result));

  // ---------------------------------------------------------------- externalId mismatch: wrong_account from dumpsys, app not opened
  since = new Date(Date.now() - 2000);
  r = await http('POST', `/api/social/accounts/${wrongId.id}/check`, admin);
  const widRun = await waitCheck(wrongId.id, since);
  widRun.all.forEach((x) => touchedTasks.add(x.id));
  const widA = await account(U, wrongId.id);
  check('admin 立即检测 → 202', r.status === 202, r.text);
  check('externalId not on the phone → wrong_account, logged_out, the app not opened',
    widA.lastCheckCode === 'wrong_account' && widA.loginStatus === 'logged_out' && /account ids on device: .*\d/.test(widA.lastCheckDetail ?? '') && (await igOpens(widRun.all.map((x) => x.id))) === 0,
    `${widA.lastCheckCode} ${widA.lastCheckDetail}`);

  // ---------------------------------------------------------------- the real account (IG open #1)
  since = new Date(Date.now() - 2000);
  r = await http('POST', `/api/social/accounts/${real.id}/check`, U);
  const okRun = await waitCheck(real.id, since);
  okRun.all.forEach((x) => touchedTasks.add(x.id));
  const okRes = okRun.final.result as any;
  const okA = await account(U, real.id);
  const day = new Date().toISOString().slice(0, 10);
  const [stat] = await db.select().from(schema.socialAccountStats).where(and(eq(schema.socialAccountStats.socialAccountId, real.id), eq(schema.socialAccountStats.day, day)));
  console.log(`   read on the phone: ${JSON.stringify(okRes?.counts ?? okRes)}`);
  check(`real account @${HANDLE}: ok, logged_in, externalId matched`, okRun.final.status === 'success' && okRes?.result === 'ok' && okA.lastCheckCode === 'ok' && okA.loginStatus === 'logged_in' && okA.lastError === null,
    `${okRun.final.status} ${JSON.stringify(okRes)} ${okA.lastCheckCode}`);
  check('counts written to today\'s social_account_stats (source device, numbers, approx flags as read)',
    !!stat && stat.source === 'device' && typeof stat.followers === 'number' && typeof stat.following === 'number' && typeof stat.posts === 'number'
    && JSON.stringify(stat.approx ?? []) === JSON.stringify(okRes?.counts?.approx ?? []), JSON.stringify(stat));
  const logs = await db.select().from(schema.socialAccountLogs).where(eq(schema.socialAccountLogs.accountId, real.id));
  check('account log: check result + login status change (system actor)', logs.some((l) => l.action === 'checked' && l.toValue === 'ok' && l.actorId === null)
    && logs.some((l) => l.action === 'status' && l.field === 'loginStatus' && l.toValue === 'logged_in'), logs.map((l) => `${l.action}:${l.toValue}`).join(','));
  const sum = (await http('GET', '/api/analytics/summary?days=7', U)).body;
  const sa = sum.accounts?.find((a: any) => a.id === real.id);
  check('账号分析 shows the reading (latest followers, source device)', sa?.latest?.source === 'device' && sa.latest.followers === stat?.followers && sum.totals.withData >= 1, JSON.stringify(sa?.latest));
  check('ok: no risk event', (await db.select().from(schema.riskEvents).where(eq(schema.riskEvents.socialAccountId, real.id))).length === 0);

  // ---------------------------------------------------------------- handle that is not the logged-in one (IG open #2, paced)
  since = new Date(Date.now() - 2000);
  r = await http('POST', `/api/social/accounts/${fake.id}/check`, U);
  const fkRun = await waitCheck(fake.id, since);
  fkRun.all.forEach((x) => touchedTasks.add(x.id));
  const fkA = await account(U, fake.id);
  const fkRisk = await db.select().from(schema.riskEvents).where(eq(schema.riskEvents.socialAccountId, fake.id));
  const [alert] = await db.select().from(schema.alertStates).where(and(eq(schema.alertStates.kind, 'account.problem'), eq(schema.alertStates.key, fake.id)));
  check('fake handle on the same phone → wrong_account with the username seen', fkA.lastCheckCode === 'wrong_account' && fkA.loginStatus === 'logged_out'
    && (fkA.lastCheckDetail ?? '').toLowerCase() === `@${HANDLE}`.toLowerCase(), `${fkA.lastCheckCode} ${fkA.lastCheckDetail}`);
  check('wrong_account: risk event (account_check.wrong_account) + account.problem alert', fkRisk.some((e) => e.code === 'account_check.wrong_account' && e.instanceId === phone.id) && alert?.active === true,
    JSON.stringify(fkRisk.map((e) => e.code)));
  const okTimes = okRun.all.map((x) => x.startedAt?.getTime() ?? 0).filter(Boolean);
  const fkStart = Math.max(...fkRun.all.map((x) => x.startedAt?.getTime() ?? 0));
  check('pace shared on the phone: the second visit ≥ 10 s after the first', fkStart - Math.max(...okTimes) >= 9_000 || fkRun.all.some((x) => (x.result as any)?.outcome === 'deferred'),
    `${fkStart - Math.max(...okTimes)} ms`);

  // ---------------------------------------------------------------- the phone afterwards, visit budget
  const opens = await igOpens([...touchedTasks]);
  check(`Instagram screens opened by this run: ${opens} (≤ ${MAX_IG_OPENS})`, opens >= 1 && opens <= MAX_IG_OPENS);
  const after = await adb.shell(BIT_PORT, 'dumpsys activity activities | grep " ResumedActivity"; ls /data/local/tmp');
  check('phone back on the launcher, no dump file left in /data/local/tmp', /Launcher/.test(after) && !/cp-ig-.*\.xml/.test(after), after.split('\n')[0]?.trim().slice(0, 140));
  const devs = (await http('GET', '/api/risk/devices', admin)).body.devices;
  const ph = devs?.find((d: any) => d.id === phone.id);
  check('风控 page: the phone listed (3 checked accounts, visits in the last hour, last visit set, not halted)', !!ph && ph.checkedAccounts === 3 && ph.visitsLastHour >= 3 && !!ph.lastVisitAt && !ph.halted, JSON.stringify(ph));
} catch (err) {
  check(`stopped: ${(err as Error).message}`, false);
} finally {
  const pending = [...touchedTasks];
  if (pending.length) await db.update(T).set({ status: 'cancelled', finishedAt: new Date() }).where(and(inArray(T.id, pending), inArray(T.status, ['pending', 'scheduled'])));
  if (accIds.length) {
    const left = await db.select({ id: T.id }).from(T).where(and(eq(T.type, 'account-device-check'), inArray(T.refId, accIds)));
    if (left.length) await db.delete(T).where(inArray(T.id, left.map((x) => x.id)));
    await db.delete(schema.riskEvents).where(inArray(schema.riskEvents.socialAccountId, accIds));
    await db.delete(schema.alertStates).where(inArray(schema.alertStates.key, accIds));
  }
  for (const id of userIds) await http('DELETE', `/api/users/${id}`, admin);
  for (const e of extRows) {
    await db.delete(schema.riskEvents).where(eq(schema.riskEvents.instanceId, e.instance));
    await db.delete(schema.instances).where(eq(schema.instances.id, e.instance));
    await db.delete(schema.deviceSources).where(eq(schema.deviceSources.id, e.source));
  }
  await db.delete(schema.settings).where(inArray(schema.settings.key, settingKeys));
  if (savedSettings.length) await db.insert(schema.settings).values(savedSettings);
  const failed = results.filter(([, ok]) => !ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  await sqlClient.end();
  process.exit(failed ? 1 : 0);
}
