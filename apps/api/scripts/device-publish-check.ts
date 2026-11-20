/**
 * 云手机发帖 without a phone (owner decision 2026-11-18): method selection and the fallback to an operator, the
 * 风控 → 云手机发帖 settings (validation, RBAC, audit), the daily cap / minimum gap deferral, the halted phone
 * (parked, 恢复 re-queues), an uncertain share (awaiting the operator, never re-sent: there is no retry endpoint,
 * distributing the content again returns the waiting task; 编辑后重新发布 = cancel it, then a new task), through the
 * real HTTP API and the real task centre. No test mode and no on/off switch (removed 2026-11-18): the strict settings
 * refuse `testMode` / `enabled` (400), and a content is only a draft until it is distributed.
 *
 * Devices are placeholder `instances` rows (no Android container, adb ports 5571–5573 that nothing listens on) kept
 * "online" by a test-only trigger like publish-check.ts: the `device` method takes their runs, finds that adb doesn't
 * see the phone and hands them to an operator (`publish.device_offline`) — so the phone is never touched. The real
 * phone flow (push, share target, caption read back, discard) is covered by device-publish-device-check.ts.
 * The send_uncertain end state is written as a DB fixture.
 * 未点分享不计数 (owner 2026-11-18): the phone side of a run (withDevice + the Instagram flow) is replaced in THIS
 * process by stand-ins (`runDevicePublish` deps) that fail before 分享 or after it (calling `onShare` first); the
 * reservation (device_run_at) in the real DB is checked, then a real run through the API shows whether the next round
 * is deferred by the minimum gap. The real flow itself is not exercised here (no phone).
 *
 *   E2E_API=http://127.0.0.1:<port> API_PORT=<port> npx tsx --env-file=../../.env scripts/device-publish-check.ts
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { and, eq, gte, inArray, sql } from 'drizzle-orm';
import sharp from 'sharp';
import { db, schema, sqlClient } from '../src/db/index.js';
import { haltDevice } from '../src/modules/tracked/collector.js';
import { runDevicePublish, type DeviceRunDeps } from '../src/modules/publish/device.js';
import { captionPageDone, CONFIRM_WINDOW_MS, PublishDeviceError } from '../src/modules/publish/ig-publish.js';
import { firstGridItem, isGridEmpty, permalinkOf, pkTime } from '../src/modules/feed/ig-ui.js';
import { classifyIgDump, parseUiDump } from '../src/modules/tracked/instagram-device.js';
import { withCaptcha } from './lib/login.js';
import { linkAccount } from './lib/social-link.js';
import { placeholders } from './lib/placeholder.js';

const ph = placeholders('dpcfake');

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
    begin if new.external_id like '${PINNED}%' then new.status := 'running'; new.adb_state := 'device'; end if; return new; end $$`);
  await sqlClient.unsafe('drop trigger if exists dpc_test_pin_online on instances');
  await sqlClient.unsafe('create trigger dpc_test_pin_online before update on instances for each row execute function dpc_test_pin_online()');
  const fakes = await ph.insert([0, 1, 2].map((i) => ({ name: `dpcfake-${tag}-${i}`, externalId: `${PINNED}-${tag}-${i}`, status: 'running' as const, adbState: 'device', adbPort: 5571 + i })));
  fakeIds.push(...fakes.map((f) => f.id));
  const [D0, D1, D2] = fakes as [typeof fakes[number], typeof fakes[number], typeof fakes[number]];
  await http('PUT', `/api/users/${uA}/grants`, T, { instanceIds: fakeIds });
  const acc = async (instanceId: string | null) => {
    const r = await http('POST', '/api/social/accounts', A, { platform: 'instagram', handle: `dpc_${tag}_${randomBytes(2).toString('hex')}` });
    if (r.status !== 201) throw new Error(`account create failed ${r.status} ${r.text}`);
    // device link: read only in the API since 2026-11-18 (set by 从云手机同步); written with the sync's rules (lib/social-link.ts)
    if (instanceId) await linkAccount(r.body.account.id, instanceId);
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
  check('settings default: 3 posts / 24 h, 60 min gap, no test mode, no on/off switch', r.status === 200 && JSON.stringify(r.body.rules) === JSON.stringify({ postsPerDay: 3, minGapMin: 60 }), r.text);
  const [g403, p403] = await Promise.all([http('GET', '/api/publish/device-settings', A), http('PUT', '/api/publish/device-settings', A, { postsPerDay: 2 })]);
  check('settings: users get 403 (read and write)', g403.status === 403 && p403.status === 403 && g403.body.code === 'publish.admin_only', `${g403.status} ${p403.status}`);
  const bad = await Promise.all([
    http('PUT', '/api/publish/device-settings', T, { postsPerDay: 0 }), http('PUT', '/api/publish/device-settings', T, { minGapMin: 2000 }),
    http('PUT', '/api/publish/device-settings', T, { testMode: 'no' }), http('PUT', '/api/publish/device-settings', T, { other: 1 }),
    http('PUT', '/api/publish/device-settings', T, { enabled: true }), http('PUT', '/api/publish/device-settings', T, { testMode: false }),
  ]);
  check('settings: out-of-range / wrong type / unknown field (incl. the removed testMode / enabled) → 400', bad.every((x) => x.status === 400), bad.map((x) => x.status).join(','));
  r = await http('PUT', '/api/publish/device-settings', T, { postsPerDay: 5, minGapMin: 0 });
  check('settings: partial PUT keeps the other fields', r.status === 200 && r.body.rules.postsPerDay === 5 && r.body.rules.minGapMin === 0 && !('enabled' in r.body.rules) && !('testMode' in r.body.rules), r.text);

  // ---------------------------------------------------------------- draft first: a content creates no publish task until it is distributed
  const offC = await content('offline', [img]);
  const before = await db.select().from(pt).where(eq(pt.contentId, offC));
  check('a saved content is only a draft: no publish task until 发布 / 排程发布 (distribute)', before.length === 0, String(before.length));
  // ---------------------------------------------------------------- method selection: device → adb doesn't see the phone → operator
  let p = await dist(offC, a0.id);
  let d = await waitStatus(A, p.id, ['awaiting_operator', 'failed']);
  let res = d.runs[d.runs.length - 1]?.result;
  check('IG account on a (placeholder) phone: method device tried, adb doesn\'t see it → operator (manual, reason publish.device_offline)',
    d.task.status === 'awaiting_operator' && d.task.method === 'manual' && msgs(d).includes('method device') && msgs(d).includes('method device not available: publish.device_offline')
    && res?.reasons?.device === 'publish.device_offline', `${d.task.status} ${d.task.method} ${JSON.stringify(res)} ${msgs(d).join(' | ')}`);
  const [row0] = await db.select().from(pt).where(eq(pt.id, p.id));
  check('the offline phone did not count as a device run (device_run_at undone)', row0?.deviceRunAt === null, String(row0?.deviceRunAt));
  check('logged "cloud phone: live" before trying the phone (no test mode any more)', msgs(d).includes('cloud phone: live (shares the post)') && !msgs(d).some((m) => /test mode/.test(m)));

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

  // the account's owner no longer holds the phone (owner decision 2026-11-19; grant row removed in the DB) → by hand
  await db.delete(schema.instanceGrants).where(and(eq(schema.instanceGrants.userId, uA), eq(schema.instanceGrants.instanceId, D0.id)));
  p = await dist(await content('no grant', [img]), a0.id);
  d = await waitStatus(A, p.id, ['awaiting_operator', 'failed']);
  check('owner without the phone\'s grant → device not available (publish.device_not_granted) → operator, phone not tried',
    d.task.status === 'awaiting_operator' && d.task.method === 'manual' && msgs(d).includes('method device not available: publish.device_not_granted') && !msgs(d).includes('method device'), msgs(d).join(' | '));
  await db.insert(schema.instanceGrants).values({ userId: uA, instanceId: D0.id });

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

  // ---------------------------------------------------------------- a failure before 分享 does not count (min gap / daily cap); after 分享 it does
  {
    const locks: (number | undefined)[] = [];
    const fakeDevice = (async (inst: any, _log: any, _off: any, fn: any, opts: any) => { locks.push(opts?.lockMs); return fn({ inst, adbPort: inst.adbPort }); }) as unknown as DeviceRunDeps['withDevice'];
    const failBefore = (async () => { throw new PublishDeviceError('publish.device_text_mismatch', 'mismatch (test)', { excerpt: 'read back: x' }); }) as unknown as DeviceRunDeps['flow'];
    const plainBefore = (async () => { throw new Error('boom before share (test)'); }) as unknown as DeviceRunDeps['flow'];
    const shotPng = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#0a0' } }).png().toBuffer();
    const uncertain = (async (_d: any, inp: any) => { inp.onShare(); throw new PublishDeviceError('publish.send_uncertain', 'uncertain (test)', { afterSend: true, shot: shotPng, excerpt: 'feed_caption · media 1' }); }) as unknown as DeviceRunDeps['flow'];
    const plainAfter = (async (_d: any, inp: any) => { inp.onShare(); throw new Error('boom after share (test)'); }) as unknown as DeviceRunDeps['flow'];
    const [accRow] = await db.select().from(schema.socialAccounts).where(eq(schema.socialAccounts.id, a0.id));
    const runWith = async (taskId: string, flow: DeviceRunDeps['flow'], timeoutMs?: number) => {
      const [row] = await db.select().from(pt).where(eq(pt.id, taskId));
      const logs: string[] = [];
      const ctx = { row: row!, log: async (_l: string, m: string) => { logs.push(m); }, task: { task: { timeoutMs: timeoutMs ?? null } as any, payload: {}, attempt: 1, signal: new AbortController().signal, log: async () => undefined } };
      const input = { publishTaskId: row!.id, attemptNo: row!.attemptNo, platform: 'instagram', account: accRow!, caption: row!.caption, options: {}, media: [], postType: 'feed' as const };
      let out: any; let err: any = null;
      try { out = await runDevicePublish(input as any, ctx as any, { withDevice: fakeDevice, flow }); } catch (e) { err = e; }
      const [after] = await db.select().from(pt).where(eq(pt.id, taskId));
      return { out, err, logs, runAt: after!.deviceRunAt };
    };
    // a task whose own round is far away (cancelled): only its device_run_at matters here
    const x = await dist(await content('pre-share fail', [img]), a0.id, { scheduledAt: new Date(Date.now() + 3 * 86400_000).toISOString() });
    await http('POST', `/api/publish/tasks/${x.id}/cancel`, A);
    let rr = await runWith(x.id, failBefore);
    rr = await runWith(x.id, failBefore, 30 * 60_000);
    check('device lock follows the task timeout (系统配置 → 任务超时): at least 12 min, a 30 min task → 31 min lock',
      locks[0] === 12 * 60_000 && locks[1] === 31 * 60_000, locks.join(','));
    check('failure before 分享 (text mismatch): run fails publish.device_text_mismatch, reservation undone (device_run_at back to empty), logged as not counted',
      rr.err?.code === 'publish.device_text_mismatch' && rr.runAt === null && rr.logs.includes('failed before 分享: not counted toward the daily cap / minimum gap'), `${rr.err?.code} ${String(rr.runAt)} ${rr.logs.join(' | ')}`);
    rr = await runWith(x.id, plainBefore);
    check('any other error before 分享: reservation undone too', !!rr.err && rr.runAt === null, `${rr.err?.message} ${String(rr.runAt)}`);
    p = await dist(await content('after pre-share fail', [img2]), a0.id);
    d = await waitStatus(A, p.id, ['awaiting_operator', 'failed', 'scheduled']);
    check('next run right after (min gap 60 min) is NOT deferred by publish.min_gap (here: adb offline → operator)',
      d.task.status === 'awaiting_operator' && d.task.errorCode !== 'publish.min_gap' && !msgs(d).some((m) => m.includes('minimum gap')), `${d.task.status} ${d.task.errorCode} ${msgs(d).join(' | ')}`);
    rr = await runWith(x.id, uncertain);
    check('after 分享 without confirmation (send_uncertain): awaiting operator, reservation KEPT (device_run_at ≈ now)',
      rr.out?.state === 'awaiting_operator' && rr.out?.code === 'publish.send_uncertain' && !!rr.runAt && Date.now() - rr.runAt.getTime() < 60_000, `${JSON.stringify(rr.out)} ${rr.err?.message} ${String(rr.runAt)}`);
    const [ev] = await db.select({ evidence: pt.evidence }).from(pt).where(eq(pt.id, x.id));
    const evr = await http('GET', `/api/publish/tasks/${x.id}/evidence`, A);
    check('send_uncertain keeps the screenshot of the shared screen as evidence (row + evidence endpoint 200 PNG)',
      !!(ev?.evidence as any)?.key && evr.status === 200, `${JSON.stringify(ev?.evidence)} ${evr.status}`);
    rr = await runWith(x.id, plainAfter);
    check('any error after 分享: reservation kept', !!rr.err && !!rr.runAt && Date.now() - rr.runAt.getTime() < 60_000, `${rr.err?.message} ${String(rr.runAt)}`);
    p = await dist(await content('after shared', [img2]), a0.id);
    d = await waitDeferred(A, p.id);
    const [def] = await db.select().from(pt).where(eq(pt.id, p.id));
    check('next run after a share that counted → deferred publish.min_gap', def?.errorCode === 'publish.min_gap' && def.status === 'scheduled', `${def?.status} ${def?.errorCode}`);
    await http('POST', `/api/publish/tasks/${p.id}/cancel`, A);
    await db.update(pt).set({ deviceRunAt: null }).where(eq(pt.id, x.id));
  }

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

  // ---------------------------------------------------------------- send_uncertain (fixture): waits for the operator, nothing re-sent
  p = await dist(await content('uncertain', [img]), a1.id, { scheduledAt: new Date(Date.now() + 2 * 86400_000).toISOString() });
  await http('POST', `/api/publish/tasks/${p.id}/cancel`, A);
  await db.update(pt).set({ status: 'awaiting_operator', method: 'device', errorCode: 'publish.send_uncertain', error: '已点“分享”，但没能在主页确认新帖子', taskId: null }).where(eq(pt.id, p.id));
  r = await http('POST', `/api/publish/tasks/${p.id}/retry`, A, {});
  check('uncertain share: no retry endpoint any more (404; it may have been posted)', r.status === 404, r.text);
  r = await http('POST', `/api/contents/${p.contentId}/distribute`, A, { targets: [{ accountId: a1.id }] });
  check('uncertain share: distributing the content again creates nothing (returns the waiting task)', r.status === 200 && r.body.created.length === 0 && r.body.existing[0]?.id === p.id, r.text.slice(0, 200));
  r = await http('POST', `/api/publish/tasks/${p.id}/outcome`, A, { result: 'published', url: 'https://www.instagram.com/p/TESTONLY/' });
  check('uncertain share: the operator records the outcome after checking the phone', r.status === 200 && r.body.task.status === 'published', r.text);
  const tasksOf = await db.select().from(schema.tasks).where(and(eq(schema.tasks.refId, p.id), inArray(schema.tasks.status, ['pending', 'scheduled', 'running'])));
  check('uncertain share: no task was queued again', tasksOf.length === 0);
  // 编辑后重新发布 after an uncertain share (the UI confirms first): cancel the waiting task, edit, distribute → a NEW task.
  {
    const cid = await content('uncertain2', [img]);
    const q = await dist(cid, a1.id, { scheduledAt: new Date(Date.now() + 2 * 86400_000).toISOString() });
    await http('POST', `/api/publish/tasks/${q.id}/cancel`, A);
    await db.update(pt).set({ status: 'awaiting_operator', method: 'device', errorCode: 'publish.send_uncertain', error: 'uncertain', taskId: null }).where(eq(pt.id, q.id));
    r = await http('POST', `/api/publish/tasks/${q.id}/cancel`, A);
    check('uncertain share: cancel (编辑后重新发布 confirmed) → cancelled', r.status === 200 && r.body.task.status === 'cancelled', r.text.slice(0, 160));
    await http('PUT', `/api/contents/${cid}`, A, { body: `edited ${tag}` });
    r = await http('POST', `/api/contents/${cid}/distribute`, A, { targets: [{ accountId: a1.id, scheduledAt: new Date(Date.now() + 2 * 86400_000).toISOString() }] });
    const n = r.body.created?.[0];
    check('then distributing again creates a NEW task with the edited text (1 attempt); the uncertain one stays cancelled', r.status === 201 && n?.id !== q.id && n?.caption === `edited ${tag}` && n?.maxAttempts === 1
      && (await ptask(A, q.id)).task.status === 'cancelled', r.text.slice(0, 200));
    if (n) await http('POST', `/api/publish/tasks/${n.id}/cancel`, A);
  }

  // ---------------------------------------------------------------- confirmation after 分享 (real dumps of bit-ins-02, 2026-11-18, other users' names replaced)
  {
    const fx = (n: string) => parseUiDump(readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8'));
    const stale = fx('ig-own-profile-stale-grid.xml');
    const fresh = fx('ig-own-profile-refreshed.xml');
    check('own profile minutes after the post was online: header counts 1 post, the cached grid is still empty (no grid item)',
      classifyIgDump(stale, 'conchadoroperto650').kind === 'profile' && (classifyIgDump(stale, 'conchadoroperto650') as any).counts.posts?.value === 1 && isGridEmpty(stale) && !firstGridItem(stale),
      JSON.stringify(classifyIgDump(stale, 'conchadoroperto650')).slice(0, 300));
    check('after pull to refresh: the grid item is there, no empty state', !!firstGridItem(fresh)?.bounds && !isGridEmpty(fresh));
    // The real post: media pk read from the contextual feed, shared at 16:03:12 UTC, created by Instagram 127 s later.
    const pk = '4033225091115777362';
    check('media pk → creation time 16:05:19.431Z (127 s after 分享) and permalink /p/Df45Nn3Jf1S/; inside the confirmation window',
      pkTime(pk).toISOString() === '2026-11-18T16:05:19.431Z' && permalinkOf(pk) === 'https://www.instagram.com/p/Df45Nn3Jf1S/'
      && pkTime(pk).getTime() - Date.parse('2026-11-18T16:03:12.838Z') < CONFIRM_WINDOW_MS, `${pkTime(pk).toISOString()} ${permalinkOf(pk)}`);
  }

  // ---------------------------------------------------------------- the full-screen 「配文」 page (2026-11-19 publish ended 「找不到分享按钮」 on it)
  {
    // Constructed from the failed run's screen excerpt (ids action_bar_textview_title / next_button_textview, texts 返回 | 配文 | 确定); no full dump was kept.
    const n = (rid: string, text: string, bounds: string, clickable = false) => `<node index="0" text="${text}" resource-id="${rid ? `com.instagram.android:id/${rid}` : ''}" class="android.widget.TextView" package="com.instagram.android" content-desc="" checkable="false" checked="false" clickable="${clickable}" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="${bounds}" drawing-order="0" hint="" />`;
    const page = (title: string, done: string) => parseUiDump(`<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0">${n('button_back', '', '[0,120][132,252]', true)}${n('action_bar_textview_title', title, '[160,150][900,222]')}${n('next_button_textview', done, '[930,150][1060,222]', true)}</hierarchy>`);
    const at = captionPageDone(page('配文', '确定'));
    check('配文 page with 确定 → its 确定 is tapped (centre of next_button_textview)', at?.x === 995 && at?.y === 186, JSON.stringify(at));
    check('English Caption / OK page recognised too', !!captionPageDone(page('Caption', 'OK')));
    check('新帖子 page (title not 配文) / a 下一步 button → not the caption page', !captionPageDone(page('新帖子', '确定')) && !captionPageDone(page('配文', '下一步')));
  }

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
    await ph.cleanup();
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
