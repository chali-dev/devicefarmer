/**
 * 风控 page (owner decision 2026-11-18) against the real API + DB + Redis + task centre (no mocks, no phone):
 * - settings `risk.device` (pace + account-check interval): admin read/write, range validation, non-admins 403,
 *   a save takes effect at once (GET /api/tracked-accounts/capacity shows the new pace);
 * - device state (moved from the 风控 page to the 云机管理 cards on 2026-11-18): placeholder devices (no adb, ports
 *   5581–5582), a device halt (haltDevice, as on a challenge screen) shows in GET /api/instances/automation (code,
 *   source; only for devices the viewer may see) and raises collector.blocked; a held device lock shows as busy with
 *   what runs (lock value written as withDevice writes it; a bare token of an older version reads as `auto`);
 *   恢复 clears the halt and recovers the alert; /api/risk/devices (filter source of 风控记录) still lists it;
 * - 风控记录: list newest first, filters by device / code, paging, code facet, 90-day purge by the hourly
 *   system maintenance (POST /api/system/maintenance);
 * - 账号上限 from its new entry (PUT /api/social/settings) is enforced when linking;
 * - comment replies without approval, draft first: a user's reply is a draft (no task) until 排程 (POST …/submit),
 *   which goes straight to `scheduled` (send task created) and on to awaiting_operator; the approve/reject endpoints are gone (404); the rules have no requireApproval
 *   (refused by the strict schema); the data migration moves seeded pending_review / approved rows on (live
 *   task kept, others get a task row), logs `approval removed`, and a second run changes nothing;
 * - power of external phones is admin only (owner decision 2026-11-18): an inert external placeholder (invalid source
 *   config, nothing listens; never a real BitBrowser phone) granted to the user: start / stop / restart → 403
 *   instances.external_power_admin_only and no task; in a batch the external one is skipped with that code while the
 *   user's local device passes the RBAC layer (stop of an already stopped one = skipped, nothing runs); an admin is not
 *   refused (same stopped device → only "already stopped", no power call);
 * - audit rows of the new actions.
 * Usage (from apps/api, API running): E2E_API=http://127.0.0.1:<port> API_PORT=<port> npx tsx --env-file=../../.env scripts/risk-check.ts
 */
import { randomBytes } from 'node:crypto';
import { and, eq, inArray, like } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { db, schema, sqlClient } from '../src/db/index.js';
import { migrateCommentApproval } from '../src/db/comment-approval-migration.js';
import { recordRiskEvent } from '../src/modules/risk/events.js';
import { haltDevice } from '../src/modules/tracked/collector.js';
import { scheduleAccountDeviceChecks } from '../src/modules/social/check.js';
import { withCaptcha } from './lib/login.js';
import { tryLink } from './lib/social-link.js';

const API = process.env.E2E_API ?? `http://127.0.0.1:${process.env.API_PORT ?? 3000}`;
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
async function waitFor<T>(label: string, fn: () => Promise<T | null | false | undefined>, ms = 60_000): Promise<T> {
  const t0 = Date.now();
  for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() - t0 > ms) throw new Error(`timeout: ${label}`); await new Promise((r) => setTimeout(r, 300)); }
}

const T = await login(process.env.ADMIN_USERNAME!, process.env.ADMIN_PASSWORD!);
const tag = randomBytes(3).toString('hex');
const pw = randomBytes(12).toString('base64url');
const settingKeys = ['risk.device', 'social.limits', 'comments.rules', 'risk.halts'];
const savedSettings = await db.select().from(schema.settings).where(inArray(schema.settings.key, settingKeys));
const t0 = new Date((await sqlClient`select now() as now`)[0]!.now as Date);
let userId: string | null = null;
const devIds: string[] = [];
const extraTaskIds: string[] = [];

try {
  const u = await http('POST', '/api/users', T, { username: `rk${tag}`, password: pw, role: 'user' });
  userId = u.body.user?.id ?? u.body.id;
  const U = await login(`rk${tag}`, pw);

  // ---------------------------------------------------------------- settings: RBAC, defaults, validation
  await db.delete(schema.settings).where(eq(schema.settings.key, 'risk.device'));
  let r = await http('GET', '/api/risk/settings', T);
  const env = { min: Number(process.env.TRACKED_DEVICE_MIN_INTERVAL_SEC ?? 30), max: Number(process.env.TRACKED_DEVICE_MAX_PER_HOUR ?? 60), busy: Number(process.env.TRACKED_DEVICE_BUSY_RETRY_SEC ?? 300) };
  check('admin GET /api/risk/settings: env defaults (pace) + account check every 6 h',
    r.status === 200 && r.body.device.minIntervalSec === env.min && r.body.device.maxPerHour === env.max && r.body.device.busyRetrySec === env.busy
    && r.body.device.accountCheckHours === 6 && r.body.defaults.minIntervalSec === env.min && r.body.eventRetentionDays === 90, r.text);
  const denied = await Promise.all([
    http('GET', '/api/risk/settings', U), http('PUT', '/api/risk/settings', U, { maxPerHour: 10 }), http('GET', '/api/risk/devices', U),
    http('GET', '/api/risk/events', U), http('POST', '/api/risk/devices/00000000-0000-4000-8000-000000000000/resume', U),
  ]);
  check('non-admin: every /api/risk endpoint 403', denied.every((x) => x.status === 403), denied.map((x) => x.status).join(','));
  const bad = await Promise.all([
    { minIntervalSec: 4 }, { minIntervalSec: 3601 }, { maxPerHour: 0 }, { maxPerHour: 601 }, { busyRetrySec: 4 }, { accountCheckHours: 0 }, { accountCheckHours: 169 },
    { minIntervalSec: 10.5 }, { foo: 1 }, {},
  ].map((b) => http('PUT', '/api/risk/settings', T, b)));
  check('validation: out-of-range / fractional / unknown / empty bodies → 400', bad.every((x) => x.status === 400), bad.map((x) => x.status).join(','));

  // ---------------------------------------------------------------- pace takes effect at once
  const cap0 = (await http('GET', '/api/tracked-accounts/capacity', U)).body;
  r = await http('PUT', '/api/risk/settings', T, { minIntervalSec: 120, maxPerHour: 20, busyRetrySec: 90, accountCheckHours: null });
  const cap1 = (await http('GET', '/api/tracked-accounts/capacity', U)).body;
  check('PUT → returned at once (capacity 20/h, check off)', r.status === 200 && r.body.device.minIntervalSec === 120 && r.body.device.accountCheckHours === null && r.body.capacityPerHour === 20, r.text);
  check('capacity endpoint follows the new pace immediately (min(20, 3600/120)=20)',
    cap0.pace.capacityPerHour === Math.min(env.max, Math.floor(3600 / env.min)) && cap1.pace.minIntervalSec === 120 && cap1.pace.maxPerHour === 20 && cap1.pace.capacityPerHour === 20
    && cap1.phones.every((p: any) => p.capacityPerHour === 20), JSON.stringify([cap0.pace, cap1.pace]));
  await http('PUT', '/api/risk/settings', T, { minIntervalSec: 600 });
  const cap2 = (await http('GET', '/api/tracked-accounts/capacity', U)).body;
  check('second change: 3600/600 = 6 per hour', cap2.pace.capacityPerHour === 6 && cap2.pace.maxPerHour === 20, JSON.stringify(cap2.pace));
  r = await http('PUT', '/api/risk/settings', T, { accountCheckHours: 12 });
  check('account check interval 12 h stored, pace kept', r.body.device.accountCheckHours === 12 && r.body.device.minIntervalSec === 600, r.text);
  // 自动发现账号 switch in 采集与检测节奏 (RiskPaceSettings.vue sends the whole form, accountDiscovery included)
  {
    const g = (await http('GET', '/api/risk/settings', T)).body;
    const form = { ...g.device, accountDiscovery: false };
    const off = await http('PUT', '/api/risk/settings', T, form);
    const back = (await http('GET', '/api/risk/settings', T)).body;
    const bad = await http('PUT', '/api/risk/settings', T, { ...form, accountDiscovery: 'no' });
    const on = await http('PUT', '/api/risk/settings', T, { ...form, accountDiscovery: true });
    check('自动发现 switch: default on, the page\'s full PUT turns it off (rest kept), non-boolean → 400, on again',
      g.device.accountDiscovery === true && g.defaults.accountDiscovery === true && off.status === 200 && back.device.accountDiscovery === false
      && back.device.accountCheckHours === 12 && back.device.minIntervalSec === 600 && bad.status === 400 && on.status === 200 && on.body.device.accountDiscovery === true,
      JSON.stringify([g.device.accountDiscovery, off.status, back.device.accountDiscovery, bad.status, on.body?.device?.accountDiscovery]));
  }

  // ---------------------------------------------------------------- placeholder devices, account limits from the new entry
  const devs = await db.insert(schema.instances).values([1, 2].map((n) => ({
    name: `riskchk-${tag}-${n}`, image: 'none', adbPort: 5580 + n, status: 'stopped' as const, spec: { width: 720, height: 1280, dpi: 320 },
  }))).returning();
  devIds.push(...devs.map((d) => d.id));
  const [D1, D2] = devs as [typeof devs[0], typeof devs[0]];
  r = await http('PUT', '/api/social/settings', U, { limits: { instagram: 2 } });
  check('账号上限: non-admin PUT /api/social/settings → 403', r.status === 403);
  r = await http('PUT', '/api/social/settings', T, { limits: { instagram: 1 } });
  check('账号上限: admin sets instagram = 1', r.status === 200 && r.body.limits.instagram === 1, r.text);
  // device link: read only in the API since 2026-11-18; linked here with the sync's rules (lib/social-link.ts tryLink)
  const acc1c = await http('POST', '/api/social/accounts', T, { platform: 'instagram', handle: `rk_${tag}_a`, ownerId: userId });
  const acc2 = await http('POST', '/api/social/accounts', T, { platform: 'instagram', handle: `rk_${tag}_b`, ownerId: userId });
  const l1 = await tryLink(acc1c.body.account.id, D2.id);
  const l2 = await tryLink(acc2.body.account.id, D2.id);
  check('账号上限 enforced: second IG account on the device → social.device_limit', acc1c.status === 201 && l1 === null && l2 === 'social.device_limit', `${l1} ${l2}`);
  await http('PUT', '/api/social/settings', T, { limits: { instagram: 2 } });
  const l2b = await tryLink(acc2.body.account.id, D2.id);
  check('账号上限 raised to 2 → the second account links', l2b === null, String(l2b));
  const acc1 = await http('GET', `/api/social/accounts/${acc1c.body.account.id}`, T);
  const accId = acc1.body.account.id as string;
  check('social account: automatic check supported (IG + device), no manual status fields accepted',
    acc1.body.account.autoCheckUnsupported === null && acc1.body.account.loginStatus === 'unknown', JSON.stringify(acc1.body.account).slice(0, 200));
  r = await http('POST', `/api/social/accounts/${accId}/checked`, T, { loginStatus: 'logged_in' });
  check('标记已检查 removed: POST …/checked → 404', r.status === 404, String(r.status));
  r = await http('PUT', `/api/social/accounts/${accId}`, T, { loginStatus: 'logged_out', accountStatus: 'suspended', lastError: 'x', notes: 'n1' });
  check('PUT ignores loginStatus / accountStatus / lastError (system-written)', r.status === 200 && r.body.account.loginStatus === 'unknown' && r.body.account.accountStatus === 'active' && r.body.account.lastError === null && r.body.account.notes === 'n1', r.text);

  // ---------------------------------------------------------------- device state on 云机管理 (halt, busy), resume
  await haltDevice(D1, { code: 'account_check.challenge', source: 'account_check', platform: 'instagram', socialAccountId: accId });
  // busy = an automatic operation holds the device lock (value token|what|startedAt as withDevice writes it), only in the
  // test API's own Redis (REDIS_URL of this run), removed right after
  const redis = new Redis(process.env.REDIS_URL!);
  const lockKey = (id: string) => `tracked:collector:lock:${id}`;
  const since = Date.now() - 5_000;
  await redis.set(lockKey(D2.id), `abc|reply|${since}`, 'PX', 60_000);
  r = await http('GET', '/api/instances/automation', T);
  const a1 = r.body.devices?.[D1.id];
  const a2 = r.body.devices?.[D2.id];
  check('automation (admin): D1 halted with code + source, not busy; D2 busy sending a comment since the lock time, not halted',
    r.status === 200 && a1?.halted?.code === 'account_check.challenge' && a1.halted.source === 'account_check' && a1.busy === null
    && a2?.busy?.what === 'reply' && a2.busy.since === new Date(since).toISOString() && a2.halted === null, JSON.stringify(r.body.devices));
  await redis.set(lockKey(D2.id), 'baretoken', 'PX', 60_000);
  r = await http('GET', '/api/instances/automation', T);
  check('automation: a lock of an older version (bare token) reads as busy "auto"', r.body.devices?.[D2.id]?.busy?.what === 'auto' && r.body.devices[D2.id].busy.since === null, JSON.stringify(r.body.devices?.[D2.id]));
  r = await http('GET', '/api/instances/automation', U);
  check('automation (user without grants): neither device listed', r.status === 200 && !r.body.devices[D1.id] && !r.body.devices[D2.id], r.text);
  await http('PUT', `/api/users/${userId}/grants`, T, { instanceIds: [D1.id] });
  r = await http('GET', '/api/instances/automation', U);
  check('automation (user granted D1): sees D1\'s halt, not D2', !!r.body.devices[D1.id]?.halted && !r.body.devices[D2.id], r.text);
  r = await http('POST', `/api/risk/devices/${D1.id}/resume`, U);
  check('恢复 by a user (even with the grant) → 403 (admins only)', r.status === 403, String(r.status));
  await redis.del(lockKey(D2.id));
  r = await http('GET', '/api/instances/automation', T);
  check('lock released → D2 no longer listed', !r.body.devices[D2.id], JSON.stringify(r.body.devices));
  await redis.quit();
  // a tracked account whose 采集手机 is D2 (seeded): the device list counts it
  await db.insert(schema.trackedAccounts).values({ userId: userId!, platform: 'instagram', handle: `rk_t_${tag}`, profileUrl: `https://www.instagram.com/rk_t_${tag}/`, instanceId: D2.id });
  r = await http('GET', '/api/risk/devices', T);
  const d1 = r.body.devices?.find((d: any) => d.id === D1.id);
  const d2 = r.body.devices?.find((d: any) => d.id === D2.id);
  check('云手机状态: halted device listed first with code, source, account, offline', r.status === 200 && r.body.devices[0]?.halted && !!d1?.halted
    && d1.halted.code === 'account_check.challenge' && d1.halted.source === 'account_check' && d1.halted.account?.handle === `rk_${tag}_a` && d1.online === false, JSON.stringify(d1));
  check('云手机状态: device of 2 IG accounts listed (checked accounts 2, 1 tracked account on it as 采集手机, not halted, visits 0)',
    !!d2 && d2.checkedAccounts === 2 && d2.trackedAccounts === 1 && !('collectorFor' in d2) && !d2.halted && d2.visitsLastHour === 0, JSON.stringify(d2));
  const alertKey = `${D1.id}:instagram`;
  const [st1] = await db.select().from(schema.alertStates).where(and(eq(schema.alertStates.kind, 'collector.blocked'), eq(schema.alertStates.key, alertKey)));
  check('halt raised collector.blocked (alert state active)', st1?.active === true, JSON.stringify(st1));
  r = await http('POST', `/api/social/accounts/${(acc2.body.account.id as string)}/check`, T);
  check('立即检测 refused on a device without the halt? (D2 not halted: queued 202)', r.status === 202 && !!r.body.task?.id, r.text);
  if (r.body?.task?.id) extraTaskIds.push(r.body.task.id);
  // An account on the halted device: refused with the coded reason.
  await db.update(schema.socialAccounts).set({ instanceId: D1.id }).where(eq(schema.socialAccounts.id, accId));
  r = await http('POST', `/api/social/accounts/${accId}/check`, U);
  check('立即检测 on a halted device → 409 account_check.device_halted', r.status === 409 && r.body.code === 'account_check.device_halted', r.text);
  r = await http('POST', `/api/risk/devices/${D1.id}/resume`, T);
  const [st2] = await db.select().from(schema.alertStates).where(and(eq(schema.alertStates.kind, 'collector.blocked'), eq(schema.alertStates.key, alertKey)));
  const after = (await http('GET', '/api/risk/devices', T)).body.devices.find((d: any) => d.id === D1.id);
  const afterCard = (await http('GET', '/api/instances/automation', T)).body.devices[D1.id];
  check('恢复: resumed, halt gone (risk list + device card), alert recovered', r.status === 200 && r.body.resumed === true && !after?.halted && !afterCard && st2?.active === false, r.text);
  r = await http('POST', `/api/risk/devices/${D1.id}/resume`, T);
  check('恢复 again: resumed=false (no-op)', r.status === 200 && r.body.resumed === false);
  r = await http('POST', '/api/risk/devices/00000000-0000-4000-8000-000000000000/resume', T);
  check('恢复 of an unknown device → 404', r.status === 404);

  // ---------------------------------------------------------------- external phone power: admin only (inert placeholder)
  {
    const [src] = await db.insert(schema.deviceSources).values({ type: 'bitbrowser', name: `riskchk-src-${tag}`, config: { apiUrl: 'not a url' } }).returning();
    const [E] = await db.insert(schema.instances).values({
      name: `riskchk-${tag}-ext`, engine: 'bitbrowser', sourceId: src!.id, externalId: `riskchk-${tag}`, profile: 'bitbrowser', image: '',
      adbPort: 5583, status: 'stopped', spec: { width: 1080, height: 2374, dpi: 480 },
    }).returning();
    devIds.push(E!.id);
    await http('PUT', `/api/users/${userId}/grants`, T, { instanceIds: [D1.id, E!.id] });
    const single = await Promise.all((['start', 'stop', 'restart'] as const).map((action) => http('POST', '/api/instances/actions', U, { action, ids: [E!.id] })));
    const eTasks = await db.select().from(schema.tasks).where(eq(schema.tasks.instanceId, E!.id));
    check('user (granted): start / stop / restart of an external phone → 403 instances.external_power_admin_only, no task',
      single.every((x) => x.status === 403 && x.body.code === 'instances.external_power_admin_only') && eTasks.length === 0, single.map((x) => `${x.status}:${x.body?.code}`).join(','));
    r = await http('POST', '/api/instances/actions', U, { action: 'stop', ids: [E!.id, D1.id] });
    const sk = (r.body.skipped ?? []) as { instanceId: string; reason: string; code?: string }[];
    check('user batch (external + own local): external skipped with the code, local passes RBAC (already stopped → skipped, nothing runs)',
      r.status === 202 && r.body.accepted.length === 0 && sk.find((x) => x.instanceId === E!.id)?.code === 'instances.external_power_admin_only'
      && sk.find((x) => x.instanceId === D1.id)?.reason === 'already stopped', r.text);
    r = await http('POST', '/api/instances/actions', T, { action: 'stop', ids: [E!.id] });
    check('admin is not refused for the external phone (stopped already → skipped, no power call)', r.status === 202 && r.body.skipped?.[0]?.reason === 'already stopped' && !r.body.skipped[0].code, r.text);
    const after = await db.select().from(schema.tasks).where(eq(schema.tasks.instanceId, E!.id));
    check('…still no task on the external placeholder', after.length === 0, String(after.length));
    await db.delete(schema.instances).where(eq(schema.instances.id, E!.id));
    await db.delete(schema.deviceSources).where(eq(schema.deviceSources.id, src!.id));
  }

  // ---------------------------------------------------------------- 风控记录
  await recordRiskEvent({ instance: D1, socialAccountId: accId, source: 'account_check', code: 'account_check.logged_out', detail: 'login screen', userId });
  await new Promise((res) => setTimeout(res, 20));
  await recordRiskEvent({ instance: D1, socialAccountId: accId, source: 'account_check', code: 'account_check.wrong_account', detail: '@someone_else' });
  await new Promise((res) => setTimeout(res, 20));
  await recordRiskEvent({ instance: D2, source: 'collector', code: 'tracked.collector_challenge', detail: 'x'.repeat(400) });
  r = await http('GET', `/api/risk/events?instanceId=${D1.id}`, T);
  check('风控记录 by device: 2 rows newest first, account handle + starter joined', r.status === 200 && r.body.total === 2 && r.body.events[0].code === 'account_check.wrong_account'
    && r.body.events[1].socialHandle === `rk_${tag}_a` && r.body.events[1].username === `rk${tag}` && r.body.events[1].instanceName === D1.name, r.text.slice(0, 300));
  r = await http('GET', `/api/risk/events?code=tracked.collector_challenge&instanceId=${D2.id}`, T);
  check('风控记录 by code: 1 row, detail cut to 300 chars, source collector', r.body.total === 1 && r.body.events[0].detail.length === 300 && r.body.events[0].source === 'collector', r.text.slice(0, 200));
  r = await http('GET', `/api/risk/events?instanceId=${D1.id}&limit=1&offset=1`, T);
  check('风控记录 paging: page 2 of 2', r.body.total === 2 && r.body.events.length === 1 && r.body.events[0].code === 'account_check.logged_out');
  check('风控记录 code facet lists the codes', ['account_check.logged_out', 'account_check.wrong_account', 'tracked.collector_challenge'].every((c) => r.body.codes.some((x: any) => x.code === c)));
  r = await http('GET', '/api/risk/events?source=nope', T);
  check('风控记录: unknown source → 400', r.status === 400);
  const [old] = await db.insert(schema.riskEvents).values({ instanceId: D1.id, instanceName: D1.name, source: 'collector', code: 'tracked.collector_timeout', at: new Date(Date.now() - 91 * 86_400_000) }).returning();
  r = await http('POST', '/api/system/maintenance', T);
  const left = await db.select({ id: schema.riskEvents.id }).from(schema.riskEvents).where(inArray(schema.riskEvents.instanceId, devIds));
  check('retention: the hourly maintenance purges rows older than 90 days, keeps recent ones', r.status === 200 && r.body.result?.riskEventsDeleted >= 1 && !left.some((x) => x.id === old!.id) && left.length === 3, r.text.slice(0, 200));

  // ---------------------------------------------------------------- automatic check schedule (hash offset per account, idempotent)
  await db.update(schema.instances).set({ status: 'running' }).where(eq(schema.instances.id, D2.id));
  await http('PUT', '/api/risk/settings', T, { accountCheckHours: null });
  const s0 = await scheduleAccountDeviceChecks(new Date(), 6 * 3600_000);
  check('schedule off (accountCheckHours null) → nothing created', s0.hours === null && s0.created === 0, JSON.stringify(s0));
  await http('PUT', '/api/risk/settings', T, { accountCheckHours: 6 });
  const s1 = await scheduleAccountDeviceChecks(new Date(), 6 * 3600_000);
  const sched = await db.select().from(schema.tasks).where(and(eq(schema.tasks.type, 'account-device-check'), inArray(schema.tasks.refId, [accId, acc2.body.account.id]), like(schema.tasks.idempotencyKey, 'acct-check:%')));
  extraTaskIds.push(...sched.map((x) => x.id));
  const s2 = await scheduleAccountDeviceChecks(new Date(), 6 * 3600_000);
  check('schedule 6 h: one check per account on a running, not halted device (account on the stopped device skipped), key acct-check:<id>:<slot>',
    s1.hours === 6 && sched.length === 1 && sched[0]!.refId === acc2.body.account.id && /^acct-check:[0-9a-f-]{36}:\d+$/.test(sched[0]!.idempotencyKey ?? '') && (sched[0]!.payload as any)?.scheduled === true && s1.skipped >= 1,
    JSON.stringify({ s1, keys: sched.map((x) => x.idempotencyKey) }));
  check('schedule run twice in the same window → nothing new (idempotent)', s2.created === 0, JSON.stringify(s2));

  // ---------------------------------------------------------------- comment rules + no approval
  r = await http('GET', '/api/comments/settings', U);
  check('comment rules: no requireApproval any more', r.status === 200 && !('requireApproval' in r.body.rules) && r.body.rules.sendsPerHour >= 1, r.text);
  r = await http('PUT', '/api/comments/settings', T, { requireApproval: true });
  check('comment rules: requireApproval refused (400)', r.status === 400);
  r = await http('PUT', '/api/comments/settings', U, { duplicateMax: 5 });
  check('comment rules: non-admin PUT → 403', r.status === 403);
  r = await http('PUT', '/api/comments/settings', T, { duplicateMax: 5, duplicateWindowHours: 12, sendsPerHour: 30 });
  check('comment rules: admin saves (风控 page)', r.status === 200 && r.body.rules.duplicateMax === 5 && r.body.rules.sendsPerHour === 30, r.text);
  const mkComment = async (author: string) => (await http('POST', '/api/comments', U, { accountId: accId, authorName: author, text: `hello ${author} ${tag}` })).body.comment.id as string;
  const c1 = await mkComment('v1');
  r = await http('POST', `/api/comments/${c1}/replies`, U, { text: `Thanks v1 ${tag}`, submit: true });
  check('user reply → a draft without a task (draft first; submit: true of an older page ignored)', r.status === 201 && r.body.reply.status === 'draft' && !r.body.reply.taskId, r.text.slice(0, 300));
  r = await http('POST', `/api/comment-replies/${r.body.reply.id}/submit`, U, { scheduledAt: null });
  const rep1 = r.body.reply;
  check('排程 → scheduled at once (no pending_review), send task created', r.status === 200 && rep1.status === 'scheduled' && !!rep1.taskId && !('canReview' in rep1), r.text.slice(0, 300));
  const done1 = await waitFor('handed over', async () => { const [x] = await db.select().from(schema.commentTasks).where(eq(schema.commentTasks.id, rep1.id)); return x?.status === 'awaiting_operator' ? x : null; });
  check('…then handed to an operator (awaiting_operator, method manual)', done1.method === 'manual' && done1.reviewerId === null);
  const logs1 = (await db.select({ a: schema.commentLogs.action }).from(schema.commentLogs).where(eq(schema.commentLogs.commentTaskId, rep1.id))).map((x) => x.a);
  check('reply log: created → submitted → queued → run → handed_over, no approval', ['created', 'submitted', 'queued', 'run', 'handed_over'].every((a) => logs1.includes(a)) && !logs1.includes('approved'), logs1.join(','));
  const c2 = await mkComment('v2');
  const when = new Date(Date.now() + 3 * 86_400_000).toISOString();
  r = await http('POST', `/api/comments/${c2}/replies`, U, { text: `Thanks v2 ${tag}` });
  r = await http('POST', `/api/comment-replies/${r.body.reply.id}/submit`, U, { scheduledAt: when });
  const [t2] = r.body?.reply?.taskId ? await db.select().from(schema.tasks).where(eq(schema.tasks.id, r.body.reply.taskId)) : [];
  check('排程 with a send time → scheduled, its task scheduled for that time', r.status === 200 && r.body.reply.status === 'scheduled' && t2?.status === 'scheduled' && t2.runAt?.toISOString() === when, r.text.slice(0, 200));
  const rep2 = r.body.reply.id as string;
  const gone = await Promise.all([
    http('POST', `/api/comment-replies/${rep2}/approve`, T), http('POST', '/api/comment-replies/approve', T, { ids: [rep2] }), http('POST', `/api/comment-replies/${rep2}/reject`, T, { reason: 'x' }),
  ]);
  check('approve / batch approve / reject endpoints are gone (404)', gone.every((x) => x.status === 404), gone.map((x) => x.status).join(','));
  r = await http('POST', `/api/comment-replies/${rep2}/cancel`, U);
  check('scheduled reply can still be cancelled', r.status === 200 && r.body.reply.status === 'cancelled', r.text.slice(0, 200));

  // ---------------------------------------------------------------- data migration of old approval states
  const [cRow] = await db.select().from(schema.comments).where(eq(schema.comments.id, c1));
  const seedReply = async (status: 'pending_review' | 'approved', extra: Partial<typeof schema.commentTasks.$inferInsert> = {}) => {
    const cid = await mkComment(`m-${status}-${randomBytes(2).toString('hex')}`);
    const [row] = await db.insert(schema.commentTasks).values({
      userId: cRow!.userId, accountId: accId, commentId: cid, platform: 'instagram', text: `old ${status} ${tag}`, textHash: randomBytes(16).toString('hex'),
      status, authorId: userId, authorName: `rk${tag}`, submittedAt: new Date(), ...extra,
    }).returning();
    return row!;
  };
  const pr = await seedReply('pending_review', { scheduledAt: new Date(Date.now() + 86_400_000) });
  const [finalTask] = await db.insert(schema.tasks).values({ type: 'comment-reply', status: 'failed', refType: 'comment_reply', payload: {}, idempotencyKey: `rk-${tag}-final`, finishedAt: new Date() }).returning();
  const apOld = await seedReply('approved', { taskId: finalTask!.id, round: 1 });
  const [liveTask] = await db.insert(schema.tasks).values({ type: 'comment-reply', status: 'scheduled', refType: 'comment_reply', payload: {}, runAt: new Date(Date.now() + 7 * 86_400_000), idempotencyKey: `rk-${tag}-live` }).returning();
  const apLive = await seedReply('approved', { taskId: liveTask!.id });
  extraTaskIds.push(finalTask!.id, liveTask!.id);
  const ids = [pr.id, apOld.id, apLive.id];
  const m1 = await migrateCommentApproval(sqlClient, () => undefined, { ids });
  const rows = await db.select().from(schema.commentTasks).where(inArray(schema.commentTasks.id, ids));
  const by = (id: string) => rows.find((x) => x.id === id)!;
  const newTasks = await db.select().from(schema.tasks).where(and(eq(schema.tasks.type, 'comment-reply'), inArray(schema.tasks.refId, [pr.id, apOld.id])));
  extraTaskIds.push(...newTasks.map((x) => x.id));
  const prTask = newTasks.find((x) => x.refId === pr.id);
  const apTask = newTasks.find((x) => x.refId === apOld.id);
  check('migration: 2 queued, 1 kept', m1.scheduled === 2 && m1.kept === 1, JSON.stringify(m1));
  check('migration: pending_review → scheduled with a scheduled task at its send time (key …:1)',
    by(pr.id).status === 'scheduled' && by(pr.id).taskId === prTask?.id && prTask?.status === 'scheduled' && prTask.idempotencyKey === `comment-reply:${pr.id}:1`
    && prTask.runAt?.getTime() === pr.scheduledAt!.getTime() && (prTask.payload as any)?.commentTaskId === pr.id, JSON.stringify(prTask));
  check('migration: approved with a finished task → new round 2, new pending task', by(apOld.id).status === 'scheduled' && by(apOld.id).round === 2 && apTask?.idempotencyKey === `comment-reply:${apOld.id}:2` && apTask.status === 'pending' && by(apOld.id).taskId === apTask.id);
  check('migration: approved with a live task → scheduled, same task', by(apLive.id).status === 'scheduled' && by(apLive.id).taskId === liveTask!.id);
  const mlogs = await db.select().from(schema.commentLogs).where(and(inArray(schema.commentLogs.commentTaskId, ids), eq(schema.commentLogs.action, 'approval_removed')));
  check('migration: one comment log "approval removed" per row', mlogs.length === 3 && mlogs.every((l) => l.message === 'approval removed'));
  const m2 = await migrateCommentApproval(sqlClient, () => undefined, { ids });
  const mlogs2 = await db.select().from(schema.commentLogs).where(and(inArray(schema.commentLogs.commentTaskId, ids), eq(schema.commentLogs.action, 'approval_removed')));
  const newTasks2 = await db.select().from(schema.tasks).where(and(eq(schema.tasks.type, 'comment-reply'), inArray(schema.tasks.refId, [pr.id, apOld.id])));
  check('migration run twice: no-op (0/0, no new logs or tasks)', m2.scheduled === 0 && m2.kept === 0 && mlogs2.length === 3 && newTasks2.length === newTasks.length, JSON.stringify(m2));

  // ---------------------------------------------------------------- audit
  await new Promise((res) => setTimeout(res, 500));
  const audits = await db.select().from(schema.auditLogs).where(and(like(schema.auditLogs.action, 'risk.%')));
  const recent = audits.filter((a) => a.at >= t0);
  check('audit: risk.settings (with values) and risk.device_resume recorded',
    recent.some((a) => a.action === 'risk.settings' && (a.detail as any)?.minIntervalSec === 120) && recent.some((a) => a.action === 'risk.device_resume' && a.status === 200)
    && recent.some((a) => a.action === 'risk.settings' && a.status === 403), recent.map((a) => `${a.action}:${a.status}`).join(','));
  const ac = (await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.action, 'social.account_check'))).filter((a) => a.at >= t0);
  check('audit: social.account_check (立即检测) recorded incl. the refused one', ac.some((a) => a.status === 202) && ac.some((a) => a.status === 409), ac.map((a) => a.status).join(','));
} catch (err) {
  check(`unexpected error: ${(err as Error).message}`, false);
} finally {
  // cancel queued tasks of this run (the immediate check on D2 may still be queued / running)
  if (extraTaskIds.length) await db.update(schema.tasks).set({ status: 'cancelled', finishedAt: new Date() }).where(and(inArray(schema.tasks.id, extraTaskIds), inArray(schema.tasks.status, ['pending', 'scheduled'])));
  await db.delete(schema.tasks).where(inArray(schema.tasks.id, extraTaskIds.length ? extraTaskIds : ['00000000-0000-0000-0000-000000000000']));
  if (userId) await http('DELETE', `/api/users/${userId}`, T);
  if (devIds.length) {
    await db.delete(schema.riskEvents).where(inArray(schema.riskEvents.instanceId, devIds));
    await db.delete(schema.alertStates).where(inArray(schema.alertStates.key, devIds.map((id) => `${id}:instagram`)));
    await db.delete(schema.instances).where(inArray(schema.instances.id, devIds));
  }
  await db.delete(schema.settings).where(inArray(schema.settings.key, settingKeys));
  if (savedSettings.length) await db.insert(schema.settings).values(savedSettings);
  const failed = results.filter(([, ok]) => !ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  await sqlClient.end();
  process.exit(failed ? 1 : 0);
}
