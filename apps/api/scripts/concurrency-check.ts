/**
 * 防并发 (owner: 「防并发」): races in write paths, reproduced by firing the same / overlapping requests in parallel
 * (Promise.all, 10–50 at once) against a real test API + its DB + Redis (no mocks). Each section asserts the invariant
 * that must hold whatever the interleaving (no lost update, no duplicate row / task, one winner + coded refusals).
 *
 *   E2E_API=http://127.0.0.1:<port> API_PORT=<port> ENABLED_PLATFORMS=all npx tsx --env-file=../../.env scripts/concurrency-check.ts [section…]
 *
 * The API must run with ENABLED_PLATFORMS=all against the same DATABASE_URL / REDIS_URL. Placeholder devices (status
 * stopped, no containers, adb ports 5561–5569) only; nothing touches a phone. Settings rows it changes are restored.
 */
import { randomBytes } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db, schema, sqlClient } from '../src/db/index.js';
import { deviceHalts, haltDevice, resumeDevice } from '../src/modules/tracked/collector.js';
import { withCaptcha } from './lib/login.js';

const API = process.env.E2E_API ?? `http://127.0.0.1:${process.env.API_PORT ?? 3000}`;
if (/:3000\b/.test(API)) throw new Error('refusing to run against the main API (port 3000): set E2E_API and API_PORT to the test API');
if (/\/cloudphone(\?|$)/.test(process.env.DATABASE_URL ?? '')) throw new Error('refusing to run against the main database: set DATABASE_URL to a test DB');
const only = new Set(process.argv.slice(2));
const want = (s: string) => !only.size || only.has(s);

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
  const j = await r.json();
  if (!j.token) throw new Error(`login ${username}: ${JSON.stringify(j)}`);
  return j.token;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const statuses = (rs: { status: number }[]) => rs.map((r) => r.status).sort().join(',');
const count = (rs: { status: number }[], s: number) => rs.filter((r) => r.status === s).length;
const codes = (rs: { status: number; body: any }[]) => [...new Set(rs.filter((r) => r.status >= 400).map((r) => r.body?.code ?? r.status))].join(',');

const admin = await login(process.env.ADMIN_USERNAME!, process.env.ADMIN_PASSWORD!);
const [adminRow] = await db.select().from(schema.users).where(eq(schema.users.username, process.env.ADMIN_USERNAME!));
const tag = randomBytes(3).toString('hex');
const pw = randomBytes(12).toString('base64url');
const SETTING_KEYS = ['system', 'risk.device', 'alerts.rules', 'comments.rules', 'social.limits', 'publish.device', 'ai', 'risk.halts', 'tasks.retention'];
const savedSettings = await db.select().from(schema.settings).where(inArray(schema.settings.key, SETTING_KEYS));
const cleanup: (() => Promise<unknown>)[] = [];

/**
 * Lost-update check: `rounds` times, every body of `bodies(round)` is PUT at once (each changes another field);
 * afterwards every field must hold its round's value.
 */
async function noLostUpdate(name: string, method: string, path: string, rounds: number, bodies: (r: number) => unknown[], verify: (r: number) => Promise<string | null>) {
  let bad: string | null = null;
  let failed = '';
  for (let r = 0; r < rounds && !bad; r++) {
    const rs = await Promise.all(bodies(r).map((b) => http(method, path, admin, b)));
    if (rs.some((x) => x.status !== 200)) { failed = `round ${r}: ${statuses(rs)} ${rs.find((x) => x.status !== 200)?.text}`; break; }
    bad = await verify(r);
  }
  check(`${name}: parallel saves of different fields all survive (${rounds} rounds)`, !bad && !failed, bad ?? failed);
}

/** Placeholder device rows (stopped, no container) on free adb ports 5561–5570; `drop` deletes them again. */
async function placeholderDevices(n: number, name: string) {
  const taken = new Set((await db.select({ p: schema.instances.adbPort }).from(schema.instances)).map((r) => r.p));
  const ports = Array.from({ length: 10 }, (_, i) => 5561 + i).filter((p) => !taken.has(p)).slice(0, n);
  if (ports.length < n) throw new Error(`no free placeholder ports for ${n} devices`);
  const rows = await db.insert(schema.instances).values(ports.map((adbPort, i) => ({
    name: `ccfake-${tag}-${name}-${i + 1}`, image: 'none', adbPort, status: 'stopped' as const, spec: { width: 720, height: 1280, dpi: 320 },
  }))).returning();
  cleanup.push(() => db.delete(schema.instances).where(inArray(schema.instances.id, rows.map((r) => r.id))));
  return rows;
}
const dropDevices = (rows: { id: string }[]) => db.delete(schema.instances).where(inArray(schema.instances.id, rows.map((r) => r.id)));

async function waitFor<T>(label: string, fn: () => Promise<T | null | false | undefined>, ms = 60_000): Promise<T> {
  const t0 = Date.now();
  for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() - t0 > ms) throw new Error(`timeout: ${label}`); await sleep(400); }
}
async function uploadPng(token: string, extra: Record<string, string> = {}) {
  const sharp = (await import('sharp')).default;
  const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: Math.floor(Math.random() * 255), g: 90, b: 40 } } }).png().toBuffer();
  const fd = new FormData();
  fd.append('scope', 'mine');
  for (const [k, v] of Object.entries(extra)) fd.append(k, v);
  fd.append('file', new Blob([new Uint8Array(png)], { type: 'image/png' }), `cc-${tag}.png`);
  const r = await fetch(`${API}/api/media/upload`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: fd });
  const j = await r.json() as any;
  if (r.status !== 201) throw new Error(`upload ${r.status} ${JSON.stringify(j)}`);
  const id: string = j.item.id;
  await waitFor('media ready', async () => (await http('GET', `/api/media/${id}`, token)).body.item.status === 'ready', 60_000);
  return id;
}
/** A user (role user) + token; deleted at the end (cascades their rows). */
async function newUser(name: string) {
  const r = await http('POST', '/api/users', admin, { username: `cc${name}${tag}`, password: pw, role: 'user' });
  const id: string = r.body.user?.id ?? r.body.id;
  if (!id) throw new Error(`user create ${r.status} ${r.text}`);
  cleanup.push(() => db.delete(schema.users).where(eq(schema.users.id, id)));
  return { id, token: await login(`cc${name}${tag}`, pw) };
}
const future = (days: number) => new Date(Date.now() + days * 86400_000).toISOString();
const PT = schema.publishTasks;
const TK = schema.tasks;
const UNFINISHED = ['pending', 'scheduled', 'running', 'awaiting_operator'] as const;

try {
  // ================================================================ A. jsonb settings rows (read-modify-write)
  if (want('settings')) {
    const sysFields = ['logRetentionDays', 'historyRetentionDays', 'auditRetentionDays', 'riskEventsRetentionDays'] as const;
    await noLostUpdate('system settings (系统配置 → 日志, per-row 保存)', 'PUT', '/api/system/settings', 8,
      (r) => [...sysFields.map((f, i) => ({ [f]: 10 + r + i })), { backup: { enabled: false, hour: (r + 1) % 24, keep: 3 + r } }],
      async (r) => {
        const s = (await http('GET', '/api/system/settings', admin)).body.settings;
        const miss = sysFields.filter((f, i) => s[f] !== 10 + r + i);
        if (s.backup.hour !== (r + 1) % 24 || s.backup.keep !== 3 + r) miss.push('backup' as any);
        return miss.length ? `round ${r}: lost ${miss.join(', ')}` : null;
      });

    const riskVals = (r: number) => ({
      minIntervalSec: 20 + r, maxPerHour: 40 + r, busyRetrySec: 100 + r, accountCheckHours: 2 + r, feedCollectHours: 3 + r,
      feedPosts: 1 + (r % 9), feedCommentsPerPost: 10 + r, followingSyncHours: 4 + r, accountDiscovery: r % 2 === 0,
    });
    await noLostUpdate('风控 risk.device (采集限制 / 检测限制 sections save at once)', 'PUT', '/api/risk/settings', 8,
      (r) => Object.entries(riskVals(r)).map(([k, v]) => ({ [k]: v })),
      async (r) => {
        const d = (await http('GET', '/api/risk/settings', admin)).body.device;
        const miss = Object.entries(riskVals(r)).filter(([k, v]) => d[k] !== v).map(([k]) => k);
        return miss.length ? `round ${r}: lost ${miss.join(', ')}` : null;
      });

    await noLostUpdate('告警 alerts.rules', 'PUT', '/api/settings/alerts', 8,
      (r) => [{ cooldownMinutes: 5 + r }, { notifyAdmins: r % 2 === 0 }, { recovered: r % 2 === 1 }, { retentionDays: 20 + r },
        { kinds: { 'device.down': { inApp: r % 2 === 0 } } }, { kinds: { 'publish.failed': { inApp: r % 2 === 1 } } }],
      async (r) => {
        const x = (await http('GET', '/api/settings/alerts', admin)).body.rules;
        const miss: string[] = [];
        if (x.cooldownMinutes !== 5 + r) miss.push('cooldownMinutes');
        if (x.notifyAdmins !== (r % 2 === 0)) miss.push('notifyAdmins');
        if (x.recovered !== (r % 2 === 1)) miss.push('recovered');
        if (x.retentionDays !== 20 + r) miss.push('retentionDays');
        if (x.kinds['device.down'].inApp !== (r % 2 === 0)) miss.push('kinds.device.down');
        if (x.kinds['publish.failed'].inApp !== (r % 2 === 1)) miss.push('kinds.publish.failed');
        return miss.length ? `round ${r}: lost ${miss.join(', ')}` : null;
      });

    // the 日志 form also writes notificationRetentionDays into alerts.rules: both pages saving at once
    await noLostUpdate('alerts.rules via 系统配置 → 日志 (通知保留) + 告警通道 at once', 'PUT', '/api/system/settings', 6,
      (r) => [{ notificationRetentionDays: 40 + r }],
      async (r) => {
        const [a] = await Promise.all([http('PUT', '/api/settings/alerts', admin, { cooldownMinutes: 50 + r }), http('PUT', '/api/system/settings', admin, { notificationRetentionDays: 60 + r })]);
        if (a.status !== 200) return a.text;
        const x = (await http('GET', '/api/settings/alerts', admin)).body.rules;
        return x.cooldownMinutes === 50 + r && x.retentionDays === 60 + r ? null : `round ${r}: cooldown ${x.cooldownMinutes} retention ${x.retentionDays}`;
      });

    const cr = (r: number) => ({ duplicateMax: 2 + r, duplicateWindowHours: 10 + r, sendsPerHour: 30 + r, sendsPerDay: 60 + r, minGapSec: 5 + r });
    await noLostUpdate('回复限制 comments.rules', 'PUT', '/api/comments/settings', 8,
      (r) => Object.entries(cr(r)).map(([k, v]) => ({ [k]: v })),
      async (r) => {
        const x = (await http('GET', '/api/comments/settings', admin)).body.rules;
        const miss = Object.entries(cr(r)).filter(([k, v]) => x[k] !== v).map(([k]) => k);
        return miss.length ? `round ${r}: lost ${miss.join(', ')}` : null;
      });

    await noLostUpdate('账号上限 social.limits', 'PUT', '/api/social/settings', 8,
      (r) => [{ limits: { instagram: 2 + r } }, { limits: { tiktok: 3 + r } }, { limits: { youtube: 4 + r } }],
      async (r) => {
        const x = (await http('GET', '/api/social/settings', admin)).body.limits;
        return x.instagram === 2 + r && x.tiktok === 3 + r && x.youtube === 4 + r ? null : `round ${r}: ${JSON.stringify(x)}`;
      });

    await noLostUpdate('媒体号发文限制 publish.device', 'PUT', '/api/publish/device-settings', 8,
      (r) => [{ postsPerDay: 2 + r }, { minGapMin: 10 + r }],
      async (r) => {
        const x = (await http('GET', '/api/publish/device-settings', admin)).body.rules;
        return x.postsPerDay === 2 + r && x.minGapMin === 10 + r ? null : `round ${r}: ${JSON.stringify(x)}`;
      });

    const models = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'];
    await noLostUpdate('AI settings (model + workspace ID)', 'PUT', '/api/settings/ai', 6,
      (r) => [{ model: models[r % 3] }, { workspaceId: `wrkspc_cc${tag}${r}` }],
      async (r) => {
        const x = (await http('GET', '/api/settings/ai', admin)).body.ai;
        return x.model === models[r % 3] && x.workspaceId === `wrkspc_cc${tag}${r}` ? null : `round ${r}: ${JSON.stringify(x)}`;
      });

    // risk.halts: one entry per device, written by the workers (haltDevice) and 恢复 (resumeDevice) of any process
    const devs = await placeholderDevices(8, 'halt');
    await Promise.all(devs.map((d) => haltDevice(d, { code: 'tracked.collector_challenge', source: 'collector', platform: 'instagram' })));
    let halts = await deviceHalts();
    check('risk.halts: 8 devices halted at once → all 8 halted', devs.every((d) => halts[d.id]), `${devs.filter((d) => halts[d.id]).length}/8`);
    const resumed = await Promise.all([...devs.slice(0, 4), devs[0]!, devs[0]!].map((d) => resumeDevice(d.id)));
    halts = await deviceHalts();
    check('risk.halts: 4 resumed at once (one of them 3×) → exactly those cleared, the rest still halted, one resume reports it',
      devs.slice(0, 4).every((d) => !halts[d.id]) && devs.slice(4).every((d) => halts[d.id]) && resumed.filter(Boolean).length === 4,
      `${JSON.stringify(Object.keys(halts).filter((k) => devs.some((d) => d.id === k)).length)} left, true × ${resumed.filter(Boolean).length}`);
    await Promise.all(devs.slice(4).map((d) => resumeDevice(d.id)));
    await dropDevices(devs);
  }

  // ================================================================ B. content distribute / 排程发布
  if (want('publish')) {
    const A = await newUser('pa');
    const acc = (await http('POST', '/api/social/accounts', A.token, { platform: 'instagram', handle: `cc_${tag}_ig1` })).body.account.id as string;
    const acc2 = (await http('POST', '/api/social/accounts', A.token, { platform: 'instagram', handle: `cc_${tag}_ig2` })).body.account.id as string;
    const img = await uploadPng(A.token);
    const newContent = async (stage: 'draft' | 'ready' = 'ready', targetIds: string[] = []) => {
      const r = await http('POST', '/api/contents', A.token, { title: `cc-${tag}`, body: 'concurrency', mediaIds: [img], stage, targetIds });
      if (r.status !== 201) throw new Error(`content ${r.status} ${r.text}`);
      return r.body.content.id as string;
    };
    const liveTasks = (rowId: string) => db.select().from(TK).where(and(eq(TK.refType, 'publish'), eq(TK.refId, rowId), inArray(TK.status, ['pending', 'scheduled', 'running'])));

    // B1: 立即发布 / 排程发布 double click ×20: one publish task per content + account, one task-centre task
    const c1 = await newContent();
    const rs = await Promise.all(Array.from({ length: 20 }, () => http('POST', `/api/contents/${c1}/distribute`, A.token, { targets: [{ accountId: acc, scheduledAt: future(3) }] })));
    const rows = await db.select().from(PT).where(eq(PT.contentId, c1));
    const tks = rows.length ? await db.select().from(TK).where(and(eq(TK.refType, 'publish'), inArray(TK.refId, rows.map((x) => x.id)))) : [];
    check('distribute ×20 at once → exactly 1 publish task + 1 task-centre task, 1×201 and 19×200 (existing)',
      rows.length === 1 && tks.length === 1 && count(rs, 201) === 1 && count(rs, 200) === 19, `rows ${rows.length}, tasks ${tks.length}, ${statuses(rs)} ${codes(rs)}`);
    const row = rows[0]!;

    // B2: 改期 ×10 at once: attempt numbers serialised, exactly one live task-centre task and it is the row's
    const rr = await Promise.all(Array.from({ length: 10 }, (_, i) => http('POST', `/api/publish/tasks/${row.id}/reschedule`, A.token, { scheduledAt: future(4 + i / 10) })));
    await sleep(500);
    const [after] = await db.select().from(PT).where(eq(PT.id, row.id));
    const live = await liveTasks(row.id);
    check('reschedule ×10 at once → all 200, attempt_no + 10, exactly one live task and the row points at it',
      count(rr, 200) === 10 && after!.attemptNo === row.attemptNo + 10 && live.length === 1 && live[0]!.id === after!.taskId,
      `${statuses(rr)} ${codes(rr)} attempt ${after!.attemptNo}, live ${live.map((t) => (t.id === after!.taskId ? 'row' : 'orphan')).join(',')}`);

    // B3: 取消 ×10 at once: cancelled once, no live task left
    const cr = await Promise.all(Array.from({ length: 10 }, () => http('POST', `/api/publish/tasks/${row.id}/cancel`, A.token)));
    const [cancelled] = await db.select().from(PT).where(eq(PT.id, row.id));
    const live2 = await liveTasks(row.id);
    const cancelLogs = (await db.select().from(schema.publishLogs).where(eq(schema.publishLogs.publishTaskId, row.id))).filter((l) => l.message.startsWith('cancelled'));
    check('cancel ×10 at once → cancelled, no live task, logged once, one 200 and the rest coded 409s',
      cancelled!.status === 'cancelled' && !live2.length && cancelLogs.length === 1 && count(cr, 200) >= 1
        && cr.every((x) => x.status === 200 || (x.status === 409 && ['publish.bad_status', 'tasks.already_finished'].includes(x.body.code))),
      `${cancelled!.status}, live ${live2.length}, logs ${cancelLogs.length}, ${statuses(cr)} ${codes(cr)}`);

    // B4: 编辑后重新发布 of the cancelled pair ×10 at once → one new task
    const rp = await Promise.all(Array.from({ length: 10 }, () => http('POST', `/api/contents/${c1}/distribute`, A.token, { targets: [{ accountId: acc, scheduledAt: future(3) }] })));
    const unfinished = await db.select().from(PT).where(and(eq(PT.contentId, c1), inArray(PT.status, [...UNFINISHED])));
    check('re-distribute ×10 after cancel → exactly 1 new unfinished task', unfinished.length === 1 && count(rp, 201) === 1, `${unfinished.length} ${statuses(rp)}`);

    // B5: 批量发布 ×10 at once over 3 contents with 2 targets each → one task per content + account
    const bc = [await newContent('ready', [acc, acc2]), await newContent('ready', [acc, acc2]), await newContent('ready', [acc, acc2])];
    const br = await Promise.all(Array.from({ length: 10 }, () => http('POST', '/api/contents/batch', A.token, { ids: bc, action: 'publish', scheduledAt: future(5) })));
    const bRows = await db.select().from(PT).where(inArray(PT.contentId, bc));
    check('batch publish ×10 at once → 6 publish tasks (one per content + account), no 5xx',
      bRows.length === 6 && new Set(bRows.map((x) => `${x.contentId}:${x.accountId}`)).size === 6 && br.every((x) => x.status < 500), `${bRows.length} rows, ${statuses(br)}`);

    // B6: 归档 racing 发布: never an archived content with an unfinished publish task
    const archivedWithOpen = async (id: string) => {
      const [ct] = await db.select().from(schema.contents).where(eq(schema.contents.id, id));
      const open = await db.select().from(PT).where(and(eq(PT.contentId, id), inArray(PT.status, [...UNFINISHED])));
      return ct?.stage === 'archived' && open.length > 0;
    };
    let bad = 0;
    let badB = 0;
    const dr: { status: number; text: string }[] = [];
    for (let i = 0; i < 10; i++) {
      const id = await newContent();
      const id2 = await newContent();
      const id3 = await newContent();
      const dist = (x: string) => http('POST', `/api/contents/${x}/distribute`, A.token, { targets: [{ accountId: acc2, scheduledAt: future(3) }] });
      const out = await Promise.all([
        http('PUT', `/api/contents/${id}`, A.token, { stage: 'archived' }), dist(id),
        http('POST', '/api/contents/batch', A.token, { ids: [id2], action: 'archive' }), dist(id2),
        http('DELETE', `/api/contents/${id3}`, A.token), dist(id3),
      ]);
      dr.push(...out);
      if (await archivedWithOpen(id)) bad++;
      if (await archivedWithOpen(id2)) badB++;
    }
    check('archive racing distribute ×10 → never archived with an unfinished publish task', bad === 0, `${bad} archived with open tasks`);
    check('batch archive racing distribute ×10 → never archived with an unfinished publish task', badB === 0, `${badB} archived with open tasks`);
    check('archive / delete racing distribute → no 5xx', dr.every((x) => x.status < 500), dr.filter((x) => x.status >= 500).map((x) => x.text.slice(0, 120)).join(' | '));

    // B7: 素材 delete racing distribute: an unfinished publish task never references a deleted asset
    const imgs = await Promise.all(Array.from({ length: 8 }, () => uploadPng(A.token)));
    let gone = 0;
    const mr: { status: number; text: string }[] = [];
    for (const m of imgs) {
      const cr2 = await http('POST', '/api/contents', A.token, { title: `cc-${tag} m`, body: 'x', mediaIds: [m, img] });
      const id = cr2.body.content.id as string;
      mr.push(...await Promise.all([
        http('DELETE', `/api/media/${m}`, A.token),
        http('POST', `/api/contents/${id}/distribute`, A.token, { targets: [{ accountId: acc2, scheduledAt: future(3) }] }),
      ]));
      const open = await db.select().from(PT).where(and(eq(PT.contentId, id), inArray(PT.status, [...UNFINISHED])));
      const [asset] = await db.select().from(schema.mediaAssets).where(eq(schema.mediaAssets.id, m));
      if (open.some((p) => p.mediaIds.includes(m)) && (!asset || asset.deletedAt)) gone++;
    }
    check('media delete racing distribute ×8 → no unfinished publish task with a deleted asset, no 5xx', gone === 0 && mr.every((x) => x.status < 500),
      `${gone} tasks with a deleted asset; ${mr.filter((x) => x.status >= 500).map((x) => x.text.slice(0, 100)).join(' | ')}`);
  }
} finally {
  for (const fn of cleanup.reverse()) await fn().catch((e) => console.log('cleanup:', (e as Error).message));
  await db.delete(schema.settings).where(inArray(schema.settings.key, SETTING_KEYS));
  if (savedSettings.length) await db.insert(schema.settings).values(savedSettings);
  const failed = results.filter(([, ok]) => !ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  await sqlClient.end();
  process.exit(failed.length ? 1 : 0);
}
