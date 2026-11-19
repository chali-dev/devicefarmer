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
 * - 粉丝 list (owner 2026-11-19, ≤ 20 newest per run, read in the same task): parser on a CONSTRUCTED followers-tab dump
 *   (derived from the real following fixture: tab selection / count swapped, a 移除 button added to the rows; no real
 *   followers-tab dump exists, the screen was never probed), tab tap target, storage by kind (capped never marks gone,
 *   complete marks gone only in its own list), GET …/followers/list (paging, search, state, RBAC), …/following state;
 * - the listed accounts' profiles (owner 2026-11-19): pickProfileVisits (missing / older than 7 d, followers first, then
 *   following by position, one per handle, cap 30), profileOutcome on the real own-profile dump (+ a CONSTRUCTED private
 *   text: no private profile was ever dumped live), shell / challenge / login / unknown screens, writeProfile (both rows
 *   of a handle, failed visit keeps counts, not_found), list API fields;
 * - 风控 setting followingSyncHours (default 24, 1–168 | null); role menu rule (social); migrations 0044 + 0046 + 0047 shape +
 *   db:migrate twice; audit social.following_sync.
 *
 *   E2E_API=http://127.0.0.1:<port> API_PORT=<port> npx tsx --env-file=../../.env scripts/following-check.ts
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { and, eq, inArray, like, sql } from 'drizzle-orm';
import { db, schema, sqlClient } from '../src/db/index.js';
import { menuRuleFor } from '../src/modules/auth/role-menus.js';
import { followingCounter, listSwipe, listTab, parseFollowingScreen } from '../src/modules/social/following-ui.js';
import { FOLLOWERS_MAX, pickProfileVisits, PROFILE_STALE_MS, PROFILE_VISITS_PER_RUN, profileOutcome, scheduleFollowingSyncs, writeFollowing, writeProfile } from '../src/modules/social/following.js';
import { haltDevice } from '../src/modules/tracked/collector.js';
import { classifyIgDump, parseUiDump } from '../src/modules/tracked/instagram-device.js';
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
  // CONSTRUCTED followers-tab dump (no real one exists): the real following fixture with the tab selection / count swapped
  // (粉丝 (25) selected) and a 移除 button (clickable, x 640) added to each row; the rows keep the following ids (assumed).
  const rawList = readFileSync(new URL('./fixtures/ig-following-list.xml', import.meta.url), 'utf8');
  const constructed = rawList
    .replace(/text="粉丝 \(0\)"([^>]*?)selected="false"/, 'text="粉丝 (25)"$1selected="true"')
    .replace(/text="关注 \(6\)"([^>]*?)selected="true"/, 'text="关注 (6)"$1selected="false"')
    .replace(/(<node text="[^"]*" resource-id="com\.instagram\.android:id\/follow_list_row_large_follow_button"[^>]*bounds="\[612,(\d+)\]\[948,(\d+)\]"\/>)/g,
      '<node text="移除" resource-id="com.instagram.android:id/follow_list_row_remove_button" class="android.widget.Button" package="com.instagram.android" content-desc="" clickable="true" selected="false" bounds="[560,$2][700,$3]"/>$1');
  const fan = parseFollowingScreen(parseUiDump(constructed), 'followers');
  check('followers parser (constructed dump): 粉丝 tab selected, tab count 25, 6 rows; as following it is NOT the selected tab',
    fan.onFollowingTab && fan.tabCount === 25 && fan.rows.length === 6 && fan.rows[0]!.handle === 'gigi.cassyy15' && !parseFollowingScreen(parseUiDump(constructed), 'following').onFollowingTab,
    JSON.stringify({ on: fan.onFollowingTab, n: fan.tabCount, rows: fan.rows.length }));
  const fsw = listSwipe(fan);
  check('followers: row buttons (移除 at x 560) found, swipe stays left of them', fan.buttonsLeft === 560 && !!fsw && fsw.x < 500, JSON.stringify({ b: fan.buttonsLeft, fsw }));
  check('following fixture seen as followers: not the selected tab; 粉丝 tab tap target = its title centre (not selected)',
    !parseFollowingScreen(fx('ig-following-list.xml'), 'followers').onFollowingTab
    && JSON.stringify(listTab(fx('ig-following-list.xml'), 'followers')) === JSON.stringify({ x: 135, y: 312, selected: false })
    && listTab(fx('ig-following-list.xml'), 'following')?.selected === true, JSON.stringify(listTab(fx('ig-following-list.xml'), 'followers')));
  const profF = parseUiDump(`<hierarchy><node resource-id="com.instagram.android:id/profile_header_followers_stacked_familiar" content-desc="3粉丝" clickable="true" package="com.instagram.android" bounds="[500,363][700,534]"/></hierarchy>`);
  check('profile: followers counter tap target (fallback without a tab bar)', JSON.stringify(followingCounter(profF, 'followers')) === JSON.stringify({ x: 600, y: 449 }) && followingCounter(profF) === null);
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
  r = await http('GET', `/api/social/accounts/${accA.id}/following?state=gone`, A);
  check('GET state=gone: only the 3 gone, current count still 1', r.body.total === 3 && r.body.current === 1 && r.body.items.every((x: any) => x.goneAt !== null), r.text);
  r = await http('GET', `/api/social/accounts/${accA.id}/following?state=all`, A);
  const r400 = await http('GET', `/api/social/accounts/${accA.id}/following?state=x`, A);
  check('GET state=all = 4 (same as the older gone=true); bad state → 400', r.body.total === 4 && r400.status === 400, `${r.text} ${r400.status}`);

  // ---------------------------------------------------------------- 粉丝 list: storage by kind + API
  const fol = (h: string) => ({ handle: h, displayName: `F ${h}` });
  w = await writeFollowing(accA.id, { entries: [fol('fan1'), fol('fan2'), fol('Alpha')], complete: true }, new Date(Date.now() - 900), 'followers');
  const kinds = await db.select().from(FW).where(eq(FW.socialAccountId, accA.id));
  check('followers stored as kind followers (same handle may be in both lists), following rows untouched',
    w.added === 3 && w.gone === 0 && kinds.filter((x) => x.kind === 'followers').length === 3 && kinds.filter((x) => x.kind === 'following').length === 4
    && kinds.filter((x) => x.handle === 'alpha').length === 2 && kinds.find((x) => x.kind === 'following' && x.handle === 'alpha')?.goneAt === null, JSON.stringify(w));
  w = await writeFollowing(accA.id, { entries: [fol('fan3')], complete: false }, new Date(Date.now() - 800), 'followers');
  check('followers capped read (only the newest 20): nothing marked gone', w.added === 1 && w.gone === 0
    && (await db.select().from(FW).where(and(eq(FW.socialAccountId, accA.id), eq(FW.kind, 'followers'), sql`${FW.goneAt} is not null`))).length === 0, JSON.stringify(w));
  w = await writeFollowing(accA.id, { entries: [fol('fan3'), fol('fan1')], complete: true }, new Date(Date.now() - 700), 'followers');
  const fk2 = await db.select().from(FW).where(eq(FW.socialAccountId, accA.id));
  check('followers complete read: fan2 + alpha gone in the followers list only (following alpha still current)', w.gone === 2
    && fk2.find((x) => x.kind === 'followers' && x.handle === 'alpha')?.goneAt !== null && fk2.find((x) => x.kind === 'following' && x.handle === 'alpha')?.goneAt === null, JSON.stringify(w));
  r = await http('GET', `/api/social/accounts/${accA.id}/followers/list?limit=1`, A);
  check('GET …/followers/list: kind followers, current 2, gone 2, total 2, paged (1 item), max 20', r.status === 200 && r.body.kind === 'followers' && r.body.current === 2
    && r.body.gone === 2 && r.body.total === 2 && r.body.items.length === 1 && r.body.settings.max === FOLLOWERS_MAX && FOLLOWERS_MAX === 20 && r.body.following === undefined, r.text);
  r = await http('GET', `/api/social/accounts/${accA.id}/followers/list?state=all&q=FAN`, A);
  check('…followers/list state=all + search (case-insensitive): fan1, fan2, fan3; current first', r.body.total === 3 && r.body.items[r.body.items.length - 1].goneAt !== null
    && r.body.items.slice(0, 2).every((x: any) => x.goneAt === null), r.text);
  r = await http('GET', `/api/social/accounts/${accA.id}/followers/list?state=gone`, A);
  check('…followers/list state=gone: fan2 + alpha', r.body.total === 2 && r.body.items.map((x: any) => x.handle).sort().join(',') === 'alpha,fan2', r.text);
  r = await http('GET', `/api/social/accounts/${accA.id}/following`, A);
  check('…the following list is unchanged by the followers writes', r.body.total === 1 && r.body.current === 1 && r.body.gone === 3, r.text);
  const fr2 = await Promise.all([http('GET', `/api/social/accounts/${accA.id}/followers/list`, B), http('GET', `/api/social/accounts/${accA.id}/followers/list`, T)]);
  check('…followers/list RBAC: another user 404, admin 200', fr2[0].status === 404 && fr2[1].status === 200 && fr2[1].body.current === 2, fr2.map((x) => x.status).join(','));

  // ---------------------------------------------------------------- the listed accounts' profiles (粉丝数 / 关注数 / 不公开)
  const NOW = new Date();
  const ago = (d: number) => new Date(NOW.getTime() - d * DAY);
  const vr = (id: string, kind: 'following' | 'followers', handle: string, position: number | null, checked: Date | null, gone: Date | null = null) =>
    ({ id, kind, handle, position, goneAt: gone, profileCheckedAt: checked });
  const pick = pickProfileVisits([
    vr('a', 'following', 'aa', 2, ago(8)), vr('b', 'following', 'bb', 1, null), vr('c', 'following', 'cc', 0, ago(1)), vr('g', 'following', 'gg', 3, null, ago(1)),
    vr('f2', 'followers', 'f2', 1, null), vr('f1', 'followers', 'f1', 0, ago(30)), vr('fx', 'followers', 'fx', 2, ago(6.9)), vr('d', 'following', 'f1', 4, null),
  ], NOW);
  check('pick: missing / older than 7 d only (fresh and gone skipped), followers first by position, then following by position, one per handle',
    pick.map((x) => x.id).join(',') === 'f1,f2,b,a' && PROFILE_STALE_MS === 7 * DAY, pick.map((x) => x.id).join(','));
  const many = Array.from({ length: 50 }, (_, i) => vr(`r${i}`, i < 25 ? 'following' : 'followers', `h${i}`, i, null));
  const pm = pickProfileVisits(many, NOW);
  check('pick: capped at PROFILE_VISITS_PER_RUN = 30, all 25 followers rows before the following rows', PROFILE_VISITS_PER_RUN === 30 && pm.length === 30
    && pm.slice(0, 25).every((x) => x.kind === 'followers') && pm.slice(25).map((x) => x.id).join(',') === 'r0,r1,r2,r3,r4', pm.map((x) => x.id).join(','));
  // real dump of an own profile on bit-ins-02 (followers 0, following 6, posts 1): the same reader as the collector
  const ownNodes = fx('ig-own-profile-refreshed.xml');
  const real = profileOutcome(classifyIgDump(ownNodes, 'conchadoroperto650'), ownNodes);
  check('profile outcome on a real profile dump: counts 0 / 6 / 1, not private, no approx', real.kind === 'profile' && real.followers === 0 && real.following === 6
    && real.posts === 1 && real.private === false && real.approx.length === 0, JSON.stringify(real));
  // CONSTRUCTED: the same dump with a "此账户为私密账户" text added (no private profile was ever dumped live)
  const privXml = readFileSync(new URL('./fixtures/ig-own-profile-refreshed.xml', import.meta.url), 'utf8')
    .replace('</hierarchy>', '<node text="此账户为私密账户" resource-id="" package="com.instagram.android" content-desc="" bounds="[0,900][1080,960]"/></hierarchy>');
  const privNodes = parseUiDump(privXml);
  const priv = profileOutcome(classifyIgDump(privNodes, 'conchadoroperto650'), privNodes);
  check('profile outcome (constructed private text): private true, counts still read', priv.kind === 'profile' && priv.private === true && priv.followers === 0, JSON.stringify(priv));
  const mini = (inner: string) => parseUiDump(`<hierarchy><node text="" resource-id="" package="com.instagram.android" content-desc="" bounds="[0,0][1080,2000]">${inner}</node></hierarchy>`);
  const shell = mini('<node text="" resource-id="com.instagram.android:id/profile_action_bar" package="com.instagram.android" bounds="[0,0][1080,100]"/>');
  const chal = mini('<node text="Help us confirm it\'s you" resource-id="" package="com.instagram.android" bounds="[0,0][1080,100]"/>');
  const loginScr = mini('<node text="" resource-id="com.instagram.android:id/login_username" package="com.instagram.android" bounds="[0,0][1080,100]"/>');
  const other = mini('<node text="something" resource-id="" package="com.instagram.android" bounds="[0,0][1080,100]"/>');
  const oc = [shell, chal, loginScr, other].map((n) => profileOutcome(classifyIgDump(n, 'someone'), n));
  check('profile outcome: empty shell → not_found (continue), challenge / login → stop, unknown → timeout',
    JSON.stringify(oc.map((o) => `${o.kind}:${(o as any).code ?? ''}`)) === JSON.stringify(['code:not_found', 'stop:challenge', 'stop:logged_out', 'code:timeout']), JSON.stringify(oc.map((o) => `${o.kind}:${(o as any).code}`)));

  // storage: alpha is in both lists of accA (current in following, gone in followers), fan1 / fan3 current followers
  const t1 = new Date(Date.now() - 60_000);
  await writeProfile(accA.id, 'Alpha', { kind: 'profile', followers: 12500, following: 80, posts: null, approx: ['followers'], private: true, verified: true, displayName: 'Profile Alpha' }, t1);
  const al = (await db.select().from(FW).where(and(eq(FW.socialAccountId, accA.id), eq(FW.handle, 'alpha'))));
  check('writeProfile: both rows of the handle (following + followers) get counts, approx, private, verified, checked time; a known display name kept, posts null when not shown',
    al.length === 2 && al.every((x) => x.followers === 12500 && x.following === 80 && x.posts === null && x.isPrivate === true && x.verified === true
      && JSON.stringify(x.approx) === '["followers"]' && x.profileCheckedAt?.getTime() === t1.getTime() && x.profileCode === null)
    && al.find((x) => x.kind === 'following')?.displayName === 'N alpha' && al.find((x) => x.kind === 'followers')?.displayName === 'F Alpha', JSON.stringify(al));
  await writeProfile(accA.id, 'fan1', { kind: 'profile', followers: 3, following: 4, posts: 5, approx: [], private: false, verified: false, displayName: 'P fan1' }, t1);
  const t2 = new Date(Date.now() - 30_000);
  await writeProfile(accA.id, 'fan1', { kind: 'code', code: 'timeout' }, t2);
  await writeProfile(accA.id, 'fan3', { kind: 'code', code: 'not_found' }, t2);
  const [f1] = await db.select().from(FW).where(and(eq(FW.socialAccountId, accA.id), eq(FW.handle, 'fan1')));
  const [f3] = await db.select().from(FW).where(and(eq(FW.socialAccountId, accA.id), eq(FW.handle, 'fan3')));
  check('writeProfile: a failed visit (timeout) keeps the last counts and checked time, only sets the code (picked again next run); not_found sets the code + checked time, counts null',
    f1?.followers === 3 && f1.profileCheckedAt?.getTime() === t1.getTime() && f1.profileCode === 'timeout'
    && f3?.profileCode === 'not_found' && f3.profileCheckedAt?.getTime() === t2.getTime() && f3.followers === null && f3.isPrivate === null, JSON.stringify([f1, f3]));
  r = await http('GET', `/api/social/accounts/${accA.id}/following`, A);
  const ia = r.body.items?.find((x: any) => x.handle === 'alpha');
  check('GET …/following items: followers, following, posts, approx, private, profileCheckedAt, profileCode', !!ia && ia.followers === 12500 && ia.following === 80 && ia.posts === null
    && JSON.stringify(ia.approx) === '["followers"]' && ia.private === true && new Date(ia.profileCheckedAt).getTime() === t1.getTime() && ia.profileCode === null, r.text);
  r = await http('GET', `/api/social/accounts/${accA.id}/followers/list`, A);
  const i3 = r.body.items?.find((x: any) => x.handle === 'fan3');
  const i1 = r.body.items?.find((x: any) => x.handle === 'fan1');
  check('GET …/followers/list items: not_found row (counts null, approx []), unread private null; timeout row keeps its counts', !!i3 && i3.profileCode === 'not_found' && i3.followers === null
    && Array.isArray(i3.approx) && i3.approx.length === 0 && i3.private === null && i1?.followers === 3 && i1.profileCode === 'timeout', r.text);
  const due = pickProfileVisits(await db.select().from(FW).where(eq(FW.socialAccountId, accA.id)));
  check('pick on the stored rows: nothing due (alpha / fan3 checked now, fan1\'s failed visit keeps its read of a minute ago, gone rows skipped)', due.length === 0, due.map((x) => `${x.kind}:${x.handle}`).join(','));
  await db.update(FW).set({ profileCheckedAt: null }).where(and(eq(FW.socialAccountId, accA.id), eq(FW.handle, 'fan1')));
  await writeProfile(accA.id, 'fan1', { kind: 'code', code: 'timeout' });
  const due2 = pickProfileVisits(await db.select().from(FW).where(eq(FW.socialAccountId, accA.id)));
  check('…a row whose visits only failed (never read) stays due for the next run', due2.map((x) => x.handle).join(',') === 'fan1', due2.map((x) => `${x.kind}:${x.handle}`).join(','));

  // ---------------------------------------------------------------- role menu rule
  const rule = menuRuleFor('GET', `/api/social/accounts/${accA.id}/following`);
  const rule2 = menuRuleFor('GET', `/api/social/accounts/${accA.id}/followers`);
  const rule3 = menuRuleFor('GET', `/api/social/accounts/${accA.id}/followers/list`);
  check('权限管理: …/following, …/followers and …/followers/list belong to the social menu', [rule, rule2, rule3].every((x) => JSON.stringify(x?.menus) === '["social"]'), JSON.stringify([rule, rule2, rule3]));

  // ---------------------------------------------------------------- migration 0044 shape, run twice
  const cols = await sqlClient`select column_name, is_nullable from information_schema.columns where table_name = 'social_account_following' order by ordinal_position`;
  const [fk] = await sqlClient`select confdeltype from pg_constraint where conname = 'social_account_following_social_account_id_social_accounts_id_fk'`;
  const [uq] = await sqlClient`select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'social_account_following_account_kind_handle' and contype = 'u'`;
  const [olduq] = await sqlClient`select 1 as ok from pg_constraint where conname = 'social_account_following_account_handle'`;
  const [kindCol] = await sqlClient`select column_default, is_nullable from information_schema.columns where table_name = 'social_account_following' and column_name = 'kind'`;
  check('migrations 0044 + 0046 + 0047: gone_at nullable, profile columns nullable, FK cascade, kind not null default following, unique (account, kind, handle), old unique gone',
    cols.map((c) => c.column_name).join(',') === 'id,social_account_id,handle,display_name,verified,position,first_seen_at,last_seen_at,gone_at,kind,followers,following,posts,approx,is_private,profile_checked_at,profile_code'
    && cols.filter((c) => ['followers', 'following', 'posts', 'approx', 'is_private', 'profile_checked_at', 'profile_code'].includes(String(c.column_name))).every((c) => c.is_nullable === 'YES')
    && cols.find((c) => c.column_name === 'gone_at')?.is_nullable === 'YES' && fk?.confdeltype === 'c' && /\(social_account_id, kind, handle\)/.test(String(uq?.def))
    && !olduq && kindCol?.is_nullable === 'NO' && /'following'/.test(String(kindCol?.column_default)), `${cols.map((c) => c.column_name)} ${fk?.confdeltype} ${uq?.def} ${JSON.stringify(kindCol)}`);
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
