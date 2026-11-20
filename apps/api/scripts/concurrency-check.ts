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
import { and, eq, gte, inArray, sql } from 'drizzle-orm';
import { db, schema, sqlClient } from '../src/db/index.js';
import { deviceHalts, haltDevice, resumeDevice } from '../src/modules/tracked/collector.js';
import { withCaptcha } from './lib/login.js';
import { linkAccount } from './lib/social-link.js';
import { placeholders } from './lib/placeholder.js';

const ph = placeholders('ccfake');

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
cleanup.push(() => ph.cleanup()); // first in, so it runs last (after every row of the inert source is gone)

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
  const rows = await ph.insert(ports.map((adbPort, i) => ({
    name: `ccfake-${tag}-${name}-${i + 1}`, adbPort, status: 'stopped' as const,
  })));
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

    // No per-account text edit any more (owner 2026-11-19): the task's text is the content's at distribution. A
    // distribution while an edit of the content is saving waits for it and snapshots the EDITED text (the texts are
    // read under the content row lock, not before it). The edit is held open in a transaction of this script.
    {
      const cE = await newContent('ready');
      const edited = `edited while distributing ${tag}`;
      let pending: Promise<Awaited<ReturnType<typeof http>>> | null = null;
      let waited = false;
      await db.transaction(async (tx) => {
        await tx.select({ id: schema.contents.id }).from(schema.contents).where(eq(schema.contents.id, cE)).for('update');
        await tx.update(schema.contents).set({ body: edited, updatedAt: new Date() }).where(eq(schema.contents.id, cE));
        pending = http('POST', `/api/contents/${cE}/distribute`, A.token, { targets: [{ accountId: acc, scheduledAt: future(4) }] });
        const quick = await Promise.race([pending.then(() => 'answered'), sleep(1500).then(() => 'waiting')]);
        waited = quick === 'waiting';
      });
      const dr = await pending!;
      const [snap] = await db.select().from(PT).where(eq(PT.contentId, cE));
      check('distribute during a content edit: waits for it, the task snapshots the edited text (no stale text, nothing to fix per account later)',
        waited && dr.status === 201 && snap?.caption === edited, `waited ${waited}, ${dr.status} ${dr.text.slice(0, 120)}, caption ${JSON.stringify(snap?.caption)}`);
      if (snap) await http('POST', `/api/publish/tasks/${snap.id}/cancel`, A.token);
    }

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

  // ================================================================ C. "one queued / running task per …" requests
  // Double click / two tabs on 同步, 立即检测, 追踪中 同步, 立即采集, 刷新, 导入: the route refuses with `…in_progress` while
  // one is unfinished. The tasks may finish fast here (placeholder phone → offline), so the invariant is: the created
  // tasks never overlap in time (each one starts after the previous one ended), judged by the DB clock of task_logs.
  if (want('tasks')) {
    const U = await newUser('ta');
    const [dev] = await placeholderDevices(1, 'tasks');
    await http('PUT', `/api/instances/${dev!.id}/grants`, admin, { userIds: [U.id] });
    const acc = (await http('POST', '/api/social/accounts', U.token, { platform: 'instagram', handle: `cc_${tag}_tk` })).body.account.id as string;
    await linkAccount(acc, dev!.id);
    const tracked = (await http('POST', '/api/tracked-accounts', U.token, { input: `https://www.tiktok.com/@cc_${tag}_tt` })).body;
    const trackedId = (tracked.account ?? tracked.item ?? tracked).id as string;

    const dbNow = async () => new Date((await sqlClient`select now() as now`)[0]!.now as Date);
    // created_at comes from Postgres, finished_at from the API host: measure the offset once (Docker Desktop VM drift)
    const drift = (await dbNow()).getTime() - Date.now();
    /**
     * Tasks of `type` on `refId` created since `since`; ok when each one was created after the previous one finished
     * (a duplicate created by the race shares the first one's lifetime).
     */
    const nonOverlapping = async (type: string, refId: string, since: Date) => {
      const ts = await db.select().from(TK).where(and(eq(TK.type, type), eq(TK.refId, refId), gte(TK.createdAt, since)));
      const span = ts.map((t) => ({ start: t.createdAt.getTime(), end: t.finishedAt ? t.finishedAt.getTime() + drift - 20 : Infinity })).sort((a, b) => a.start - b.start);
      const ok = span.every((s, i) => i === 0 || s.start >= span[i - 1]!.end);
      return { n: ts.length, ok };
    };
    const burst = async (name: string, n: number, type: string, refId: string, req: () => Promise<{ status: number; body: any }>, okStatus = 202) => {
      const since = await dbNow();
      const rs = await Promise.all(Array.from({ length: n }, req));
      await sleep(300);
      const o = await nonOverlapping(type, refId, since);
      check(`${name} ×${n} at once → tasks never overlap (${o.n} created), ${okStatus} or coded 409`, o.ok && o.n >= 1 && o.n === count(rs, okStatus)
        && rs.every((x) => x.status === okStatus || x.status === 409), `${o.n} tasks, overlap ${!o.ok}, ${statuses(rs)} ${codes(rs)}`);
    };
    await burst('立即检测 account check', 12, 'account-device-check', acc, () => http('POST', `/api/social/accounts/${acc}/check`, U.token));
    await burst('追踪中 同步 following sync', 12, 'account-following', acc, () => http('POST', `/api/social/accounts/${acc}/following/sync`, U.token));
    await burst('立即采集 feed collect', 12, 'feed-collect', acc, () => http('POST', `/api/social/accounts/${acc}/collect`, U.token));
    await burst('同步 (row button)', 12, 'account-device-sync', dev!.id, () => http('POST', `/api/social/accounts/${acc}/sync`, U.token));
    await burst('从云手机同步 (dialog)', 12, 'account-device-sync', dev!.id, () => http('POST', '/api/social/sync-from-device', U.token, { instanceId: dev!.id }));
    await burst('追踪号 刷新', 12, 'tracked-refresh', trackedId, () => http('POST', `/api/tracked-accounts/${trackedId}/refresh`, U.token));
    await burst('追踪号 同步', 12, 'tracked-refresh', trackedId, () => http('POST', `/api/tracked-accounts/${trackedId}/sync`, U.token));
    {
      const since = await dbNow();
      const rs = await Promise.all(Array.from({ length: 8 }, () => http('POST', '/api/tracked-accounts/refresh', U.token, { ids: [trackedId] })));
      await sleep(300);
      const o = await nonOverlapping('tracked-refresh', trackedId, since);
      const queued = rs.reduce((n, x) => n + (x.body?.queued?.length ?? 0), 0);
      check(`追踪号 批量刷新 ×8 at once → tasks never overlap (${o.n} created)`, o.ok && o.n === queued && rs.every((x) => x.status === 202), `${o.n} tasks, queued ${queued}, overlap ${!o.ok}`);
    }

    // 导入 (restore) ×6 at once on a backup row whose file does not exist: one restore at a time (each runs a safety
    // backup first, then fails on the missing file; nothing is restored)
    const [fake] = await db.insert(schema.dbBackups).values({ status: 'ok', trigger: 'manual', storage: 'local', key: `backups/cc-missing-${tag}.dump` }).returning();
    const since = await dbNow();
    const rs = await Promise.all(Array.from({ length: 6 }, () => http('POST', `/api/system/backups/${fake!.id}/restore`, admin)));
    const restores = await db.select().from(TK).where(and(eq(TK.type, 'db-restore'), gte(TK.createdAt, since)));
    check('导入 ×6 at once → exactly one restore task, the rest 409 system.restore_running', restores.length === 1 && count(rs, 202) === 1
      && rs.every((x) => x.status === 202 || (x.status === 409 && x.body.code === 'system.restore_running')), `${restores.length} tasks, ${statuses(rs)} ${codes(rs)}`);
    await waitFor('restores finished', async () => (await db.select().from(TK).where(and(eq(TK.type, 'db-restore'), inArray(TK.status, ['pending', 'scheduled', 'running'])))).length === 0, 300_000).catch(() => undefined);
    // 立即备份 ×6 at once → while a manual backup is unfinished, the others get that same task (backups never overlap)
    const bs = await dbNow();
    const br = await Promise.all(Array.from({ length: 6 }, () => http('POST', '/api/system/backups', admin)));
    const backups = await db.select().from(TK).where(and(eq(TK.type, 'db-backup'), gte(TK.createdAt, bs)));
    const bSpan = backups.map((t) => ({ start: t.createdAt.getTime(), end: t.finishedAt ? t.finishedAt.getTime() + drift - 20 : Infinity })).sort((a, b) => a.start - b.start);
    check('立即备份 ×6 at once → backups never overlap, every answer 202 with one of them', bSpan.every((x, i) => i === 0 || x.start >= bSpan[i - 1]!.end)
      && br.every((x) => x.status === 202 && backups.some((b) => b.id === x.body.task?.id)), `${backups.length} tasks ${statuses(br)}`);
    await waitFor('backup finished', async () => (await db.select().from(TK).where(and(eq(TK.type, 'db-backup'), inArray(TK.status, ['pending', 'scheduled', 'running'])))).length === 0, 300_000).catch(() => undefined);
    cleanup.push(async () => {
      const made = await db.select().from(schema.dbBackups).where(and(gte(schema.dbBackups.createdAt, since), inArray(schema.dbBackups.trigger, ['pre-restore', 'manual'])));
      for (const b of made) await http('DELETE', `/api/system/backups/${b.id}`, admin);
      await db.delete(schema.dbBackups).where(eq(schema.dbBackups.id, fake!.id));
    });
  }

  // ================================================================ D. unique names: one 201, the rest coded 409 (never 5xx)
  if (want('unique')) {
    const U = await newUser('un');
    const one = async (name: string, n: number, req: () => Promise<{ status: number; body: any; text: string }>, code: string, rows: () => Promise<number>) => {
      const rs = await Promise.all(Array.from({ length: n }, req));
      const left = await rows();
      check(`${name} ×${n} at once → one 201, ${n - 1}× 409 ${code}, one row`, count(rs, 201) === 1 && left === 1
        && rs.every((x) => x.status === 201 || (x.status === 409 && x.body?.code === code)), `${statuses(rs)} ${codes(rs)} rows ${left} ${rs.find((x) => x.status >= 500)?.text ?? ''}`);
    };
    const n = async (q: Promise<unknown[]>) => (await q).length;
    const uname = `ccdup${tag}`;
    await one('用户 create (same username)', 15, () => http('POST', '/api/users', admin, { username: uname, password: pw, role: 'user' }), 'users.username_taken',
      () => n(db.select().from(schema.users).where(eq(schema.users.username, uname))));
    cleanup.push(() => db.delete(schema.users).where(eq(schema.users.username, uname)));
    const rname = `cc角色${tag}`;
    await one('自定义角色 create (same name)', 15, () => http('POST', '/api/roles', admin, { name: rname, menus: ['content'] }), 'role.name_taken',
      () => n(db.select().from(schema.roles).where(eq(schema.roles.name, rname))));
    cleanup.push(() => db.delete(schema.roles).where(eq(schema.roles.name, rname)));
    const pname = `cc人设${tag}`;
    await one('人设 create with 范例 (same name)', 15, () => http('POST', '/api/personas', U.token, { scope: 'mine', name: pname, examples: ['示例一', '评论一'] }), 'persona.exists',
      () => n(db.select().from(schema.personas).where(eq(schema.personas.name, pname))));
    const [persona] = await db.select().from(schema.personas).where(eq(schema.personas.name, pname));
    const tpl = await db.select().from(schema.commentTemplates).where(eq(schema.commentTemplates.personaId, persona!.id));
    check('人设 create race: the losers leave no 范例 behind (2 = the winner\'s)', tpl.length === 2, `${tpl.length} templates`);
    const copies = await Promise.all(Array.from({ length: 12 }, () => http('POST', `/api/personas/${persona!.id}/copy`, U.token, {})));
    const names = copies.map((x) => x.body?.persona?.name as string);
    check('复制到我的人设 ×12 at once → 12 personas with distinct 副本 names', copies.every((x) => x.status === 201) && new Set(names).size === 12,
      `${statuses(copies)} ${codes(copies)} ${names.join(' | ')}`);
    // 人设 delete racing 范例 create: no 5xx, no template left on a deleted persona
    const tr: { status: number; text: string }[] = [];
    for (let i = 0; i < 6; i++) {
      const p = (await http('POST', '/api/personas', U.token, { scope: 'mine', name: `cc删人设${tag}${i}` })).body.persona.id as string;
      tr.push(...await Promise.all([
        http('DELETE', `/api/personas/${p}`, U.token),
        ...Array.from({ length: 4 }, (_, k) => http('POST', '/api/comment-templates', U.token, { personaId: p, name: `t${k}`, text: `范例 ${k}` })),
      ]));
    }
    const orphans = await db.select().from(schema.commentTemplates).where(and(eq(schema.commentTemplates.userId, U.id), sql`${schema.commentTemplates.name} in ('t0','t1','t2','t3')`,
      sql`(${schema.commentTemplates.personaId} is null or not exists (select 1 from personas p where p.id = ${schema.commentTemplates.personaId}))`));
    check('人设 delete racing 范例 create ×6 → every delete 204, no 5xx, no template left without its persona', tr.every((x) => x.status < 500) && !orphans.length
      && tr.filter((_, i) => i % 5 === 0).every((x) => x.status === 204),
      `${orphans.length} orphans; ${statuses(tr)} ${tr.filter((x) => x.status >= 300).map((x) => x.text.slice(0, 100)).join(' | ')}`);
    const ccname = `cc分类${tag}`;
    await one('内容分类 create (same name, case variants)', 12, () => http('POST', '/api/content-categories', U.token, { scope: 'mine', name: Math.random() < 0.5 ? ccname : ccname.toUpperCase() }), 'content_category.exists',
      () => n(db.select().from(schema.contentCategories).where(sql`lower(${schema.contentCategories.name}) = lower(${ccname})`)));
    await one('素材分类 create (same name, case variants)', 12, () => http('POST', '/api/media/categories', U.token, { scope: 'mine', name: Math.random() < 0.5 ? ccname : ccname.toUpperCase() }), 'media_category.exists',
      () => n(db.select().from(schema.mediaCategories).where(sql`lower(${schema.mediaCategories.name}) = lower(${ccname})`)));
    const h = `cc_${tag}_dup`;
    await one('媒体号 create (same handle, case variants)', 12, () => http('POST', '/api/social/accounts', U.token, { platform: 'tiktok', handle: Math.random() < 0.5 ? h : h.toUpperCase() }), 'social.account_exists',
      () => n(db.select().from(schema.socialAccounts).where(sql`lower(${schema.socialAccounts.handle}) = ${h}`)));
    await one('追踪号 create (same profile)', 12, () => http('POST', '/api/tracked-accounts', U.token, { input: `https://www.tiktok.com/@${h}` }), 'tracked.duplicate',
      () => n(db.select().from(schema.trackedAccounts).where(and(eq(schema.trackedAccounts.userId, U.id), sql`lower(${schema.trackedAccounts.handle}) = ${h}`))));
    const chName = `cc通道${tag}`;
    await one('告警通道 create (same name)', 10, () => http('POST', '/api/alert-channels', admin, { name: chName, type: 'telegram', enabled: false, config: { botToken: '123456:ABCdefGHIjklMNOpqrSTUvwxYZ0123456789', chatId: '-100123' } }), 'alerts.channel_name_taken',
      () => n(db.select().from(schema.alertChannels).where(eq(schema.alertChannels.name, chName))));
    cleanup.push(() => db.delete(schema.alertChannels).where(eq(schema.alertChannels.name, chName)));

    // 自定义角色 delete racing 用户 assignment: never a dangling role, never 5xx
    const bad: string[] = [];
    for (let i = 0; i < 6; i++) {
      const role = (await http('POST', '/api/roles', admin, { name: `cc删${tag}${i}`, menus: ['media'] })).body.role.id as string;
      const rs = await Promise.all([
        http('DELETE', `/api/roles/${role}`, admin),
        http('PATCH', `/api/users/${U.id}`, admin, { roleId: role }),
        http('PATCH', `/api/users/${U.id}`, admin, { roleId: role }),
      ]);
      const [u] = await db.select().from(schema.users).where(eq(schema.users.id, U.id));
      const [r] = await db.select().from(schema.roles).where(eq(schema.roles.id, role));
      if (rs.some((x) => x.status >= 500)) bad.push(rs.map((x) => x.text.slice(0, 80)).join(' / '));
      if (u!.roleId === role && !r) bad.push('dangling role_id');
      await http('PATCH', `/api/users/${U.id}`, admin, { roleId: null });
      await db.delete(schema.roles).where(eq(schema.roles.id, role));
    }
    check('role delete racing user assignment ×6 → no dangling role, no 5xx', !bad.length, bad.join(' | '));
  }

  // ================================================================ E. replies: draft → 排程 → send task, never twice
  if (want('replies')) {
    const U = await newUser('re');
    const acc = (await http('POST', '/api/social/accounts', U.token, { platform: 'instagram', handle: `cc_${tag}_re` })).body.account.id as string;
    const comment = async () => (await http('POST', '/api/comments', U.token, { accountId: acc, text: `评论 ${randomBytes(3).toString('hex')}`, authorName: 'someone' })).body.comment.id as string;
    const R = schema.commentTasks;
    const c1 = await comment();
    const cr = await Promise.all(Array.from({ length: 12 }, (_, i) => http('POST', `/api/comments/${c1}/replies`, U.token, { text: `回复 ${i}` })));
    const drafts = await db.select().from(R).where(eq(R.commentId, c1));
    check('reply create ×12 at once on one comment → one draft, the rest 409 comment.already_replied', drafts.length === 1 && count(cr, 201) === 1
      && cr.every((x) => x.status === 201 || (x.status === 409 && x.body.code === 'comment.already_replied')), `${drafts.length} drafts ${statuses(cr)} ${codes(cr)}`);
    const id = drafts[0]!.id;
    const sr = await Promise.all(Array.from({ length: 12 }, () => http('POST', `/api/comment-replies/${id}/submit`, U.token, { scheduledAt: future(2) })));
    const sendTasks = await db.select().from(TK).where(and(eq(TK.type, 'comment-reply'), eq(TK.refId, id)));
    check('排程 ×12 at once → one send task, one 200, the rest 409 comment.bad_status', sendTasks.length === 1 && count(sr, 200) === 1
      && sr.every((x) => x.status === 200 || (x.status === 409 && x.body.code === 'comment.bad_status')), `${sendTasks.length} tasks ${statuses(sr)} ${codes(sr)}`);
    // delete racing 排程 on fresh drafts: either gone without a task, or scheduled with exactly one task
    let odd = 0;
    for (let i = 0; i < 8; i++) {
      const c = await comment();
      const d = (await http('POST', `/api/comments/${c}/replies`, U.token, { text: `回复 x${i}` })).body.reply.id as string;
      await Promise.all([
        http('DELETE', `/api/comment-replies/${d}`, U.token), http('POST', `/api/comment-replies/${d}/submit`, U.token, { scheduledAt: future(2) }),
        http('DELETE', `/api/comment-replies/${d}`, U.token), http('PATCH', `/api/comment-replies/${d}`, U.token, { text: `改 ${i}` }),
      ]);
      const [row] = await db.select().from(R).where(eq(R.id, d));
      const ts = await db.select().from(TK).where(and(eq(TK.type, 'comment-reply'), eq(TK.refId, d), inArray(TK.status, ['pending', 'scheduled', 'running'])));
      if (row ? !(row.status === 'scheduled' ? ts.length === 1 : row.status === 'draft' && ts.length === 0) : ts.length > 0) odd++;
    }
    check('draft delete / edit racing 排程 ×8 → deleted without a task or scheduled with exactly one', odd === 0, `${odd} inconsistent`);
    // cancel ×10 at once of the scheduled reply
    const xr = await Promise.all(Array.from({ length: 10 }, () => http('POST', `/api/comment-replies/${id}/cancel`, U.token)));
    const [cx] = await db.select().from(R).where(eq(R.id, id));
    const live = await db.select().from(TK).where(and(eq(TK.type, 'comment-reply'), eq(TK.refId, id), inArray(TK.status, ['pending', 'scheduled', 'running'])));
    check('reply cancel ×10 at once → cancelled, no live task, no 5xx', cx!.status === 'cancelled' && !live.length && xr.every((x) => x.status < 500), `${cx!.status} live ${live.length} ${statuses(xr)}`);
  }

  // ================================================================ F. misc: captcha single use, alert de-dup, task retry, grants
  if (want('misc')) {
    const { solveCaptcha } = await import('./lib/login.js');
    const cap = await solveCaptcha(API);
    if (cap) {
      const rs = await Promise.all(Array.from({ length: 20 }, () => http('POST', '/api/auth/login', null, { username: process.env.ADMIN_USERNAME, password: process.env.ADMIN_PASSWORD, captcha: cap })));
      check('login with one solved captcha ×20 at once → exactly one 200 (single use)', count(rs, 200) === 1 && rs.every((x) => x.status === 200 || x.status === 400), `${statuses(rs)} ${codes(rs)}`);
    }

    const [dev] = await placeholderDevices(1, 'misc');
    const { notify } = await import('../src/modules/notify/notify.js');
    await http('PUT', '/api/settings/alerts', admin, { kinds: { 'device.down': { inApp: true } }, notifyAdmins: true, cooldownMinutes: 60 });
    const before = await db.select().from(schema.notifications).where(eq(schema.notifications.userId, adminRow!.id));
    const sent = await Promise.all(Array.from({ length: 20 }, () => notify({ kind: 'device.down', refId: dev!.id, params: { device: dev!.name } } as any)));
    const after = await db.select().from(schema.notifications).where(eq(schema.notifications.userId, adminRow!.id));
    check('notify() of one alert ×20 at once → delivered once (one in-app row for the admin)', sent.filter(Boolean).length === 1 && after.length - before.length === 1,
      `${sent.filter(Boolean).length} delivered, ${after.length - before.length} rows`);
    cleanup.push(() => db.delete(schema.alertStates).where(eq(schema.alertStates.key, dev!.id)));

    // 任务中心 重试 ×10 of one failed task → one new task (the others get the same one)
    const { createTask } = await import('../src/modules/tasks/core.js');
    await import('../src/modules/tasks/test-handlers.js');
    const { task: t } = await createTask({ type: 'test.echo', userId: adminRow!.id, label: `cc-${tag}`, payload: { failTimes: 1, sleepMs: 2500 }, maxAttempts: 1 });
    await waitFor('test task failed', async () => (await db.select().from(TK).where(eq(TK.id, t.id)))[0]!.status === 'failed', 30_000);
    const rr = await Promise.all(Array.from({ length: 10 }, () => http('POST', `/api/tasks/${t.id}/retry`, admin)));
    const retries = await db.select().from(TK).where(eq(TK.retryOf, t.id));
    check('task retry ×10 at once → one new task, every answer 202 with it', retries.length === 1 && rr.every((x) => x.status === 202 && x.body.task?.id === retries[0]?.id),
      `${retries.length} retries ${statuses(rr)} ${codes(rr)}`);
    await waitFor('retries done', async () => (await db.select().from(TK).where(and(eq(TK.retryOf, t.id), inArray(TK.status, ['pending', 'scheduled', 'running'])))).length === 0, 30_000).catch(() => undefined);
    cleanup.push(() => db.delete(TK).where(inArray(TK.id, [t.id, ...retries.map((x) => x.id)])));

    // 取消 racing the task's own end: every task ends in exactly one final state, logged once
    const quick = await Promise.all(Array.from({ length: 12 }, (_, i) => createTask({ type: 'test.echo', userId: adminRow!.id, label: `cc-${tag}-q${i}`, payload: { sleepMs: 20 * i }, maxAttempts: 1 })));
    await Promise.all(quick.map(async ({ task: q }, i) => { await sleep(15 * i); await Promise.all([1, 2, 3].map(() => http('POST', `/api/tasks/${q.id}/cancel`, admin))); }));
    await waitFor('quick tasks final', async () => (await db.select().from(TK).where(and(inArray(TK.id, quick.map((q) => q.task.id)), inArray(TK.status, ['pending', 'scheduled', 'running'])))).length === 0, 30_000).catch(() => undefined);
    const qRows = await db.select().from(TK).where(inArray(TK.id, quick.map((q) => q.task.id)));
    const qLogs = await db.select().from(schema.taskLogs).where(inArray(schema.taskLogs.taskId, quick.map((q) => q.task.id)));
    const finals = (id: string) => qLogs.filter((l) => l.taskId === id && /^(succeeded|failed|cancelled)/.test(l.message)).length;
    const oddQ = qRows.filter((r) => !['success', 'cancelled', 'failed'].includes(r.status) || finals(r.id) > 1);
    check('cancel ×3 racing the end of 12 short tasks → each ends in one final state, logged once', !oddQ.length,
      oddQ.map((r) => `${r.status}/${finals(r.id)} logs`).join(', ') + ` ${qRows.map((r) => r.status).join(',')}`);
    cleanup.push(() => db.delete(TK).where(inArray(TK.id, quick.map((q) => q.task.id))));

    // two admins assigning one phone to different users at once: one user per phone
    const [u1, u2, u3] = [await newUser('g1'), await newUser('g2'), await newUser('g3')];
    let multi = 0;
    for (let i = 0; i < 6; i++) {
      await http('PUT', `/api/instances/${dev!.id}/grants`, admin, { userIds: [] });
      await Promise.all([
        http('PUT', `/api/instances/${dev!.id}/grants`, admin, { userIds: [u1.id] }),
        http('PUT', `/api/instances/${dev!.id}/grants`, admin, { userIds: [u2.id] }),
        http('PUT', `/api/users/${u3.id}/grants`, admin, { instanceIds: [dev!.id] }),
      ]);
      const g = await db.select().from(schema.instanceGrants).where(eq(schema.instanceGrants.instanceId, dev!.id));
      if (g.length !== 1) multi++;
    }
    check('assigning one phone to 3 users at once ×6 → always exactly one user', multi === 0, `${multi} rounds with ≠ 1 user`);

    // 分配 racing the current owner's 发布 / 回复草稿 on the phone's account: an unfinished publish task / reply always
    // belongs to the account's owner (the move is refused while one exists)
    await http('PUT', `/api/instances/${dev!.id}/grants`, admin, { userIds: [u1.id] });
    const acc = (await http('POST', '/api/social/accounts', u1.token, { platform: 'instagram', handle: `cc_${tag}_mv` })).body.account.id as string;
    await linkAccount(acc, dev!.id);
    const imgOf = new Map([[u1.id, await uploadPng(u1.token)], [u2.id, await uploadPng(u2.token)]]);
    let wrong = 0;
    const errs: string[] = [];
    for (let i = 0; i < 8; i++) {
      const [from, to] = i % 2 === 0 ? [u1, u2] : [u2, u1];
      const content = (await http('POST', '/api/contents', from.token, { title: `cc-${tag} mv`, body: 'x', mediaIds: [imgOf.get(from.id)!] })).body.content?.id as string | undefined;
      const cmt = (await http('POST', '/api/comments', from.token, { accountId: acc, text: `评论 mv${i}`, authorName: 'x' })).body.comment?.id as string | undefined;
      if (!content || !cmt) { errs.push(`setup round ${i}`); break; }
      const rs = await Promise.all([
        http('PUT', `/api/instances/${dev!.id}/grants`, admin, { userIds: [to.id] }),
        http('POST', `/api/contents/${content}/distribute`, from.token, { targets: [{ accountId: acc, scheduledAt: future(3) }] }),
        http('POST', `/api/comments/${cmt}/replies`, from.token, { text: `回复 mv${i}` }),
      ]);
      errs.push(...rs.filter((x) => x.status >= 500).map((x) => x.text.slice(0, 100)));
      const [a] = await db.select().from(schema.socialAccounts).where(eq(schema.socialAccounts.id, acc));
      const pubs = await db.select().from(PT).where(and(eq(PT.accountId, acc), inArray(PT.status, [...UNFINISHED])));
      const reps = await db.select().from(schema.commentTasks).where(and(eq(schema.commentTasks.accountId, acc), inArray(schema.commentTasks.status, ['draft', 'scheduled', 'sending', 'awaiting_operator'])));
      if ([...pubs, ...reps].some((x) => x.userId !== a!.userId)) wrong++;
      // clear the way for the next move (cancel the publish task, delete the draft), owner back to the grant's user
      for (const p of pubs) await http('POST', `/api/publish/tasks/${p.id}/cancel`, admin);
      for (const r of reps) await db.delete(schema.commentTasks).where(eq(schema.commentTasks.id, r.id));
      await http('PUT', `/api/instances/${dev!.id}/grants`, admin, { userIds: [to.id] });
    }
    check('分配 racing 发布 + 回复草稿 ×8 → unfinished work always belongs to the account\'s owner, no 5xx', wrong === 0 && !errs.length, `${wrong} wrong owner; ${errs.join(' | ')}`);
  }
} catch (err) {
  check('script ran to the end', false, (err as Error).stack ?? String(err));
} finally {
  for (const fn of cleanup.reverse()) await fn().catch((e) => console.log('cleanup:', (e as Error).message));
  await db.delete(schema.settings).where(inArray(schema.settings.key, SETTING_KEYS));
  if (savedSettings.length) await db.insert(schema.settings).values(savedSettings);
  const failed = results.filter(([, ok]) => !ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  await sqlClient.end();
  process.exit(failed.length ? 1 : 0);
}
