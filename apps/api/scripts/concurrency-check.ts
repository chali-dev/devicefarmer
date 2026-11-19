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
} finally {
  for (const fn of cleanup.reverse()) await fn().catch((e) => console.log('cleanup:', (e as Error).message));
  await db.delete(schema.settings).where(inArray(schema.settings.key, SETTING_KEYS));
  if (savedSettings.length) await db.insert(schema.settings).values(savedSettings);
  const failed = results.filter(([, ok]) => !ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  await sqlClient.end();
  process.exit(failed.length ? 1 : 0);
}
