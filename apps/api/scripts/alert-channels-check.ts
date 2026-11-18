/**
 * Alert channels (告警通道) against the real API, DB, Redis, task centre and the REAL Telegram Bot API (no mocks):
 * - CRUD + admin only (user 403), validation (coded), unique names, old /api/settings/telegram endpoints gone.
 * - Bot token sealed in the DB, never returned, kept on edit (absent / empty), replaced when given; never in
 *   audit entries, task payloads, task logs or errors.
 * - Fan-out: one alert → one notify-telegram task per matching enabled channel (kinds filter, minSeverity,
 *   disabled channel skipped); the payload holds the channel id + alert only. Fake tokens make the REAL
 *   Telegram API answer 401 → each task fails at once (no retry on 4xx) with alerts.telegram_unauthorized →
 *   lastResult + one in-app channel.failed notice per channel to admins only, never sent to a channel again
 *   (no loop), de-duplicated by the cooldown; the alert itself keeps its cooldown (no second fan-out).
 * - Test endpoint vs the real API (fake token → 400 alerts.telegram_unauthorized). A real message is sent only
 *   with TELEGRAM_TEST_TOKEN + TELEGRAM_TEST_CHAT.
 * - Data migration: the old `alerts.telegram` settings key + per-kind telegram flags → exactly one channel
 *   (real `db:migrate` run as a child process), rerun creates none.
 * Creates one temporary user; removes everything afterwards (settings restored).
 * Usage (from apps/api, API running): E2E_API=http://127.0.0.1:3000 npx tsx --env-file=../../.env scripts/alert-channels-check.ts
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { and, eq, gte, inArray, like } from 'drizzle-orm';
import { db, schema, sqlClient } from '../src/db/index.js';
import { events } from '../src/lib/events.js';
import { openSecret, sealSecret } from '../src/lib/secret-box.js';
import { recover } from '../src/modules/notify/notify.js';
import { closeTaskQueues } from '../src/modules/tasks/core.js';
import { withCaptcha } from './lib/login.js';

const API = process.env.E2E_API ?? 'http://127.0.0.1:3000';
const results: [string, boolean][] = [];
const check = (name: string, ok: boolean, detail = '') => { results.push([name, ok]); console.log(`${ok ? '✓' : '✗'} ${name}${detail && !ok ? ` — ${detail}` : ''}`); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function http<T = any>(method: string, path: string, token: string, body?: unknown) {
  const res = await fetch(API + path, { method, headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
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
  for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() - t0 > ms) throw new Error(`timeout: ${label}`); await sleep(400); }
}
const fakeToken = () => `${100000000 + Math.floor(Math.random() * 1e8)}:AA${randomBytes(25).toString('base64url').slice(0, 33)}`;

const N = schema.notifications;
const CH = schema.alertChannels;
const T = await login(process.env.ADMIN_USERNAME!, process.env.ADMIN_PASSWORD!);
const [admin] = await db.select().from(schema.users).where(eq(schema.users.username, process.env.ADMIN_USERNAME!));
const uT = admin!.id;
const tag = randomBytes(3).toString('hex');
const nm = (s: string) => `ac-${tag}-${s}`;
const TOKENS = [fakeToken(), fakeToken(), fakeToken(), fakeToken()] as const;
const leaks = (s: string) => TOKENS.some((tk) => s.includes(tk) || s.includes(tk.split(':')[1]!));
const saved = Object.fromEntries(await Promise.all(['alerts.rules', 'alerts.telegram'].map(async (k) =>
  [k, (await db.select().from(schema.settings).where(eq(schema.settings.key, k)))[0]?.value ?? null] as const)));
const t0 = new Date((await sqlClient`select now() as now`)[0]!.now as Date);
const userIds: string[] = [];
const channelIds: string[] = [];
const refIds: string[] = [];
const tgTasks = (refId: string) => db.select().from(schema.tasks).where(and(eq(schema.tasks.type, 'notify-telegram'), eq(schema.tasks.refId, refId), gte(schema.tasks.createdAt, t0)));
const finished = (id: string) => waitFor(`task ${id}`, async () => {
  const [t] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, id));
  return t && ['success', 'failed', 'cancelled'].includes(t.status) ? t : null;
}, 90_000);
await events.start();
const tokenOf = async (id: string) => openSecret(String((await db.select().from(CH).where(eq(CH.id, id)))[0]!.config.botTokenEnc));

try {
  const pw = randomBytes(12).toString('base64url');
  let r = await http('POST', '/api/users', T, { username: `ac${tag}`, password: pw, role: 'user' });
  userIds.push(r.body.user?.id ?? r.body.id);
  const uA = userIds[0]!;
  const A = await login(`ac${tag}`, pw);
  // in-app on for every kind (so a stray task.failed for notify-telegram would show), 60 min cooldown
  r = await http('PUT', '/api/settings/alerts', T, { kinds: { 'account.problem': { inApp: true }, 'task.failed': { inApp: true }, 'channel.failed': { inApp: true } }, cooldownMinutes: 60, notifyAdmins: true, recovered: true });
  check('setup: rules saved (in-app per kind; channel.failed is a rule kind)', r.status === 200 && r.body.rules.kinds['channel.failed']?.inApp === true, r.text.slice(0, 300));
  r = await http('PUT', '/api/settings/alerts', T, { kinds: { 'device.down': { telegram: true } } });
  check('rules no longer take a per-kind telegram flag → 400', r.status === 400);

  // ---------------------------------------------------------------- RBAC + old endpoints
  const base = { name: nm('one'), type: 'telegram', kinds: ['account.problem'], config: { botToken: TOKENS[0], chatId: '-1001234567890', language: 'en' } };
  for (const [m, p, b] of [['GET', '/api/alert-channels'], ['POST', '/api/alert-channels', base], ['PATCH', `/api/alert-channels/${uT}`, { enabled: false }], ['DELETE', `/api/alert-channels/${uT}`], ['POST', `/api/alert-channels/${uT}/test`]] as const) {
    r = await http(m, p, A, b);
    check(`user: ${m} ${p.replace(uT, ':id')} → 403`, r.status === 403, String(r.status));
  }
  r = await http('GET', '/api/settings/telegram', T);
  const r2 = await http('POST', '/api/settings/telegram/test', T);
  check('old /api/settings/telegram[/test] endpoints removed (404)', r.status === 404 && r2.status === 404);

  // ---------------------------------------------------------------- create / validate
  r = await http('POST', '/api/alert-channels', T, { ...base, config: { chatId: '-100123' } });
  check('create without bot token → 400 alerts.channel_invalid_config', r.status === 400 && r.body.code === 'alerts.channel_invalid_config', r.text);
  r = await http('POST', '/api/alert-channels', T, { ...base, config: { ...base.config, chatId: 'not a chat' } });
  check('bad chat id → 400 alerts.channel_invalid_config', r.status === 400 && r.body.code === 'alerts.channel_invalid_config', r.text);
  r = await http('POST', '/api/alert-channels', T, { ...base, config: { ...base.config, botToken: 'nope' } });
  check('malformed bot token → 400', r.status === 400 && r.body.code === 'alerts.channel_invalid_config' && !r.text.includes('nope'), r.text);
  r = await http('POST', '/api/alert-channels', T, { ...base, type: 'carrier-pigeon' });
  check('unknown type → 400', r.status === 400);
  r = await http('POST', '/api/alert-channels', T, { ...base, kinds: ['channel.failed'] });
  check('kind not available to channels (channel.failed) → 400', r.status === 400);
  r = await http('POST', '/api/alert-channels', T, base);
  check('create channel → 201, botTokenSet, token never returned', r.status === 201 && r.body.channel.config.botTokenSet === true && r.body.channel.config.chatId === '-1001234567890' && !leaks(r.text) && !r.text.includes('botTokenEnc') && !r.text.includes('v1:'), r.text);
  const ch1: string = r.body.channel.id; channelIds.push(ch1);
  r = await http('POST', '/api/alert-channels', T, { ...base, config: { ...base.config, botToken: TOKENS[1] } });
  check('duplicate name → 409 alerts.channel_name_taken', r.status === 409 && r.body.code === 'alerts.channel_name_taken', r.text);
  const [row1] = await db.select().from(CH).where(eq(CH.id, ch1));
  check('DB: token sealed (botTokenEnc v1:…), plain token nowhere in the row', String(row1!.config.botTokenEnc).startsWith('v1:') && !('botToken' in row1!.config) && !leaks(JSON.stringify(row1)) && (await tokenOf(ch1)) === TOKENS[0]);

  // ---------------------------------------------------------------- edit keeps / replaces the token
  r = await http('PATCH', `/api/alert-channels/${ch1}`, T, { config: { chatId: '-1009876543210' } });
  check('edit without botToken keeps it (and other fields)', r.status === 200 && r.body.channel.config.chatId === '-1009876543210' && r.body.channel.config.language === 'en' && (await tokenOf(ch1)) === TOKENS[0], r.text);
  r = await http('PATCH', `/api/alert-channels/${ch1}`, T, { config: { botToken: '', threadId: 7 } });
  check('edit with an empty botToken keeps it; threadId stored', r.status === 200 && r.body.channel.config.threadId === 7 && (await tokenOf(ch1)) === TOKENS[0], r.text);
  r = await http('PATCH', `/api/alert-channels/${ch1}`, T, { config: { botToken: TOKENS[1], threadId: null } });
  check('edit with a new botToken replaces it (not returned)', r.status === 200 && (await tokenOf(ch1)) === TOKENS[1] && !leaks(r.text), r.text);
  r = await http('PATCH', `/api/alert-channels/${ch1}`, T, { config: { chatId: 'bad chat' } });
  check('edit with an invalid chat id → 400, stored config unchanged', r.status === 400 && (await db.select().from(CH).where(eq(CH.id, ch1)))[0]!.config.chatId === '-1009876543210');
  r = await http('PATCH', `/api/alert-channels/${ch1}`, T, { nope: 1 });
  check('unknown field → 400', r.status === 400);
  r = await http('PATCH', `/api/alert-channels/${uT}`, T, { enabled: false });
  check('unknown channel → 404 alerts.channel_not_found', r.status === 404 && r.body.code === 'alerts.channel_not_found');

  // ---------------------------------------------------------------- test endpoint vs the real Telegram API
  r = await http('POST', `/api/alert-channels/${ch1}/test`, T);
  check('test with a fake token → real Telegram 401 → 400 alerts.telegram_unauthorized (no token in the reply)', r.status === 400 && r.body.code === 'alerts.telegram_unauthorized' && !leaks(r.text), r.text);
  r = await http('GET', '/api/alert-channels', T);
  const listed = r.body.channels.find((c: any) => c.id === ch1);
  check('GET lists the channel with lastResult (test failed, code), kinds + types, no token', r.status === 200 && listed?.lastResult?.ok === false && listed.lastResult.test === true && listed.lastResult.code === 'alerts.telegram_unauthorized'
    && r.body.types.includes('telegram') && r.body.kinds.some((k: any) => k.kind === 'device.down') && !r.body.kinds.some((k: any) => k.kind === 'channel.failed') && !leaks(r.text) && !r.text.includes('v1:'), r.text.slice(0, 400));

  // ---------------------------------------------------------------- fan-out
  const mk = async (s: string, extra: Record<string, unknown>, token: string) => {
    const res = await http('POST', '/api/alert-channels', T, { name: nm(s), type: 'telegram', config: { botToken: token, chatId: '-1001112223334' }, ...extra });
    if (res.status !== 201) throw new Error(`create ${s}: ${res.text}`);
    channelIds.push(res.body.channel.id);
    return res.body.channel.id as string;
  };
  const ch2 = await mk('all', { kinds: [] }, TOKENS[2]);
  const ch3 = await mk('devonly', { kinds: ['device.down'] }, TOKENS[2]);
  const ch4 = await mk('disabled', { kinds: [], enabled: false }, TOKENS[3]);
  const ch5 = await mk('erronly', { kinds: [], minSeverity: 'error' }, TOKENS[3]);
  r = await http('POST', '/api/social/accounts', A, { platform: 'instagram', handle: `ac_${tag}_one` });
  check('setup: account of user A', r.status === 200 || r.status === 201, r.text);
  const acc: string = r.body.account.id; refIds.push(acc);
  r = await http('POST', `/api/social/accounts/${acc}/checked`, A, { loginStatus: 'logged_out' });
  check('account.problem raised (manual check)', r.status === 200, r.text);
  const tasks = await waitFor('fan-out tasks', async () => { const x = await tgTasks(acc); return x.length >= 2 ? x : null; }, 10_000);
  await sleep(1000);
  const all = await tgTasks(acc);
  const targets = new Set(all.map((t) => (t.payload as any).channelId));
  check('one alert → exactly one task per matching enabled channel (kinds list, all kinds; not device-only, disabled, error-only)',
    all.length === 2 && targets.has(ch1) && targets.has(ch2) && !targets.has(ch3) && !targets.has(ch4) && !targets.has(ch5), JSON.stringify([...targets]));
  check('payload: channel id + alert (kind, params), no token or config', all.every((t) => {
    const p = t.payload as Record<string, unknown>;
    return p.kind === 'account.problem' && p.recovered === false && Object.keys(p).sort().join() === 'channelId,kind,params,recovered,refId,refType' && !leaks(JSON.stringify(t.payload));
  }), JSON.stringify(tasks[0]?.payload));
  const done = await Promise.all(all.map((t) => finished(t.id)));
  check('each task failed once with alerts.telegram_unauthorized (real Telegram, no retry on 4xx)', done.every((t) => t.status === 'failed' && t.errorCode === 'alerts.telegram_unauthorized' && t.attempts === 1), done.map((t) => `${t.status}/${t.errorCode}/${t.attempts}`).join(' '));
  const logs = await db.select().from(schema.taskLogs).where(inArray(schema.taskLogs.taskId, all.map((t) => t.id)));
  check('task logs / errors never contain a token', !leaks(JSON.stringify(logs)) && !done.some((t) => leaks(t.error ?? '')));
  const lastOf = async (id: string) => (await db.select().from(CH).where(eq(CH.id, id)))[0]!.lastResult;
  await waitFor('lastResult', async () => (await lastOf(ch2))?.ok === false, 10_000);
  check('lastResult of a failed delivery: ok false + code', (await lastOf(ch2))?.code === 'alerts.telegram_unauthorized' && !(await lastOf(ch2))?.test);
  const failNotes = await waitFor('channel.failed notices', async () => {
    const x = await db.select().from(N).where(and(eq(N.kind, 'channel.failed'), inArray(N.refId, [ch1, ch2]), gte(N.createdAt, t0)));
    return x.length >= 2 ? x : null;
  }, 10_000);
  check('delivery failure → one channel.failed in-app notice per channel to the admin (name, code)',
    failNotes.length === 2 && failNotes.every((n) => n.userId === uT && n.refType === 'alert_channel' && n.params.code === 'alerts.telegram_unauthorized') && failNotes.some((n) => n.params.name === nm('all')), JSON.stringify(failNotes));
  check('channel.failed: the (non-admin) user gets nothing', (await db.select().from(N).where(and(eq(N.userId, uA), eq(N.kind, 'channel.failed')))).length === 0);
  check('no task.failed alert for notify-telegram (own alert kind)', (await db.select().from(N).where(and(eq(N.kind, 'task.failed'), inArray(N.refId, all.map((t) => t.id))))).length === 0);
  await sleep(1500);
  const since = await db.select().from(schema.tasks).where(and(eq(schema.tasks.type, 'notify-telegram'), gte(schema.tasks.createdAt, t0)));
  check('no loop: the failure notices created no further channel tasks', since.length === 2, String(since.length));

  // cooldown: the same alert again → nothing; another alert → fan-out again, but channel.failed stays de-duplicated
  r = await http('POST', `/api/social/accounts/${acc}/checked`, A, { loginStatus: 'logged_out' });
  await sleep(1500);
  check('cooldown unchanged: the same alert within the cooldown → no new channel tasks', (await tgTasks(acc)).length === 2);
  r = await http('POST', '/api/social/accounts', A, { platform: 'instagram', handle: `ac_${tag}_two` });
  const acc2: string = r.body.account.id; refIds.push(acc2);
  await http('POST', `/api/social/accounts/${acc2}/checked`, A, { loginStatus: 'needs_verification' });
  const second = await waitFor('second fan-out', async () => { const x = await tgTasks(acc2); return x.length >= 2 ? x : null; }, 10_000);
  await Promise.all(second.map((t) => finished(t.id)));
  await sleep(1500);
  check('second alert fans out again; channel.failed not repeated within the cooldown',
    (await db.select().from(N).where(and(eq(N.kind, 'channel.failed'), inArray(N.refId, [ch1, ch2]), gte(N.createdAt, t0)))).length === 2);
  // recovery notice fans out too (recovered: true)
  await recover({ kind: 'account.problem', refId: acc, params: { platform: 'instagram', handle: `ac_${tag}_one` } });
  const rec = await waitFor('recovered fan-out', async () => { const x = (await tgTasks(acc)).filter((t) => (t.payload as any).recovered); return x.length >= 2 ? x : null; }, 10_000);
  check('"recovered" notice fans out to the same channels', rec.length === 2 && new Set(rec.map((t) => (t.payload as any).channelId)).size === 2);
  await Promise.all([...rec].map((t) => finished(t.id)));

  // disabling a channel skips it
  await http('PATCH', `/api/alert-channels/${ch2}`, T, { enabled: false });
  r = await http('POST', '/api/social/accounts', A, { platform: 'instagram', handle: `ac_${tag}_three` });
  const acc3: string = r.body.account.id; refIds.push(acc3);
  await http('POST', `/api/social/accounts/${acc3}/checked`, A, { loginStatus: 'logged_out' });
  const third = await waitFor('third fan-out', async () => (await tgTasks(acc3)).at(0), 10_000);
  await sleep(1000);
  check('channel disabled by PATCH → skipped by the next fan-out', (await tgTasks(acc3)).length === 1 && (third.payload as any).channelId === ch1);
  await finished(third.id);

  // ---------------------------------------------------------------- optional real send
  if (process.env.TELEGRAM_TEST_TOKEN && process.env.TELEGRAM_TEST_CHAT) {
    const real = await mk('real', { kinds: [] }, process.env.TELEGRAM_TEST_TOKEN);
    await http('PATCH', `/api/alert-channels/${real}`, T, { config: { chatId: process.env.TELEGRAM_TEST_CHAT, language: 'zh-CN' } });
    r = await http('POST', `/api/alert-channels/${real}/test`, T);
    check('REAL Telegram test message sent', r.status === 200 && r.body.ok === true, r.text);
  } else {
    console.log('  (real Telegram send skipped: set TELEGRAM_TEST_TOKEN and TELEGRAM_TEST_CHAT)');
  }

  // ---------------------------------------------------------------- delete
  r = await http('DELETE', `/api/alert-channels/${ch5}`, T);
  check('delete → 204, gone', r.status === 204 && (await db.select().from(CH).where(eq(CH.id, ch5))).length === 0);
  r = await http('DELETE', `/api/alert-channels/${ch5}`, T);
  check('delete again → 404', r.status === 404 && r.body.code === 'alerts.channel_not_found');

  // ---------------------------------------------------------------- data migration from the old settings key
  const oldTok = fakeToken();
  await db.insert(schema.settings).values({ key: 'alerts.telegram', value: { enabled: true, chatId: '-1005550001112', tokenEnc: sealSecret(oldTok), language: 'en' } })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value: { enabled: true, chatId: '-1005550001112', tokenEnc: sealSecret(oldTok), language: 'en' } } });
  const [rulesRow] = await db.select().from(schema.settings).where(eq(schema.settings.key, 'alerts.rules'));
  const oldRules = { ...(rulesRow?.value as object), kinds: { 'device.down': { inApp: true, telegram: true }, 'account.problem': { inApp: true, telegram: false }, 'publish.failed': { inApp: true, telegram: true }, 'connection.expired': { inApp: true, telegram: false } } };
  await db.update(schema.settings).set({ value: oldRules }).where(eq(schema.settings.key, 'alerts.rules'));
  const before = await db.select({ id: CH.id }).from(CH);
  const migrate = () => execFileSync('npx', ['tsx', '--env-file=../../.env', 'src/db/migrate.ts'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const out1 = migrate();
  const after = await db.select().from(CH);
  const made = after.filter((c) => !before.some((b) => b.id === c.id));
  channelIds.push(...made.map((c) => c.id));
  const m = made[0];
  check('db:migrate: old Telegram settings → exactly one channel (name Telegram, enabled, chat id, language)',
    made.length === 1 && m!.type === 'telegram' && /^Telegram/.test(m!.name) && m!.enabled && m!.config.chatId === '-1005550001112' && m!.config.language === 'en', JSON.stringify(made.map((c) => ({ ...c, config: { ...c.config, botTokenEnc: '…' } }))));
  check('migrated: sealed token carried over (decrypts to the old token)', !!m && openSecret(String(m.config.botTokenEnc)) === oldTok);
  check('migrated: kinds from the old per-kind telegram flags (kinds without an old flag take their default: collector.blocked on, task.failed off)', !!m && [...m.kinds].sort().join() === 'collector.blocked,device.down,publish.failed', m?.kinds.join());
  check('migrated: old settings key removed', (await db.select().from(schema.settings).where(eq(schema.settings.key, 'alerts.telegram'))).length === 0 && /migrated the Telegram settings/.test(out1));
  migrate();
  check('db:migrate again → no further channel', (await db.select({ id: CH.id }).from(CH)).length === after.length);
  r = await http('GET', '/api/settings/alerts', T);
  check('rules after migration: in-app switches only, the telegram flags are ignored', r.status === 200 && r.body.rules.kinds['device.down'].inApp === true && r.body.rules.kinds['device.down'].telegram === undefined);

  // ---------------------------------------------------------------- audit
  await sleep(800);
  const audits = await db.select().from(schema.auditLogs).where(and(gte(schema.auditLogs.at, t0), like(schema.auditLogs.action, 'alert_channel.%')));
  const acts = new Set(audits.map((a) => a.action));
  check('audit: alert_channel.create/update/delete/test recorded', ['alert_channel.create', 'alert_channel.update', 'alert_channel.delete', 'alert_channel.test'].every((a) => acts.has(a)), [...acts].join(','));
  check('audit: tokens never in the audit log; bot shown as replaced/unchanged; target = channel name',
    !leaks(JSON.stringify(audits)) && audits.some((a) => a.action === 'alert_channel.create' && (a.detail as any)?.bot === 'replaced' && a.target === nm('one'))
    && audits.some((a) => a.action === 'alert_channel.update' && (a.detail as any)?.bot === 'unchanged') && audits.some((a) => a.action === 'alert_channel.delete' && a.target === nm('erronly')), JSON.stringify(audits.map((a) => [a.action, a.target, a.detail])).slice(0, 600));
  const allTasks = await db.select().from(schema.tasks).where(gte(schema.tasks.createdAt, t0));
  check('no token in any task payload/result/error since the start', !leaks(JSON.stringify(allTasks)));
} catch (err) {
  check(`unexpected error: ${(err as Error).stack}`, false);
} finally {
  for (const id of userIds) await http('DELETE', `/api/users/${id}`, T);
  await db.delete(schema.socialAccounts).where(like(schema.socialAccounts.handle, `ac_${tag}_%`));
  if (channelIds.length) await db.delete(CH).where(inArray(CH.id, channelIds));
  const ids = [...refIds, ...channelIds];
  if (ids.length) {
    await db.delete(N).where(inArray(N.refId, ids));
    await db.delete(schema.alertStates).where(inArray(schema.alertStates.key, ids));
  }
  for (const [k, v] of Object.entries(saved)) {
    if (v === null) await db.delete(schema.settings).where(eq(schema.settings.key, k));
    else await db.insert(schema.settings).values({ key: k, value: v }).onConflictDoUpdate({ target: schema.settings.key, set: { value: v } });
  }
  const left = await db.select().from(CH).where(like(CH.name, `ac-${tag}-%`));
  check('cleanup: test user, accounts, channels, notices removed; settings restored', left.length === 0);
  await events.close();
  await closeTaskQueues();
  await sqlClient.end();
  const failed = results.filter((x) => !x[1]).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}
