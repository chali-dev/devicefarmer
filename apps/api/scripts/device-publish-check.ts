/**
 * 云手机发帖 without a phone (owner decision 2026-11-18): method selection and the fallback to an operator, the
 * 风控 → 云手机发帖 settings (validation, RBAC, audit), the daily cap / minimum gap deferral, the halted phone
 * (parked, 恢复 re-queues), test-mode rows (dry_run: not counted as failed, retry / reschedule allowed, evidence RBAC),
 * an uncertain share (awaiting the operator, never re-sent), through the real HTTP API and the real task centre.
 *
 * Devices are placeholder `instances` rows (no Android container, adb ports 5571–5573 that nothing listens on) kept
 * "online" by a test-only trigger like publish-check.ts: the `device` method takes their runs, finds that adb doesn't
 * see the phone and hands them to an operator (`publish.device_offline`) — so the phone is never touched. The real
 * phone flow (push, share target, caption read back, discard) is covered by device-publish-device-check.ts.
 * The dry_run / send_uncertain end states are written as DB fixtures (only a real phone produces them).
 *
 *   E2E_API=http://127.0.0.1:<port> API_PORT=<port> npx tsx --env-file=../../.env scripts/device-publish-check.ts
 */
import { randomBytes } from 'node:crypto';
import { and, eq, gte, inArray, sql } from 'drizzle-orm';
import sharp from 'sharp';
import { db, schema, sqlClient } from '../src/db/index.js';
import { haltDevice } from '../src/modules/tracked/collector.js';
import { withCaptcha } from './lib/login.js';

const API = process.env.E2E_API ?? `http://127.0.0.1:${process.env.API_PORT ?? 3000}`;
const results: [string, boolean][] = [];
const check = (name: string, ok: boolean, detail = '') => { results.push([name, ok]); console.log(`${ok ? '✓' : '✗'} ${name}${detail && !ok ? ` — ${detail.slice(0, 500)}` : ''}`); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function http<T = any>(method: string, p: string, token?: string, body?: unknown) {
  const res = await fetch(API + p, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined && !(body instanceof FormData) ? { 'content-type': 'application/json' } : {}) },
    body: body instanceof FormData ? body : body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, body: json as T, text: text.slice(0, 500) };
}
async function login(username: string, password: string): Promise<string> {
  const r = await http('POST', '/api/auth/login', undefined, await withCaptcha(API, { username, password }));
  if (!r.body?.token) throw new Error(`login ${username} failed: ${r.status}`);
  return r.body.token;
}
async function waitFor<T>(label: string, fn: () => Promise<T | null | false | undefined>, ms = 60_000): Promise<T> {
  const t0 = Date.now();
  for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() - t0 > ms) throw new Error(`timeout: ${label}`); await sleep(500); }
}
async function upload(token: string, name: string, data: Buffer, mime: string) {
  const fd = new FormData();
  fd.append('scope', 'mine');
  fd.append('file', new Blob([new Uint8Array(data)], { type: mime }), name);
  const r = await http('POST', '/api/media/upload', token, fd);
  if (r.status !== 201) throw new Error(`upload failed ${r.status} ${r.text}`);
  const id: string = r.body.item.id;
  await waitFor(`media ${name} ready`, async () => (await http('GET', `/api/media/${id}`, token)).body.item.status === 'ready', 120_000);
  return id;
}

const T = await login(process.env.ADMIN_USERNAME!, process.env.ADMIN_PASSWORD!);
const tag = randomBytes(3).toString('hex');
const PINNED = 'dpc-test-pinned-online';
const userIds: string[] = [];
const fakeIds: string[] = [];
const settingKeys = ['publish.device', 'risk.halts'];
const savedSettings = await db.select().from(schema.settings).where(inArray(schema.settings.key, settingKeys));
const t0 = new Date((await sqlClient`select now() as now`)[0]!.now as Date);
const pt = schema.publishTasks;
const ptask = async (token: string, id: string) => (await http('GET', `/api/publish/tasks/${id}`, token)).body;
const waitStatus = (token: string, id: string, statuses: string[], ms = 60_000) =>
  waitFor(`publish task ${id} → ${statuses.join('|')}`, async () => { const r = await ptask(token, id); return statuses.includes(r?.task?.status) && r.runs.every((x: any) => ['success', 'failed', 'cancelled'].includes(x.status)) ? r : null; }, ms);
/** A deferred run: the first round finished, the row waits for its next round. */
const waitDeferred = (token: string, id: string) => waitFor(`publish task ${id} deferred`, async () => {
  const r = await ptask(token, id);
  return r?.task?.status === 'scheduled' && r.task.attemptNo >= 2 && r.runs[0] && ['success', 'failed'].includes(r.runs[0].status) ? r : null;
});
const msgs = (d: any) => (d.logs as any[]).map((l) => l.message as string);

try {
  // ---------------------------------------------------------------- setup
  const pw = randomBytes(12).toString('base64url');
  for (const n of ['a', 'b']) userIds.push((await http('POST', '/api/users', T, { username: `dpc${n}${tag}`, password: pw, role: 'user' })).body.user.id);
  const [uA] = userIds as [string, string];
  const A = await login(`dpca${tag}`, pw);
  const B = await login(`dpcb${tag}`, pw);
  await sqlClient.unsafe(`create or replace function dpc_test_pin_online() returns trigger language plpgsql as $$
    begin if new.image = '${PINNED}' then new.status := 'running'; new.adb_state := 'device'; end if; return new; end $$`);
  await sqlClient.unsafe('drop trigger if exists dpc_test_pin_online on instances');
  await sqlClient.unsafe('create trigger dpc_test_pin_online before update on instances for each row execute function dpc_test_pin_online()');
  const fakes = await db.insert(schema.instances).values([0, 1, 2].map((i) => ({ name: `dpcfake-${tag}-${i}`, status: 'running' as const, adbState: 'device', image: PINNED, adbPort: 5571 + i, spec: { width: 720, height: 1280, dpi: 320 } }))).returning();
  fakeIds.push(...fakes.map((f) => f.id));
  const [D0, D1, D2] = fakes as [typeof fakes[number], typeof fakes[number], typeof fakes[number]];
  await http('PUT', `/api/users/${uA}/grants`, T, { instanceIds: fakeIds });
  const acc = async (instanceId: string | null) => {
    const r = await http('POST', '/api/social/accounts', A, { platform: 'instagram', handle: `dpc_${tag}_${randomBytes(2).toString('hex')}`, ...(instanceId ? { instanceId } : {}) });
    if (r.status !== 201) throw new Error(`account create failed ${r.status} ${r.text}`);
    return r.body.account as { id: string; handle: string };
  };
  const a0 = await acc(D0.id);
  const a1 = await acc(D1.id);
  const a2 = await acc(D2.id);
  const jpg = (r: number) => sharp({ create: { width: 360, height: 360, channels: 3, background: { r, g: 120, b: 80 } } }).jpeg().toBuffer();
  const img = await upload(A, `dpc-${tag}-1.jpg`, await jpg(20), 'image/jpeg');
  const img2 = await upload(A, `dpc-${tag}-2.jpg`, await jpg(90), 'image/jpeg');
  const content = async (title: string, media: string[]) => {
    const r = await http('POST', '/api/contents', A, { title: `dpc-${tag} ${title}`, body: `正文 ${title} ✅`, mediaIds: media });
    if (r.status !== 201) throw new Error(`content ${r.text}`);
    return r.body.content.id as string;
  };
  const dist = async (cid: string, accountId: string, extra: Record<string, unknown> = {}) => {
    const r = await http('POST', `/api/contents/${cid}/distribute`, A, { targets: [{ accountId, ...extra }] });
    if (r.status !== 201) throw new Error(`distribute ${r.status} ${r.text}`);
    return r.body.created[0] as any;
  };

  // ---------------------------------------------------------------- settings: defaults, validation, RBAC, audit
  let r = await http('GET', '/api/publish/device-settings', T);
  check('settings default: enabled, 3 posts / 24 h, 60 min gap, test mode ON', r.status === 200 && JSON.stringify(r.body.rules) === JSON.stringify({ enabled: true, postsPerDay: 3, minGapMin: 60, testMode: true }), r.text);
  const [g403, p403] = await Promise.all([http('GET', '/api/publish/device-settings', A), http('PUT', '/api/publish/device-settings', A, { testMode: false })]);
  check('settings: users get 403 (read and write)', g403.status === 403 && p403.status === 403 && g403.body.code === 'publish.admin_only', `${g403.status} ${p403.status}`);
  const bad = await Promise.all([
    http('PUT', '/api/publish/device-settings', T, { postsPerDay: 0 }), http('PUT', '/api/publish/device-settings', T, { minGapMin: 2000 }),
    http('PUT', '/api/publish/device-settings', T, { testMode: 'no' }), http('PUT', '/api/publish/device-settings', T, { other: 1 }),
  ]);
  check('settings: out-of-range / wrong type / unknown field → 400', bad.every((x) => x.status === 400), bad.map((x) => x.status).join(','));
  r = await http('PUT', '/api/publish/device-settings', T, { postsPerDay: 5, minGapMin: 0 });
  check('settings: partial PUT keeps the other fields', r.status === 200 && r.body.rules.postsPerDay === 5 && r.body.rules.minGapMin === 0 && r.body.rules.testMode === true && r.body.rules.enabled === true, r.text);

  // ---------------------------------------------------------------- method selection: device → adb doesn't see the phone → operator
  let p = await dist(await content('offline', [img]), a0.id);
  let d = await waitStatus(A, p.id, ['awaiting_operator', 'failed']);
  let res = d.runs[d.runs.length - 1]?.result;
  check('IG account on a (placeholder) phone: method device tried, adb doesn\'t see it → operator (manual, reason publish.device_offline)',
    d.task.status === 'awaiting_operator' && d.task.method === 'manual' && msgs(d).includes('method device') && msgs(d).includes('method device not available: publish.device_offline')
    && res?.reasons?.device === 'publish.device_offline', `${d.task.status} ${d.task.method} ${JSON.stringify(res)} ${msgs(d).join(' | ')}`);
  const [row0] = await db.select().from(pt).where(eq(pt.id, p.id));
  check('the offline phone did not count as a device run (device_run_at undone)', row0?.deviceRunAt === null, String(row0?.deviceRunAt));
  check('logged "cloud phone: test mode" before trying the phone', msgs(d).includes('cloud phone: test mode (stops before sharing)'));

  // feed with a video → by hand
  const vid = await upload(A, `dpc-${tag}.mp4`, await (async () => {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const fs = await import('node:fs');
    const out = `${process.env.TMPDIR ?? '/tmp'}/dpc-${tag}.mp4`;
    await promisify(execFile)(process.env.FFMPEG_PATH ?? 'ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=2:size=160x284:rate=5', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', '-y', out]);
    const b = fs.readFileSync(out); fs.unlinkSync(out); return b;
  })(), 'video/mp4');
  p = await dist(await content('feed video', [vid]), a0.id);
  d = await waitStatus(A, p.id, ['awaiting_operator', 'failed']);
  check('帖子 with a video → device not available (publish.device_feed_video) → operator, phone not tried',
    d.task.status === 'awaiting_operator' && d.task.method === 'manual' && msgs(d).includes('method device not available: publish.device_feed_video') && !msgs(d).includes('method device'), msgs(d).join(' | '));

  // switched off → by hand
  await http('PUT', '/api/publish/device-settings', T, { enabled: false });
  p = await dist(await content('disabled', [img]), a0.id);
  d = await waitStatus(A, p.id, ['awaiting_operator', 'failed']);
  check('云手机发帖 off → publish.device_disabled → operator (as before)', d.task.status === 'awaiting_operator' && d.task.method === 'manual'
    && msgs(d).includes('method device not available: publish.device_disabled'), msgs(d).join(' | '));
  await http('PUT', '/api/publish/device-settings', T, { enabled: true });

  // no phone at all: the precheck still fails (an operator needs the phone too)
  const aNo = await acc(null);
  p = await dist(await content('no device', [img]), aNo.id);
  d = await waitStatus(A, p.id, ['failed', 'awaiting_operator']);
  check('account without a phone: precheck fails publish.no_device (unchanged)', d.task.status === 'failed' && d.task.errorCode === 'publish.no_device', `${d.task.status} ${d.task.errorCode}`);

  // ---------------------------------------------------------------- daily cap / minimum gap → deferred (new round), never dropped
  await http('PUT', '/api/publish/device-settings', T, { postsPerDay: 3, minGapMin: 60 });
  const past = await dist(await content('earlier run', [img]), a1.id, { scheduledAt: new Date(Date.now() + 3 * 86400_000).toISOString() });
  await db.update(pt).set({ deviceRunAt: new Date(Date.now() - 10 * 60_000) }).where(eq(pt.id, past.id));
  p = await dist(await content('min gap', [img2]), a1.id);
  d = await waitDeferred(A, p.id);
  let [row] = await db.select().from(pt).where(eq(pt.id, p.id));
  const gapAt = row!.scheduledAt.getTime() - (Date.now() - 10 * 60_000);
  check('min gap (60 min, last run 10 min ago) → scheduled again ~50 min later, round 2, new task waiting, code publish.min_gap',
    row?.status === 'scheduled' && row.attemptNo === 2 && row.errorCode === 'publish.min_gap' && gapAt > 59 * 60_000 && gapAt < 62 * 60_000 && !!row.taskId
    && d.runs.length === 2 && d.runs[1].status === 'scheduled' && d.runs[0].result?.code === 'publish.min_gap', `${row?.status} ${row?.attemptNo} ${row?.errorCode} ${gapAt} ${JSON.stringify(d.runs.map((x: any) => [x.status, x.result]))}`);
  check('the deferral is logged with the retry time', (d.logs as any[]).some((l) => l.message === 'minimum gap between two posts not reached (60 min), deferred' && !!l.data?.retryAt));
  check('a deferred run is not a device run (device_run_at stays empty)', row?.deviceRunAt === null);
  r = await http('POST', `/api/publish/tasks/${p.id}/cancel`, A);
  check('the deferred round can be cancelled like any scheduled task', r.status === 200 && r.body.task.status === 'cancelled', r.text);

  await http('PUT', '/api/publish/device-settings', T, { postsPerDay: 2, minGapMin: 0 });
  const past2 = await dist(await content('earlier run 2', [img]), a1.id, { scheduledAt: new Date(Date.now() + 3 * 86400_000).toISOString() });
  await db.update(pt).set({ deviceRunAt: new Date(Date.now() - 5 * 3600_000) }).where(eq(pt.id, past2.id));
  await db.update(pt).set({ deviceRunAt: new Date(Date.now() - 2 * 3600_000) }).where(eq(pt.id, past.id));
  p = await dist(await content('daily cap', [img2]), a1.id);
  await waitDeferred(A, p.id);
  [row] = await db.select().from(pt).where(eq(pt.id, p.id));
  const capAt = row!.scheduledAt.getTime() - (Date.now() - 5 * 3600_000);
  check('daily cap (2 per 24 h, runs 5 h + 2 h ago, dry runs count too) → deferred until the older one is 24 h old, code publish.daily_limited',
    row?.status === 'scheduled' && row.errorCode === 'publish.daily_limited' && capAt > 23.9 * 3600_000 && capAt < 24.1 * 3600_000, `${row?.status} ${row?.errorCode} ${capAt / 3600_000}`);
  await http('POST', `/api/publish/tasks/${p.id}/cancel`, A);
  await http('PUT', '/api/publish/device-settings', T, { postsPerDay: 3, minGapMin: 60 });

  // ---------------------------------------------------------------- halted phone: parked, 恢复 re-queues
  await haltDevice(D2, { code: 'publish.device_challenge', source: 'publish', platform: 'instagram', socialAccountId: a2.id });
  p = await dist(await content('halted', [img]), a2.id);
  await waitFor('parked', async () => { const [x] = await db.select().from(pt).where(eq(pt.id, p.id)); return x?.errorCode === 'publish.device_halted' && x.taskId === null ? x : null; });
  d = await ptask(A, p.id);
  check('halted phone: the run is parked (scheduled, no task, publish.device_halted), not sent, not dropped',
    d.task.status === 'scheduled' && d.task.taskId === null && d.task.errorCode === 'publish.device_halted' && msgs(d).includes('device halted (risk control): waiting until an admin resumes it'), `${d.task.status} ${d.task.errorCode}`);
  await sleep(1500);
  check('parked: no new task appears on its own', (await ptask(A, p.id)).runs.every((x: any) => x.status !== 'pending' && x.status !== 'scheduled'));
  r = await http('POST', `/api/risk/devices/${D2.id}/resume`, T);
  check('恢复 on the 风控 page → 200 resumed', r.status === 200 && r.body.resumed === true, r.text);
  d = await waitStatus(A, p.id, ['awaiting_operator', 'failed']);
  check('after 恢复 the parked run is queued again (new round) and runs (here: adb offline → operator)',
    d.task.attemptNo === 2 && msgs(d).includes('device resumed: queued again') && d.task.status === 'awaiting_operator', `${d.task.status} ${d.task.attemptNo} ${msgs(d).join(' | ')}`);

  // ---------------------------------------------------------------- dry_run rows (fixture: only a real phone produces them)
  const dryC = await content('dry run', [img]);
  p = await dist(dryC, a1.id, { scheduledAt: new Date(Date.now() + 2 * 86400_000).toISOString() });
  const [tk] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, p.taskId));
  await http('POST', `/api/publish/tasks/${p.id}/cancel`, A); // the fixture replaces the waiting round
  await db.update(pt).set({ status: 'dry_run', method: 'device', errorCode: 'publish.test_mode', error: null, deviceRunAt: new Date(), evidence: { at: new Date().toISOString(), inputText: '正文 ✅', excerpt: 'feed_caption · media 1' } }).where(eq(pt.id, p.id));
  await sqlClient`select 1`;
  d = await ptask(A, p.id);
  check('dry_run row: listed with its read-back caption, no screenshot (hasEvidence false), evidence key never returned',
    d.task.status === 'dry_run' && d.task.evidence?.inputText === '正文 ✅' && d.task.hasEvidence === false && !JSON.stringify(d.task).includes('"key"'), JSON.stringify(d.task.evidence));
  const [contentRow] = await db.select().from(schema.contents).where(eq(schema.contents.id, dryC));
  await http('PUT', `/api/contents/${dryC}`, A, { title: `dpc-${tag} dry run` }); // triggers no status change by itself
  const listC = await http('GET', `/api/contents?q=${encodeURIComponent(`dpc-${tag} dry run`)}`, A);
  check('content status does not turn "failed" because of a test run', !['failed', 'partially_published', 'published'].includes(listC.body.items?.[0]?.status ?? contentRow?.status), listC.body.items?.[0]?.status);
  r = await http('GET', `/api/publish/tasks?status=dry_run&contentId=${dryC}`, A);
  check('list filter status=dry_run + byStatus.dry_run', r.status === 200 && r.body.items.length === 1 && r.body.byStatus.dry_run >= 1, r.text);
  const [e404, eB] = await Promise.all([http('GET', `/api/publish/tasks/${p.id}/evidence`, A), http('GET', `/api/publish/tasks/${p.id}/evidence`, B)]);
  check('evidence endpoint: no screenshot → 404 publish.no_evidence; another user → 404 publish.not_found', e404.status === 404 && e404.body.code === 'publish.no_evidence' && eB.status === 404 && eB.body.code === 'publish.not_found', `${e404.text} ${eB.text}`);
  r = await http('POST', `/api/publish/tasks/${p.id}/reschedule`, B, { scheduledAt: null });
  check('another user cannot reschedule it (404)', r.status === 404);
  r = await http('POST', `/api/publish/tasks/${p.id}/reschedule`, A, { scheduledAt: new Date(Date.now() + 86400_000).toISOString() });
  check('dry_run → 改期 allowed: new round, scheduled, test-mode code cleared', r.status === 200 && r.body.task.status === 'scheduled' && r.body.task.attemptNo === 2 && r.body.task.errorCode === null, r.text);
  await db.update(pt).set({ status: 'dry_run', taskId: null }).where(eq(pt.id, p.id));
  r = await http('POST', `/api/publish/tasks/${p.id}/retry`, A, { scheduledAt: new Date(Date.now() + 86400_000).toISOString() });
  check('dry_run → 重试 allowed: new round', r.status === 202 && r.body.task.status === 'scheduled' && r.body.task.attemptNo === 3, r.text);
  await http('POST', `/api/publish/tasks/${p.id}/cancel`, A);
  void tk;

  // ---------------------------------------------------------------- send_uncertain (fixture): waits for the operator, nothing re-sent
  p = await dist(await content('uncertain', [img]), a1.id, { scheduledAt: new Date(Date.now() + 2 * 86400_000).toISOString() });
  await http('POST', `/api/publish/tasks/${p.id}/cancel`, A);
  await db.update(pt).set({ status: 'awaiting_operator', method: 'device', errorCode: 'publish.send_uncertain', error: '已点“分享”，但没能在主页确认新帖子', taskId: null }).where(eq(pt.id, p.id));
  r = await http('POST', `/api/publish/tasks/${p.id}/retry`, A, {});
  check('uncertain share: retry refused (409, it may have been posted)', r.status === 409 && r.body.code === 'publish.bad_status', r.text);
  r = await http('POST', `/api/publish/tasks/${p.id}/outcome`, A, { result: 'published', url: 'https://www.instagram.com/p/TESTONLY/' });
  check('uncertain share: the operator records the outcome after checking the phone', r.status === 200 && r.body.task.status === 'published', r.text);
  const tasksOf = await db.select().from(schema.tasks).where(and(eq(schema.tasks.refId, p.id), inArray(schema.tasks.status, ['pending', 'scheduled', 'running'])));
  check('uncertain share: no task was queued again', tasksOf.length === 0);

  // ---------------------------------------------------------------- audit
  await sleep(500);
  const audit = await db.select().from(schema.auditLogs).where(and(gte(schema.auditLogs.at, t0), eq(schema.auditLogs.action, 'publish.device_settings')));
  check('audit: publish.device_settings with the values (admin only; refused user attempt recorded as 403)',
    audit.some((a) => a.status === 200 && (a.detail as any)?.postsPerDay === 5 && (a.detail as any)?.minGapMin === 0) && audit.some((a) => a.status === 403), JSON.stringify(audit.map((a) => [a.status, a.detail])));
} catch (err) {
  check(`stopped: ${(err as Error).stack ?? (err as Error).message}`, false);
} finally {
  await db.update(schema.tasks).set({ status: 'cancelled', finishedAt: new Date() }).where(and(inArray(schema.tasks.status, ['pending', 'scheduled']), sql`${schema.tasks.createdAt} >= ${t0.toISOString()}::timestamptz`, eq(schema.tasks.type, 'publish')));
  for (const id of userIds) await http('DELETE', `/api/users/${id}`, T);
  if (fakeIds.length) {
    await db.delete(schema.riskEvents).where(inArray(schema.riskEvents.instanceId, fakeIds));
    await db.delete(schema.instances).where(inArray(schema.instances.id, fakeIds));
  }
  await sqlClient.unsafe('drop trigger if exists dpc_test_pin_online on instances');
  await sqlClient.unsafe('drop function if exists dpc_test_pin_online()');
  await db.delete(schema.settings).where(inArray(schema.settings.key, settingKeys));
  if (savedSettings.length) await db.insert(schema.settings).values(savedSettings);
  const failed = results.filter(([, ok]) => !ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  await sqlClient.end();
  process.exit(failed ? 1 : 0);
}
