/**
 * 我的媒体号 → 粉丝 / 追踪中 without a phone (owner request 2026-11-18): real API, DB, Redis and task centre, no mocks.
 * Device rows are placeholders (adb ports 5576–5578 that nothing listens on), so a run meets an offline phone; the
 * screens themselves are covered by following-device-check.ts on bit-ins-02. Stats rows are seeded as the automatic
 * check writes them.
 *
 * - 粉丝: GET …/followers (current ≈ approx, change today / 7 d / 30 d against the last reading at or before the cut,
 *   30 daily points with gaps as null, no readings → null), RBAC (others 404);
 * - 追踪中: 同步 codes (no device 400, in progress 409, halted 409, others 404), task account-following on its own queue,
 *   offline phone → failed following.offline, nothing written; GET …/following (RBAC, total, search, gone filter);
 * - storage rules (writeFollowing): upsert, a capped / incomplete run never marks gone, a complete run marks the unseen
 *   ones gone (gone_at), an entry seen again is cleared (first_seen kept);
 * - parser on the trimmed probe dumps (scripts/fixtures/ig-following-*.xml): rows, tab count, end marker, swipe left
 *   of the row buttons; the profile's following counter;
 * - schedule: key following:<id>:<slot>, idempotent, halted / stopped phones skipped, off = nothing;
 * - 风控 setting followingSyncHours (default 24, 1–168 | null); role menu rule (social); migration 0044 shape + db:migrate
 *   twice; audit social.following_sync.
 *
 *   E2E_API=http://127.0.0.1:<port> API_PORT=<port> npx tsx --env-file=../../.env scripts/following-check.ts
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { and, eq, inArray, like, sql } from 'drizzle-orm';
import { db, schema, sqlClient } from '../src/db/index.js';
import { menuRuleFor } from '../src/modules/auth/role-menus.js';
import { followingCounter, listSwipe, parseFollowingScreen } from '../src/modules/social/following-ui.js';
import { scheduleFollowingSyncs, writeFollowing } from '../src/modules/social/following.js';
import { haltDevice } from '../src/modules/tracked/collector.js';
import { parseUiDump } from '../src/modules/tracked/instagram-device.js';
import { withCaptcha } from './lib/login.js';
import { linkAccount } from './lib/social-link.js';

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
  try { json = JSON.parse(text); } catch { /* empty */ }
  return { status: res.status, body: json as T, text: text.slice(0, 400) };
}
async function login(username: string, password: string): Promise<string> {
  const r = await fetch(`${API}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(await withCaptcha(API, { username, password })) });
  return (await r.json()).token;
}
async function waitFor<T>(label: string, fn: () => Promise<T | null | false | undefined>, ms = 60_000): Promise<T> {
  const t0 = Date.now();
  for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() - t0 > ms) throw new Error(`timeout: ${label}`); await new Promise((r) => setTimeout(r, 300)); }
}
const DAY = 86_400_000;
const day = (n: number) => new Date(Date.now() - n * DAY).toISOString().slice(0, 10);

const T = await login(process.env.ADMIN_USERNAME!, process.env.ADMIN_PASSWORD!);
const tag = randomBytes(3).toString('hex');
const pw = randomBytes(12).toString('base64url');
const settingKeys = ['risk.device', 'risk.halts', 'social.limits'];
const savedSettings = await db.select().from(schema.settings).where(inArray(schema.settings.key, settingKeys));
const t0 = new Date((await sqlClient`select now() as now`)[0]!.now as Date);
const userIds: string[] = [];
const devIds: string[] = [];

try {
  // ---------------------------------------------------------------- 风控 setting
  await db.delete(schema.settings).where(inArray(schema.settings.key, ['risk.device', 'risk.halts']));
  let r = await http('GET', '/api/risk/settings', T);
  check('风控 default: following list every 24 h', r.body.device.followingSyncHours === 24 && r.body.defaults.followingSyncHours === 24, r.text);
  const bad = await Promise.all([{ followingSyncHours: 0 }, { followingSyncHours: 169 }, { followingSyncHours: 2.5 }, { followingSyncHours: 'x' }].map((b) => http('PUT', '/api/risk/settings', T, b)));
  check('followingSyncHours validation → 400', bad.every((x) => x.status === 400), bad.map((x) => x.status).join(','));
  r = await http('PUT', '/api/risk/settings', T, { followingSyncHours: null });
  check('followingSyncHours null (off) stored, other fields kept', r.status === 200 && r.body.device.followingSyncHours === null && r.body.device.feedPosts === 3, r.text);

  // ---------------------------------------------------------------- users, placeholder phones, accounts
  for (const n of ['a', 'b']) {
    const u = await http('POST', '/api/users', T, { username: `fw${n}${tag}`, password: pw, role: 'user' });
    userIds.push(u.body.user?.id ?? u.body.id);
  }
  const [uA, uB] = userIds as [string, string];
  const A = await login(`fwa${tag}`, pw);
  const B = await login(`fwb${tag}`, pw);
  const devs = await db.insert(schema.instances).values([1, 2, 3].map((n) => ({
    name: `fwchk-${tag}-${n}`, image: 'none', adbPort: 5575 + n, status: (n === 3 ? 'stopped' : 'running') as 'running' | 'stopped', adbState: n === 3 ? null : 'device',
    bootCompleted: n !== 3, spec: { width: 720, height: 1280, dpi: 320 },
  }))).returning();
  devIds.push(...devs.map((d) => d.id));
  const [d1, d2, d3] = devs as [typeof devs[0], typeof devs[0], typeof devs[0]];
  for (const [u, d] of [[uA, d1], [uB, d2], [uA, d3]] as const) await db.insert(schema.instanceGrants).values({ userId: u, instanceId: d.id }).onConflictDoNothing();
  const mk = async (owner: string, handle: string, instanceId: string | null) => {
    const x = await http('POST', '/api/social/accounts', T, { platform: 'instagram', handle, ownerId: owner });
    if (x.status !== 201) throw new Error(`account: ${x.text}`);
    if (instanceId) await linkAccount(x.body.account.id, instanceId);
    return x.body.account as { id: string };
  };
  const accA = await mk(uA, `fw_a_${tag}`, d1.id);
  const accB = await mk(uB, `fw_b_${tag}`, d2.id);
  const accN = await mk(uA, `fw_n_${tag}`, null);
  const accS = await mk(uA, `fw_s_${tag}`, d3.id);

  // ---------------------------------------------------------------- 粉丝
  const S = schema.socialAccountStats;
  await db.insert(S).values([
    { day: day(35), followers: 1000 }, { day: day(10), followers: 1100 }, { day: day(6), followers: 1150, following: 7 }, { day: day(1), followers: 1180 },
    { day: day(0), followers: 1200, approx: ['followers'] },
  ].map((v) => ({ socialAccountId: accA.id, source: 'device' as const, capturedAt: new Date(`${v.day}T08:00:00Z`), ...v })));
  r = await http('GET', `/api/social/accounts/${accA.id}/followers`, A);
  const f = r.body;
  check('粉丝: current 1200 ≈ (approx), change today +20 / 7 d +100 / 30 d +200', r.status === 200 && f.current?.followers === 1200 && f.current.approx === true
    && f.change.today === 20 && f.change.d7 === 100 && f.change.d30 === 200, r.text);
  check('粉丝: 30 daily points, days without a reading are null (gaps, never 0)', f.series.length === 30 && f.series.filter((p: any) => p.followers !== null).length === 4
    && f.series[29].followers === 1200 && f.series[0].followers === null, JSON.stringify(f.series.filter((p: any) => p.followers !== null)));
  r = await http('GET', `/api/social/accounts/${accN.id}/followers?days=7`, A);
  check('粉丝 without readings: current null, changes null, 7 null points', r.status === 200 && r.body.current === null && r.body.change.d7 === null && r.body.series.length === 7 && r.body.series.every((p: any) => p.followers === null), r.text);
  const fr = await Promise.all([http('GET', `/api/social/accounts/${accA.id}/followers`, B), http('GET', `/api/social/accounts/${accA.id}/followers`, T)]);
  check('粉丝 RBAC: another user 404, admin 200', fr[0].status === 404 && fr[1].status === 200, fr.map((x) => x.status).join(','));

  // ---------------------------------------------------------------- 追踪中: codes + offline run
  r = await http('GET', `/api/social/accounts/${accA.id}/following`, A);
  check('追踪中 empty: total 0, never synced, unsupported null, schedule off shown, max 200', r.status === 200 && r.body.total === 0 && r.body.last === null
    && r.body.unsupported === null && r.body.settings.hours === null && r.body.settings.max === 200, r.text);
  const rb = await Promise.all([http('GET', `/api/social/accounts/${accA.id}/following`, B), http('POST', `/api/social/accounts/${accA.id}/following/sync`, B)]);
  check('追踪中 RBAC: another user GET / 同步 → 404', rb.every((x) => x.status === 404 && x.body.code === 'social.not_found'), rb.map((x) => x.status).join(','));
  r = await http('POST', `/api/social/accounts/${accN.id}/following/sync`, A);
  check('同步 without a phone → 400 following.no_device', r.status === 400 && r.body.code === 'following.no_device', r.text);
  r = await http('GET', `/api/social/accounts/${accN.id}/following`, A);
  check('…GET says unsupported following.no_device', r.body.unsupported === 'following.no_device', r.text);
  // hold the queue: the first sync gets a future runAt so the second sees it unfinished
  r = await http('POST', `/api/social/accounts/${accA.id}/following/sync`, A);
  const r2 = await http('POST', `/api/social/accounts/${accA.id}/following/sync`, A);
  check('同步 → 202 + task; a second one while it is unfinished → 409 following.in_progress (or the first already ended)', r.status === 202 && !!r.body.task?.id
    && (r2.status === 409 ? r2.body.code === 'following.in_progress' : r2.status === 202), `${r.text} ${r2.text}`);
  const task = await waitFor('sync task ends', async () => {
    const [t] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, r.body.task.id));
    return t && ['failed', 'success'].includes(t.status) ? t : null;
  });
  check('task account-following (refType social_account) on an offline phone → failed following.offline, nothing written',
    task.type === 'account-following' && task.refType === 'social_account' && task.status === 'failed' && task.errorCode === 'following.offline'
    && (await db.select().from(schema.socialAccountFollowing).where(eq(schema.socialAccountFollowing.socialAccountId, accA.id))).length === 0,
    `${task.type} ${task.status} ${task.errorCode}`);
  if (r2.status === 202) await waitFor('second task ends', async () => { const [t] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, r2.body.task.id)); return t && ['failed', 'success'].includes(t.status) ? t : null; });
  r = await http('GET', `/api/social/accounts/${accA.id}/following`, A);
  check('…GET shows the last run failed with its code', r.body.last?.status === 'failed' && r.body.last.errorCode === 'following.offline' && r.body.pending === null, r.text);
  await haltDevice(d2, { code: 'following.challenge', source: 'following', platform: 'instagram', socialAccountId: accB.id });
  r = await http('POST', `/api/social/accounts/${accB.id}/following/sync`, B);
  check('同步 on a halted phone → 409 following.device_halted; GET halted true', r.status === 409 && r.body.code === 'following.device_halted'
    && (await http('GET', `/api/social/accounts/${accB.id}/following`, B)).body.halted === true, r.text);
  r = await http('GET', '/api/instances/automation', T);
  check('风控暂停 source following shown on the device', r.body.devices?.[d2.id]?.halted?.source === 'following', JSON.stringify(r.body.devices?.[d2.id]));

  // ---------------------------------------------------------------- schedule
  await http('PUT', '/api/risk/settings', T, { followingSyncHours: 24 });
  const s1 = await scheduleFollowingSyncs(new Date(), 25 * 3600_000);
  const s2 = await scheduleFollowingSyncs(new Date(), 25 * 3600_000);
  const sched = await db.select().from(schema.tasks).where(and(eq(schema.tasks.type, 'account-following'), inArray(schema.tasks.refId, [accA.id, accB.id, accS.id, accN.id]), like(schema.tasks.idempotencyKey, 'following:%')));
  check('schedule: only the running, not halted phone\'s account gets slots (key following:<id>:<slot>), a second tick adds nothing',
    s1.created >= 1 && s2.created === 0 && sched.length >= 1 && sched.every((t) => t.refId === accA.id && /^following:[0-9a-f-]+:\d+$/.test(t.idempotencyKey ?? '') && (t.payload as any).scheduled === true),
    `${JSON.stringify(s1)} ${JSON.stringify(s2)} ${sched.map((t) => `${t.refId === accA.id ? 'A' : t.refId}:${t.idempotencyKey}`).join(',')}`);
  await db.update(schema.tasks).set({ status: 'cancelled', finishedAt: new Date() }).where(inArray(schema.tasks.id, sched.map((t) => t.id)));
  await http('PUT', '/api/risk/settings', T, { followingSyncHours: null });
  const s3 = await scheduleFollowingSyncs(new Date(), 25 * 3600_000);
  check('schedule off → nothing', s3.hours === null && s3.created === 0);
  await http('POST', `/api/risk/devices/${d2.id}/resume`, T);

  // ---------------------------------------------------------------- parser (trimmed probe dumps of bit-ins-02)
  const fx = (n: string) => parseUiDump(readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8'));
  const top = parseFollowingScreen(fx('ig-following-list.xml'));
  const end = parseFollowingScreen(fx('ig-following-end.xml'));
  check('parser: following tab selected, tab count 6, 6 rows (lowercase handle + display name), end marker (suggestions) seen',
    top.onFollowingTab && top.tabCount === 6 && top.rows.length === 6 && top.rows[0]!.handle === 'gigi.cassyy15' && top.rows[1]!.displayName === 'Abel' && top.end,
    JSON.stringify(top.rows.map((x) => x.handle)));
  check('parser: scrolled screen = last 3 rows + end; suggestion rows are not entries', end.rows.map((x) => x.handle).join(',') === 'baekhyunee_exo,thv,elephantdee' && end.end
    && !end.rows.some((x) => /^suggested/.test(x.handle)));
  const sw = listSwipe(top);
  check('swipe stays in the list, left of the row buttons, moves up', !!sw && sw.x < (top.buttonsLeft ?? 0) - 40 && sw.y1 > sw.y2 && sw.y2 > top.list![1] && sw.y1 < top.list![3], JSON.stringify(sw));
  const prof = parseUiDump(`<hierarchy><node resource-id="com.instagram.android:id/profile_header_following_stacked_familiar" content-desc="6关注" clickable="true" package="com.instagram.android" bounds="[814,363][1032,534]"><node resource-id="com.instagram.android:id/profile_header_familiar_following_value" text="6" bounds="[900,380][950,420]"/></node></hierarchy>`);
  check('profile: following counter tap target = the counter\'s centre', JSON.stringify(followingCounter(prof)) === JSON.stringify({ x: 923, y: 449 }), JSON.stringify(followingCounter(prof)));
  check('parser on an unrelated screen: no rows, not the following tab, no end', (() => { const x = parseFollowingScreen(prof); return !x.onFollowingTab && !x.rows.length && !x.end; })());

  // ---------------------------------------------------------------- storage rules
  const FW = schema.socialAccountFollowing;
  const rows = async () => Object.fromEntries((await db.select().from(FW).where(eq(FW.socialAccountId, accA.id))).map((x) => [x.handle, x]));
  const e = (h: string) => ({ handle: h, displayName: `N ${h}` });
  let w = await writeFollowing(accA.id, { entries: [e('Alpha'), e('beta'), e('gamma')], complete: true }, new Date(Date.now() - 5000));
  const firstAlpha = (await rows()).alpha?.firstSeenAt;
  check('complete run: 3 added (handles lowercased, positions 0..2), none gone', w.added === 3 && w.gone === 0 && (await rows()).alpha?.position === 0 && (await rows()).gamma?.position === 2, JSON.stringify(w));
  w = await writeFollowing(accA.id, { entries: [e('alpha'), e('beta')], complete: false }, new Date(Date.now() - 4000));
  check('capped / incomplete run: gamma not seen but NOT marked gone', w.gone === 0 && (await rows()).gamma?.goneAt === null, JSON.stringify(w));
  w = await writeFollowing(accA.id, { entries: [e('alpha'), e('beta'), e('delta')], complete: true }, new Date(Date.now() - 3000));
  check('complete run: delta added, gamma marked gone (gone_at)', w.added === 1 && w.gone === 1 && (await rows()).gamma?.goneAt !== null, JSON.stringify(w));
  w = await writeFollowing(accA.id, { entries: [e('alpha'), { handle: 'beta', displayName: null }, e('gamma'), e('delta')], complete: true }, new Date(Date.now() - 2000));
  const now4 = await rows();
  check('followed again: gamma returned (gone cleared), first_seen kept, display name kept when not readable', w.returned === 1 && w.gone === 0 && now4.gamma?.goneAt === null
    && now4.alpha?.firstSeenAt.getTime() === firstAlpha?.getTime() && now4.beta?.displayName === 'N beta', JSON.stringify(w));
  await writeFollowing(accA.id, { entries: [e('alpha')], complete: true }, new Date(Date.now() - 1000));
  r = await http('GET', `/api/social/accounts/${accA.id}/following`, A);
  check('GET: current 1 (alpha), gone 3, total = current only', r.body.total === 1 && r.body.following === 1 && r.body.gone === 3 && r.body.items[0]?.handle === 'alpha', r.text);
  r = await http('GET', `/api/social/accounts/${accA.id}/following?gone=true&limit=2`, A);
  check('GET gone=true: 4 in total, current first, paged', r.body.total === 4 && r.body.items.length === 2 && r.body.items[0].handle === 'alpha' && r.body.items[1].goneAt !== null, r.text);
  r = await http('GET', `/api/social/accounts/${accA.id}/following?gone=true&q=ELT`, A);
  check('GET search (case-insensitive, handle or name)', r.body.total === 1 && r.body.items[0].handle === 'delta', r.text);
  r = await http('GET', `/api/social/accounts/${accA.id}/following`, T);
  check('admin sees it too', r.status === 200 && r.body.following === 1);

  // ---------------------------------------------------------------- role menu rule
  const rule = menuRuleFor('GET', `/api/social/accounts/${accA.id}/following`);
  const rule2 = menuRuleFor('GET', `/api/social/accounts/${accA.id}/followers`);
  check('权限管理: …/following and …/followers belong to the social menu', JSON.stringify(rule?.menus) === '["social"]' && JSON.stringify(rule2?.menus) === '["social"]', JSON.stringify([rule, rule2]));

  // ---------------------------------------------------------------- migration 0044 shape, run twice
  const cols = await sqlClient`select column_name, is_nullable from information_schema.columns where table_name = 'social_account_following' order by ordinal_position`;
  const [fk] = await sqlClient`select confdeltype from pg_constraint where conname = 'social_account_following_social_account_id_social_accounts_id_fk'`;
  const [uq] = await sqlClient`select 1 as ok from pg_constraint where conname = 'social_account_following_account_handle' and contype = 'u'`;
  check('migration 0044: table with gone_at nullable, FK cascade, unique (account, handle)', cols.map((c) => c.column_name).join(',') === 'id,social_account_id,handle,display_name,verified,position,first_seen_at,last_seen_at,gone_at'
    && cols.find((c) => c.column_name === 'gone_at')?.is_nullable === 'YES' && fk?.confdeltype === 'c' && !!uq, `${cols.map((c) => c.column_name)} ${fk?.confdeltype}`);
  const mig = () => execFileSync('npx', ['tsx', '--env-file=../../.env', 'src/db/migrate.ts'], { env: process.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const out1 = mig();
  const out2 = mig();
  const [cnt] = await sqlClient`select count(*)::int as n from drizzle.__drizzle_migrations`;
  check('db:migrate twice: both succeed', /migrations applied/.test(out1) && /migrations applied/.test(out2) && Number(cnt?.n) >= 45, `${cnt?.n}`);
  await http('DELETE', `/api/social/accounts/${accA.id}`, T);
  check('account deleted → its following rows go with it (cascade)', (await db.select().from(FW).where(eq(FW.socialAccountId, accA.id))).length === 0);

  // ---------------------------------------------------------------- audit
  await new Promise((res) => setTimeout(res, 500));
  const audits = (await db.select().from(schema.auditLogs).where(and(sql`${schema.auditLogs.at} >= ${t0.toISOString()}::timestamptz`, eq(schema.auditLogs.action, 'social.following_sync'))));
  check('audit social.following_sync: 202 (with task id) + 409 + 400 + 404', audits.some((a) => a.status === 202 && !!(a.detail as any)?.taskId) && audits.some((a) => a.status === 409)
    && audits.some((a) => a.status === 400) && audits.some((a) => a.status === 404), audits.map((a) => a.status).join(','));
} catch (err) {
  check(`unexpected error: ${(err as Error).stack}`, false);
} finally {
  await db.update(schema.tasks).set({ status: 'cancelled', finishedAt: new Date() }).where(and(inArray(schema.tasks.status, ['pending', 'scheduled']), sql`${schema.tasks.createdAt} >= ${t0.toISOString()}::timestamptz`));
  for (const id of userIds) await http('DELETE', `/api/users/${id}`, T);
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
