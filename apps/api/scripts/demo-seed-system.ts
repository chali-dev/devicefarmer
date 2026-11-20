/**
 * Demo data + verification for 云手机管理 (non-device parts) and 系统管理, against the real API (no mocks).
 * Seeds (idempotent): demo users (demo-user shared with the other demo seeders, demo-ops admin, demo-viewer,
 * demo-disabled), the two APKs in the app library, two disabled Telegram demo channels (fake token, never
 * tested/sent). (The proxy pool and the library's 预装 flag were removed with redroid on 2026-11-20; --clean
 * still deletes demo proxies of older runs if the API has them.) Then verifies sealing of secrets, library
 * metadata, user rules, RBAC (with a temporary grant for demo-user that is revoked
 * again), audit, tasks, logs, backup failure, settings. Never touches the devices themselves.
 *
 * Usage (from apps/api, API running):
 *   npx tsx --env-file=../../.env scripts/demo-seed-system.ts            # seed + verify
 *   npx tsx --env-file=../../.env scripts/demo-seed-system.ts --no-verify
 *   npx tsx --env-file=../../.env scripts/demo-seed-system.ts --clean    # remove what this script created
 * Env: DEMO_FDROID_APK, DEMO_SECOND_APK (default paths below), E2E_API.
 * State (ids of what was created): var/demo-system-state.json. Passwords of the demo users this script owns:
 * var/demo-system-credentials.txt (never printed). demo-user's password: var/demo-credentials.txt.
 */
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { withCaptcha } from './lib/login.js';

const API = process.env.E2E_API ?? 'http://127.0.0.1:3000';
const VAR = path.resolve(import.meta.dirname, '../var');
const STATE_FILE = path.join(VAR, 'demo-system-state.json');
const CRED_FILE = path.join(VAR, 'demo-credentials.txt');
const MY_CRED_FILE = path.join(VAR, 'demo-system-credentials.txt');
const APKS = [
  process.env.DEMO_FDROID_APK ?? '/private/tmp/claude-501/-Users-test-Documents-devicefarmer/c13b766a-a82a-4486-a7a8-6970fe468d29/scratchpad/fdroid/F-Droid.apk',
  process.env.DEMO_SECOND_APK ?? path.join(os.homedir(), 'Downloads/com.diwaace.app.apk'),
];
const CLEAN = process.argv.includes('--clean');
const VERIFY = !process.argv.includes('--no-verify');
const ADMIN = process.env.ADMIN_USERNAME!;
const ADMIN_PW = process.env.ADMIN_PASSWORD!;

// ---------------------------------------------------------------- helpers
const results: [string, boolean][] = [];
const check = (name: string, ok: boolean, detail = '') => { results.push([name, ok]); console.log(`${ok ? '✓' : '✗'} ${name}${detail && !ok ? ` — ${detail.slice(0, 400)}` : ''}`); };
const info = (s: string) => console.log(`  · ${s}`);

async function http<T = any>(method: string, p: string, token: string | null, body?: unknown) {
  const isForm = body instanceof FormData;
  const res = await fetch(API + p, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined && !isForm ? { 'content-type': 'application/json' } : {}) },
    body: isForm ? body : body !== undefined ? JSON.stringify(body) : undefined,
  });
  const buf = Buffer.from(await res.arrayBuffer());
  let json: any = null;
  try { json = JSON.parse(buf.toString('utf8')); } catch { /* csv / 204 */ }
  return { status: res.status, body: json as T, text: buf.toString('utf8'), headers: res.headers };
}
async function login(username: string, password: string): Promise<string | null> {
  const r = await http('POST', '/api/auth/login', null, await withCaptcha(API, { username, password }));
  return r.status === 200 ? r.body.token : null;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor<T>(label: string, fn: () => Promise<T | null | false | undefined>, ms = 60_000): Promise<T> {
  const t0 = Date.now();
  for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() - t0 > ms) throw new Error(`timeout: ${label}`); await sleep(500); }
}
const pw = () => `Demo-${randomBytes(9).toString('base64url')}`;

type State = { users: Record<string, { id: string; createdByMe: boolean }>; proxies: string[]; library: string[]; channels: string[]; grants: { userId: string; instanceId: string }[]; backups: string[]; tasks: string[] };
const loadState = (): State => {
  try { return { users: {}, proxies: [], library: [], channels: [], grants: [], backups: [], tasks: [], ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) }; }
  catch { return { users: {}, proxies: [], library: [], channels: [], grants: [], backups: [], tasks: [] }; }
};
const saveState = (s: State) => { fs.mkdirSync(VAR, { recursive: true }); fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); };
const readCreds = (file: string): Record<string, string> => {
  // Lenient: "username=password", "username: password", or "username=x\npassword=y" blocks.
  const out: Record<string, string> = {};
  if (!fs.existsSync(file)) return out;
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  let pendingUser: string | null = null;
  for (const l of lines) {
    const m = /^([^=:\s]+)\s*[=:]\s*(.+)$/.exec(l);
    if (!m) { const sp = l.split(/\s+/); if (sp.length === 2) out[sp[0]!] = sp[1]!; continue; }
    const [, k, v] = m;
    if (/^(user(name)?|login)$/i.test(k!)) pendingUser = v!.trim();
    else if (/^pass(word)?$/i.test(k!)) { if (pendingUser) out[pendingUser] = v!.trim(); }
    else out[k!] = v!.trim();
  }
  return out;
};

// ---------------------------------------------------------------- demo data definitions
const DEMO_USERS: { username: string; role: 'admin' | 'user'; disabled?: boolean }[] = [
  { username: 'demo-ops', role: 'admin' },
  { username: 'demo-viewer', role: 'user' },
  { username: 'demo-disabled', role: 'user', disabled: true },
];
const CHANNELS = [
  { name: 'demo-Telegram-运维群（已停用）', kinds: ['device.down', 'task.failed'], minSeverity: 'warning', chatId: '-1001234567890', language: 'zh-CN' },
  { name: 'demo-Telegram-ops-en (disabled)', kinds: [] as string[], minSeverity: null, chatId: '@demo_ops_channel', language: 'en' },
];
const fakeBotToken = (i: number) => `1234567${i}:AAdemoFakeTokenNotReal_${'x'.repeat(10)}${i}`;
const allSecrets = () => CHANNELS.map((_, i) => fakeBotToken(i));

// ---------------------------------------------------------------- main
const T = await login(ADMIN, ADMIN_PW);
if (!T) throw new Error('admin login failed');
const me = (await http('GET', '/api/auth/me', T)).body.user;
const state = loadState();

if (CLEAN) await clean();
else {
  await seed();
  if (VERIFY) await verify();
}
const failed = results.filter(([, ok]) => !ok);
if (results.length) console.log(`\n${results.length - failed.length}/${results.length} checks passed${failed.length ? `; failed: ${failed.map(([n]) => n).join(' | ')}` : ''}`);
process.exit(failed.length ? 1 : 0);

// ================================================================= clean
async function clean() {
  let n = 0;
  // demo proxies of older runs (the pool API is gone since 2026-11-20; nothing to do then)
  const px = await http('GET', '/api/proxies', T);
  if (px.status === 200) for (const id of state.proxies) if ((await http('DELETE', `/api/proxies/${id}`, T)).status === 204) n++;
  if (n) info(`proxies deleted: ${n}`);
  const lib = (await http('GET', '/api/library', T)).body.apps as any[];
  n = 0;
  for (const id of state.library) if (lib.some((a) => a.id === id) && (await http('DELETE', `/api/library/${id}`, T)).status === 204) n++;
  info(`library entries deleted: ${n}`);
  const ch = (await http('GET', '/api/alert-channels', T)).body.channels as any[];
  n = 0;
  for (const c of ch) if ((state.channels.includes(c.id) || CHANNELS.some((d) => d.name === c.name)) && (await http('DELETE', `/api/alert-channels/${c.id}`, T)).status === 204) n++;
  info(`alert channels deleted: ${n}`);
  const users = (await http('GET', '/api/users', T)).body.users as any[];
  for (const g of state.grants) {
    const u = users.find((x) => x.id === g.userId);
    if (u?.instanceIds.includes(g.instanceId)) await http('PUT', `/api/users/${u.id}/grants`, T, { instanceIds: u.instanceIds.filter((i: string) => i !== g.instanceId) });
  }
  info(`grants revoked: ${state.grants.length}`);
  n = 0;
  for (const [name, u] of Object.entries(state.users)) {
    if (!u.createdByMe) continue;
    if (users.some((x) => x.id === u.id) && (await http('DELETE', `/api/users/${u.id}`, T)).status === 204) n++;
    if (name === 'demo-user') info('demo-user was created by this script: deleted (its credentials file is kept unless removed by hand)');
  }
  info(`users deleted: ${n}`);
  const bk = (await http('GET', '/api/system/backups', T)).body.backups as any[];
  for (const b of bk) if (state.backups.includes(b.id) || state.tasks.includes(b.taskId)) await http('DELETE', `/api/system/backups/${b.id}`, T);
  fs.rmSync(STATE_FILE, { force: true });
  fs.rmSync(MY_CRED_FILE, { force: true });
  info('state + own credentials file removed (tasks and audit entries are history and stay)');
}

// ================================================================= seed
async function seed() {
  console.log('— seeding');
  // ---- users
  const users = async () => (await http('GET', '/api/users', T)).body.users as any[];
  let list = await users();
  let demoUser = list.find((u) => u.username === 'demo-user');
  if (!demoUser) {
    // Another seeder may be creating it right now: give it a moment.
    for (let i = 0; i < 10 && !demoUser && !fs.existsSync(CRED_FILE); i++) { await sleep(1000); list = await users(); demoUser = list.find((u) => u.username === 'demo-user'); }
  }
  if (!demoUser) {
    const p = pw();
    const r = await http('POST', '/api/users', T, { username: 'demo-user', password: p, role: 'user' });
    if (r.status === 201) {
      demoUser = r.body.user;
      state.users['demo-user'] = { id: demoUser.id, createdByMe: true };
      try { fs.writeFileSync(CRED_FILE, `username=demo-user\npassword=${p}\n`, { flag: 'wx', mode: 0o600 }); info(`created demo-user, password written to ${CRED_FILE}`); }
      catch { info('demo-user created but credentials file already existed (not overwritten)'); }
    } else { list = await users(); demoUser = list.find((u) => u.username === 'demo-user'); }
  } else if (!state.users['demo-user']) state.users['demo-user'] = { id: demoUser.id, createdByMe: false };
  info(`demo-user: ${demoUser ? `${demoUser.id} (${state.users['demo-user']?.createdByMe ? 'created here' : 'existing'})` : 'MISSING'}`);
  const myCreds = readCreds(MY_CRED_FILE);
  for (const d of DEMO_USERS) {
    let u = list.find((x) => x.username === d.username);
    if (!u) {
      const p = pw();
      const r = await http('POST', '/api/users', T, { username: d.username, password: p, role: d.role });
      if (r.status !== 201) throw new Error(`create ${d.username}: ${r.status} ${r.body?.code}`);
      u = r.body.user;
      myCreds[d.username] = p;
      state.users[d.username] = { id: u.id, createdByMe: true };
    } else if (!state.users[d.username]) state.users[d.username] = { id: u.id, createdByMe: false };
    if (Boolean(d.disabled) !== Boolean(u.disabled)) await http('PATCH', `/api/users/${u.id}`, T, { disabled: Boolean(d.disabled) });
  }
  fs.writeFileSync(MY_CRED_FILE, `# demo users of demo-seed-system.ts (local only)\n${Object.entries(myCreds).map(([k, v]) => `${k}=${v}`).join('\n')}\n`, { mode: 0o600 });
  info(`users: demo-ops (admin), demo-viewer (user), demo-disabled (user, disabled); passwords in ${MY_CRED_FILE}`);

  // ---- library
  const lib0 = (await http('GET', '/api/library', T)).body.apps as any[];
  for (const f of APKS) {
    if (!fs.existsSync(f)) { info(`APK missing: ${f}`); continue; }
    const fd = new FormData();
    fd.append('file', new Blob([fs.readFileSync(f)]), path.basename(f));
    const r = await http('POST', '/api/library/upload', T, fd);
    if (r.status !== 200) { info(`upload ${path.basename(f)}: ${r.status} ${r.body?.code} ${r.body?.error}`); continue; }
    // A re-upload of an entry that existed before this script (not ours) must not be adopted for --clean.
    const preexisting = lib0.some((a) => a.id === r.body.app.id) && !state.library.includes(r.body.app.id);
    if (!preexisting && !state.library.includes(r.body.app.id)) state.library.push(r.body.app.id);
    info(`library: ${r.body.app.package} ${r.body.app.versionName} (${r.body.app.versionCode})${preexisting ? ' [pre-existing entry]' : ''}`);
  }
  saveState(state);

  // ---- alert channels (disabled, fake token)
  const ch0 = (await http('GET', '/api/alert-channels', T)).body.channels as any[];
  for (const [i, c] of CHANNELS.entries()) {
    const hit = ch0.find((x) => x.name === c.name);
    if (hit) {
      if (!state.channels.includes(hit.id)) state.channels.push(hit.id);
      if (hit.config.chatId !== c.chatId || [...hit.kinds].sort().join() !== [...c.kinds].sort().join() || hit.enabled) {
        await http('PATCH', `/api/alert-channels/${hit.id}`, T, { enabled: false, kinds: c.kinds, minSeverity: c.minSeverity, config: { chatId: c.chatId, language: c.language } });
      }
      continue;
    }
    const r = await http('POST', '/api/alert-channels', T, { name: c.name, type: 'telegram', enabled: false, kinds: c.kinds, minSeverity: c.minSeverity, config: { botToken: fakeBotToken(i), chatId: c.chatId, language: c.language } });
    if (r.status !== 201) throw new Error(`channel ${c.name}: ${r.status} ${r.body?.code} ${r.body?.error}`);
    state.channels.push(r.body.channel.id);
  }
  info(`alert channels: ${state.channels.length} (disabled)`);
  saveState(state);
}

// ================================================================= verify
async function verify() {
  console.log('\n— verifying');
  const t0 = new Date(Date.now() - 2000);
  const users = (await http('GET', '/api/users', T)).body.users as any[];
  const U = (n: string) => users.find((u) => u.username === n);
  const secrets = allSecrets();
  const leaks = (s: string) => secrets.filter((x) => s.includes(x));

  let r: Awaited<ReturnType<typeof http<any>>>;

  // ------------------------------------------------ library
  const lib = (await http('GET', '/api/library', T)).body.apps as any[];
  for (const f of APKS) {
    if (!fs.existsSync(f)) { check(`APK present: ${f}`, false); continue; }
    const bytes = fs.readFileSync(f);
    const sha = createHash('sha256').update(bytes).digest('hex');
    const row = lib.find((a) => a.files.some((x: any) => x.sha256 === sha));
    check(`library has ${path.basename(f)} with the file's sha256 and size`, !!row && row.files[0].size === bytes.length, row ? '' : 'no entry with that sha256');
    if (!row) continue;
    // Independent check: package and versionName must be strings in the binary manifest's string pool (UTF-16LE or UTF-8).
    let manifest = Buffer.alloc(0);
    try { manifest = execFileSync('unzip', ['-p', f, 'AndroidManifest.xml'], { maxBuffer: 64 << 20 }); } catch { /* */ }
    const has = (s: string) => manifest.includes(Buffer.from(s, 'utf16le')) || manifest.includes(Buffer.from(s, 'utf8'));
    check(`${row.package}: package + versionName found in the APK's AndroidManifest.xml`, manifest.length > 0 && has(row.package) && (!row.versionName || has(row.versionName)), `${row.package} ${row.versionName}`);
    check(`${row.package}: versionCode is decimal, source upload:${ADMIN}, no preinstall field`, /^\d+$/.test(row.versionCode) && row.sourceInstance === `upload:${ADMIN}` && !('preinstall' in row), JSON.stringify({ v: row.versionCode, s: row.sourceInstance }));
    info(`${row.package} ${row.versionName} (${row.versionCode}) sha256 ${sha.slice(0, 16)}… ${bytes.length} B`);
  }
  const fdroid = lib.find((a) => a.package === 'org.fdroid.fdroid' && state.library.includes(a.id));
  if (fdroid) {
    const fd = new FormData(); fd.append('file', new Blob([fs.readFileSync(APKS[0]!)]), 'again.apk');
    r = await http('POST', '/api/library/upload', T, fd);
    check('re-upload of the same version keeps the same entry id', r.status === 200 && r.body.app.id === fdroid.id);
    r = await http('PATCH', `/api/library/${fdroid.id}`, T, { preinstall: true });
    check('the removed 预装 PATCH → 404', r.status === 404, String(r.status));
  }
  { const fd = new FormData(); fd.append('file', new Blob([Buffer.from('not a zip')]), 'junk.apk');
    r = await http('POST', '/api/library/upload', T, fd);
    check('junk .apk refused with library.bad_apk', r.status === 400 && r.body.code === 'library.bad_apk', JSON.stringify(r.body)); }

  // ------------------------------------------------ users / built-in admin rules
  const admin = users.find((u) => u.builtin)!;
  check('built-in admin flagged', admin?.username === ADMIN && admin.role === 'admin');
  r = await http('DELETE', `/api/users/${admin.id}`, T);
  check('built-in admin cannot be deleted (users.builtin_delete)', r.status === 400 && r.body.code === 'users.builtin_delete', JSON.stringify(r.body));
  r = await http('PATCH', `/api/users/${admin.id}`, T, { disabled: true });
  check('built-in admin cannot be disabled (users.builtin_disable)', r.status === 400 && r.body.code === 'users.builtin_disable', JSON.stringify(r.body));
  const opsCreds = readCreds(MY_CRED_FILE);
  const OPS = opsCreds['demo-ops'] ? await login('demo-ops', opsCreds['demo-ops']) : null;
  check('demo-ops (admin) can log in', !!OPS);
  if (OPS) {
    r = await http('PATCH', `/api/users/${admin.id}`, OPS, { role: 'user' });
    check('another admin cannot demote the built-in admin (users.builtin_role)', r.status === 400 && r.body.code === 'users.builtin_role', JSON.stringify(r.body));
    if (r.status === 200) await http('PATCH', `/api/users/${admin.id}`, OPS, { role: 'admin' }); // safety net
    // Sends the current password so a bug could not change anything.
    r = await http('PATCH', `/api/users/${admin.id}`, OPS, { password: ADMIN_PW });
    check('another admin cannot reset the built-in admin password (users.builtin_password)', r.status === 400 && r.body.code === 'users.builtin_password', JSON.stringify(r.body));
    r = await http('DELETE', `/api/users/${admin.id}`, OPS);
    check('another admin cannot delete the built-in admin', r.status === 400 && r.body.code === 'users.builtin_delete');
    r = await http('PATCH', `/api/users/${U('demo-ops').id}`, OPS, { disabled: true });
    check('an admin cannot disable itself (users.self_demote)', r.status === 400 && r.body.code === 'users.self_demote', JSON.stringify(r.body));
    r = await http('DELETE', `/api/users/${U('demo-ops').id}`, OPS);
    check('an admin cannot delete itself (users.self_delete)', r.status === 400 && r.body.code === 'users.self_delete');
  }
  info('users.last_admin is not reachable while the built-in admin exists (it can be neither disabled nor demoted)');
  check('demo-disabled is disabled', U('demo-disabled')?.disabled === true);
  r = await http('POST', '/api/auth/login', null, await withCaptcha(API, { username: 'demo-disabled', password: opsCreds['demo-disabled'] ?? 'x' }));
  check('a disabled user cannot log in', r.status === 401 || r.status === 403, `${r.status} ${r.body?.code}`);
  // throw-away user: enable/disable/reset/delete
  const tmpName = `demo-tmp-${randomBytes(3).toString('hex')}`;
  const p1 = pw();
  r = await http('POST', '/api/users', T, { username: tmpName, password: p1, role: 'user' });
  const tmpU = r.body?.user;
  check('create throw-away user (201)', r.status === 201 && tmpU?.role === 'user');
  r = await http('POST', '/api/users', T, { username: tmpName, password: p1, role: 'user' });
  check('duplicate username → 409 users.username_taken', r.status === 409 && r.body.code === 'users.username_taken');
  r = await http('POST', '/api/users', T, { username: 'demo-short', password: 'short', role: 'user' });
  check('password shorter than 8 → 400', r.status === 400);
  if (tmpU) {
    await http('PATCH', `/api/users/${tmpU.id}`, T, { disabled: true });
    check('disabled throw-away user cannot log in', !(await login(tmpName, p1)));
    await http('PATCH', `/api/users/${tmpU.id}`, T, { disabled: false });
    check('re-enabled throw-away user can log in', !!(await login(tmpName, p1)));
    const p2 = pw();
    r = await http('PATCH', `/api/users/${tmpU.id}`, T, { password: p2 });
    check('password reset: old one refused, new one works', r.status === 200 && !(await login(tmpName, p1)) && !!(await login(tmpName, p2)));
    r = await http('PATCH', `/api/users/${tmpU.id}`, T, { role: 'admin' });
    check('promote to admin / demote back', r.status === 200 && r.body.user.role === 'admin' && (await http('PATCH', `/api/users/${tmpU.id}`, T, { role: 'user' })).body.user.role === 'user');
    r = await http('PATCH', `/api/users/${tmpU.id}`, T, {});
    check('empty patch → 400 common.nothing_to_update', r.status === 400 && r.body.code === 'common.nothing_to_update');
    r = await http('DELETE', `/api/users/${tmpU.id}`, T);
    check('delete throw-away user → 204, gone from the list', r.status === 204 && !(await http('GET', '/api/users', T)).body.users.some((u: any) => u.id === tmpU.id));
  }
  // demo-viewer password reset (a demo user; the new password is stored in the local credentials file)
  { const p3 = pw();
    r = await http('PATCH', `/api/users/${U('demo-viewer').id}`, T, { password: p3 });
    if (r.status === 200) { const c = readCreds(MY_CRED_FILE); c['demo-viewer'] = p3; fs.writeFileSync(MY_CRED_FILE, `# demo users of demo-seed-system.ts (local only)\n${Object.entries(c).map(([k, v]) => `${k}=${v}`).join('\n')}\n`, { mode: 0o600 }); }
    check('reset demo-viewer password works', r.status === 200 && !!(await login('demo-viewer', p3))); }
  r = await http('GET', '/api/users', T);
  check('user list never returns password hashes', !/passwordHash|\$2[aby]\$/.test(r.text));

  // ------------------------------------------------ grants + RBAC
  const instances = ((await http('GET', '/api/instances', T)).body.instances ?? []) as any[];
  info(`devices on the platform: ${instances.map((i) => `${i.name} (${i.status})`).join(', ') || 'none'}`);
  const demoU = U('demo-user');
  const demoPw = readCreds(CRED_FILE)['demo-user'];
  const D = demoU && demoPw ? await login('demo-user', demoPw) : null;
  const viewerPw = readCreds(MY_CRED_FILE)['demo-viewer'];
  const V = viewerPw ? await login('demo-viewer', viewerPw) : null;
  const UT = D ?? V; const UTname = D ? 'demo-user' : 'demo-viewer';
  check(`${UTname} can log in for RBAC checks`, !!UT, D ? '' : 'demo-user credentials not readable');
  // A phone belongs to one user and assigning it moves its linked social accounts (2026-11-18): only borrow a device
  // that nobody is assigned to and that hosts no social account, so the temporary grant changes nothing else.
  let dev: any = null;
  for (const i of instances) {
    if (i.owners?.length) continue;
    const linked = (await http('GET', `/api/social/accounts?instanceId=${i.id}`, T)).body.items ?? [];
    if (!linked.length) { dev = i; break; }
  }
  if (!dev) info('no unassigned device without social accounts: grant/RBAC checks skipped');
  if (UT && dev) {
    const uid = U(UTname).id;
    const before = U(UTname).instanceIds as string[];
    const others = instances.filter((i) => i.id !== dev.id);
    r = await http('PUT', `/api/users/${uid}/grants`, T, { instanceIds: [...new Set([...before, dev.id])] });
    check(`grant ${UTname} on ${dev.name} (grant row only)`, r.status === 200);
    const added = !before.includes(dev.id);
    if (added) { state.grants.push({ userId: uid, instanceId: dev.id }); saveState(state); }
    r = await http('PUT', `/api/users/${U('demo-ops').id}/grants`, T, { instanceIds: [dev.id] });
    check('grant to an admin refused (grants.admin_not_needed)', r.status === 400 && r.body.code === 'grants.admin_not_needed');
    r = await http('PUT', `/api/users/${uid}/grants`, T, { instanceIds: [...before, dev.id, '00000000-0000-4000-8000-000000000000'] });
    check('grant on an unknown device refused (instances.not_found), set unchanged', r.status === 400 && r.body.code === 'instances.not_found'
      && (await http('GET', '/api/users', T)).body.users.find((u: any) => u.id === uid).instanceIds.includes(dev.id));
    const mine = (await http('GET', '/api/instances', UT)).body.instances as any[];
    check(`${UTname} sees exactly its granted devices`, mine.length === [...new Set([...before, dev.id])].length && mine.some((i) => i.id === dev.id), mine.map((i) => i.name).join(','));
    check('device view for a user has no proxy credentials', !/"username"|"password"|passwordEnc/.test(JSON.stringify(mine)));
    r = await http('GET', '/api/system/connections', UT);
    check('connection monitoring is admin only (user 403)', r.status === 403);
    r = await http('GET', `/api/system/connections/${dev.id}/history?hours=24`, UT);
    check('user cannot read even the granted device\'s connection history (403, admin only)', r.status === 403);
    for (const o of others.slice(0, 1)) {
      r = await http('GET', `/api/system/connections/${o.id}/history`, UT);
      check('user cannot read another device\'s history (403)', r.status === 403);
    }
    const denied: [string, string][] = [['GET', '/api/users'], ['GET', '/api/audit'], ['GET', '/api/audit/export.csv'], ['GET', '/api/system/logs'],
      ['GET', '/api/system/backups'], ['POST', '/api/system/backups'], ['GET', '/api/system/settings'], ['GET', '/api/alert-channels'], ['GET', '/api/settings/alerts'],
      ['GET', '/api/settings/storage'], ['GET', '/api/settings/tasks'], ['GET', '/api/settings/system'], ['GET', '/api/device-sources']];
    const res = await Promise.all(denied.map(([m, p]) => http(m, p, UT, m === 'POST' ? { text: '' } : undefined)));
    check('user gets 403 on every admin page/API', res.every((x) => x.status === 403), denied.map(([m, p], i) => `${m} ${p}=${res[i]!.status}`).filter((_, i) => res[i]!.status !== 403).join(', '));
    r = await http('GET', '/api/library', UT);
    check('user cannot list the library (403, admin only)', r.status === 403);
    r = await http('DELETE', `/api/library/${state.library[0]}`, UT);
    check('user cannot delete from the library (403)', r.status === 403);
    { const fd = new FormData(); fd.append('file', new Blob([Buffer.from('x')]), 'x.apk');
      r = await http('POST', '/api/library/upload', UT, fd);
      check('user cannot upload to the library (403)', r.status === 403); }
    const adminTask = (await http('GET', `/api/tasks?userId=${me.id}&limit=1`, T)).body.tasks?.[0];
    if (adminTask && !adminTask.instanceId) {
      r = await http('GET', `/api/tasks/${adminTask.id}`, UT);
      check('user gets 404 on an admin\'s device-less task', r.status === 404);
    }
    const ut = (await http('GET', '/api/tasks?limit=200', UT)).body.tasks as any[];
    check('user task list: own tasks or tasks on granted devices only', ut.every((t) => t.createdBy === uid || mine.some((i) => i.id === t.instanceId)));
    // Revoke the temporary grant (grants give view+control+operate; the device is the owner's billed phone).
    if (added) {
      r = await http('PUT', `/api/users/${uid}/grants`, T, { instanceIds: before });
      const nowIds = (await http('GET', '/api/users', T)).body.users.find((u: any) => u.id === uid).instanceIds;
      check(`temporary grant on ${dev.name} revoked (back to the previous set)`, r.status === 200 && !nowIds.includes(dev.id));
      if (!nowIds.includes(dev.id)) { state.grants = state.grants.filter((g) => !(g.userId === uid && g.instanceId === dev.id)); saveState(state); }
      const after = (await http('GET', '/api/instances', UT)).body.instances as any[];
      check(`${UTname} no longer sees ${dev.name}`, !after.some((i) => i.id === dev.id));
      r = await http('GET', `/api/system/connections/${dev.id}/history`, UT);
      check('history of the revoked device → 403', r.status === 403);
    }
  } else if (!dev) info('no device to grant on: grant checks skipped');

  // ------------------------------------------------ connection monitoring (admin, read only)
  r = await http('GET', '/api/system/connections', T);
  check('connection panel lists every device for the admin', r.status === 200 && r.body.devices.length === instances.length);
  if (dev) { r = await http('GET', `/api/system/connections/${dev.id}/history?hours=168`, T); check('admin reads 7-day history', r.status === 200 && Array.isArray(r.body.events), `${r.status}`); info(`${dev.name}: ${r.body.events?.length ?? 0} status events in 7 days`); }
  r = await http('GET', `/api/system/connections/${dev?.id ?? '00000000-0000-4000-8000-000000000000'}/history?hours=0`, T);
  check('history hours=0 → 400', r.status === 400);

  // ------------------------------------------------ alert channels
  r = await http('GET', '/api/alert-channels', T);
  const chs = (r.body.channels as any[]).filter((c) => state.channels.includes(c.id));
  check('demo alert channels listed, all disabled', chs.length === CHANNELS.length && chs.every((c) => c.enabled === false));
  check('bot token never returned (botTokenSet only)', leaks(r.text).length === 0 && chs.every((c) => c.config.botTokenSet === true && !('botToken' in c.config)), JSON.stringify(chs.map((c) => c.config)));
  r = await http('POST', '/api/alert-channels', T, { name: CHANNELS[0]!.name, type: 'telegram', enabled: false, config: { botToken: fakeBotToken(9), chatId: '-100123' } });
  check('duplicate channel name → 409 alerts.channel_name_taken', r.status === 409 && r.body.code === 'alerts.channel_name_taken');
  r = await http('POST', '/api/alert-channels', T, { name: 'demo-bad', type: 'telegram', enabled: false, config: { botToken: 'nope', chatId: '-100123' } });
  check('malformed bot token refused (400)', r.status === 400, JSON.stringify(r.body));
  const en = chs.find((c) => c.name === CHANNELS[1]!.name);
  if (en) {
    r = await http('PATCH', `/api/alert-channels/${en.id}`, T, { kinds: ['device.down'], config: { chatId: '@demo_ops_channel2' } });
    const again = (await http('GET', '/api/alert-channels', T)).body.channels.find((c: any) => c.id === en.id);
    check('channel edit persists, token kept (still set), still disabled', r.status === 200 && again.kinds.join() === 'device.down' && again.config.chatId === '@demo_ops_channel2' && again.config.botTokenSet && !again.enabled, JSON.stringify(again));
    await http('PATCH', `/api/alert-channels/${en.id}`, T, { kinds: CHANNELS[1]!.kinds, config: { chatId: CHANNELS[1]!.chatId } });
  }
  r = await http('GET', '/api/settings/alerts', T);
  check('alert rules readable (admin)', r.status === 200 && !!r.body.rules && Array.isArray(r.body.kinds));

  // ------------------------------------------------ backup (PG_DUMP_CMD not installed here)
  const bk = await http('POST', '/api/system/backups', T);
  check('backup now → 202 + task', bk.status === 202 && !!bk.body.task?.id, JSON.stringify(bk.body));
  if (bk.body?.task?.id) {
    state.tasks.push(bk.body.task.id); saveState(state);
    const task = await waitFor('backup task', async () => { const t = (await http('GET', `/api/tasks/${bk.body.task.id}`, T)).body?.task; return t && ['success', 'failed', 'cancelled'].includes(t.status) ? t : null; }, 60_000);
    check('backup task fails with code system.backup_cmd_failed', task.status === 'failed' && task.errorCode === 'system.backup_cmd_failed', `${task.status} ${task.errorCode} ${task.error}`);
    const dbUrl = process.env.DATABASE_URL ?? '';
    const dbPw = (() => { try { return decodeURIComponent(new URL(dbUrl).password); } catch { return ''; } })();
    const detail = await http('GET', `/api/tasks/${task.id}`, T);
    check('backup task + logs contain no DB URL / PGPASSWORD', !detail.text.includes(dbUrl) && !/PGPASSWORD=\S/.test(detail.text) && !(dbPw.length >= 8 && detail.text.includes(`:${dbPw}@`)));
    const row = (await http('GET', '/api/system/backups', T)).body.backups.find((b: any) => b.taskId === task.id);
    check('failed backup listed with status failed + error', row?.status === 'failed' && !!row.error, JSON.stringify(row));
    if (row) { state.backups.push(row.id); saveState(state); }
    // task centre: detail/list/filters on our own failed task; retry it once (also fails), it's ours
    r = await http('GET', `/api/tasks?type=db-backup&status=failed&userId=${me.id}&limit=5`, T);
    check('task list filters type+status+userId find the backup task', r.body.tasks.some((t: any) => t.id === task.id) && r.body.tasks.every((t: any) => t.type === 'db-backup' && t.status === 'failed'));
    check('task list rows omit payload/result', r.body.tasks.every((t: any) => !('payload' in t) && !('result' in t)));
    check('task detail has logs and action flags', Array.isArray(detail.body.logs) && detail.body.logs.length > 0 && typeof detail.body.task.canRetry === 'boolean');
    if (detail.body.task.canRetry) {
      r = await http('POST', `/api/tasks/${task.id}/retry`, T);
      check('retry of our failed backup task → 202 new task with retry_of', r.status === 202 && r.body.task.retryOf === task.id, JSON.stringify(r.body));
      if (r.body?.task?.id) {
        state.tasks.push(r.body.task.id); saveState(state);
        const t2 = await waitFor('retry', async () => { const t = (await http('GET', `/api/tasks/${r.body.task.id}`, T)).body?.task; return t && ['success', 'failed', 'cancelled'].includes(t.status) ? t : null; });
        check('retried backup also fails cleanly', t2.status === 'failed' && t2.errorCode === 'system.backup_cmd_failed');
        const b2 = (await http('GET', '/api/system/backups', T)).body.backups.find((b: any) => b.taskId === t2.id);
        if (b2) { state.backups.push(b2.id); saveState(state); }
      }
    } else info('db-backup task is not retryable from the task centre');
    r = await http('POST', `/api/tasks/${task.id}/cancel`, T);
    check('cancel of a finished task refused (4xx)', r.status >= 400 && r.status < 500, `${r.status} ${r.body?.code}`);
  }
  r = await http('GET', '/api/tasks?limit=2&offset=0', T); const r2 = await http('GET', '/api/tasks?limit=2&offset=2', T);
  check('task pagination: limit/offset pages differ, total stable', r.body.tasks.length <= 2 && r.body.total === r2.body.total && (r.body.total <= 2 || r.body.tasks[0]?.id !== r2.body.tasks[0]?.id));
  r = await http('GET', '/api/tasks/stats', T);
  check('task stats by status/type', r.status === 200 && typeof r.body.byStatus.failed === 'number' && r.body.types.includes('db-backup'));
  r = await http('GET', `/api/tasks?q=db-backup&limit=5`, T);
  check('task search ?q=', r.status === 200 && r.body.tasks.every((t: any) => /db-backup/.test(`${t.type}${t.instanceName}${t.error}${t.id}`)));

  // ------------------------------------------------ system logs (read only)
  r = await http('GET', '/api/system/logs?limit=500', T);
  check('system logs readable', r.status === 200 && Array.isArray(r.body.entries) && r.body.entries.length > 0, `${r.status} ${r.body?.entries?.length}`);
  check('logs contain none of the demo secrets', leaks(r.text).length === 0, leaks(r.text).join(','));
  check('logs contain no bearer tokens / bcrypt hashes', !/Bearer\s+eyJ|\$2[aby]\$\d\d\$/.test(r.text));
  const warn = await http('GET', '/api/system/logs?level=warn&limit=200', T);
  check('?level=warn returns only level ≥ 40', warn.body.entries.every((e: any) => e.level >= 40));
  const qq = await http('GET', '/api/system/logs?q=backup&limit=50', T);
  check('?q= text filter', qq.body.entries.every((e: any) => JSON.stringify(e).toLowerCase().includes('backup')));
  const files = await http('GET', '/api/system/logs/files', T);
  check('log files listed', files.status === 200 && Array.isArray(files.body.files));
  if (files.body.files?.[0]) {
    const f = await http('GET', `/api/system/logs?date=${files.body.files[0].date}&limit=100`, T);
    check(`log file ${files.body.files[0].date} readable, no demo secrets`, f.status === 200 && f.body.source === 'file' && leaks(f.text).length === 0);
  }
  { // Redaction: secret-looking query values in a harmless read-only request must not reach the log.
    const v = `demoRedact${Date.now()}`;
    await fetch(`${API}/api/health?token=${v}&password=${v}`);
    await sleep(500);
    const lr = await http('GET', '/api/system/logs?q=api%2Fhealth&limit=20', T);
    check('secret-looking query values are [redacted] in the system log', !lr.text.includes(v) && lr.text.includes('token=[redacted]'), lr.text.slice(0, 300)); }

  // ------------------------------------------------ settings (read only)
  const settings: [string, string][] = [['storage', '/api/settings/storage'], ['youtube', '/api/settings/youtube'], ['tasks', '/api/settings/tasks'],
    ['config', '/api/settings/config'], ['system', '/api/settings/system'], ['social', '/api/social/settings'], ['system mgmt', '/api/system/settings'], ['alerts', '/api/settings/alerts']];
  for (const [n, p] of settings) {
    r = await http('GET', p, T);
    const secretish = /"(secretAccessKey|secretKey|clientSecret|apiKey|password|botToken)"\s*:\s*"[^"]+/.test(r.text);
    check(`settings tab ${n} readable, no secret values`, r.status === 200 && !secretish, `${r.status} ${secretish ? 'secret-looking value' : ''}`);
  }

  // ------------------------------------------------ audit
  await sleep(1500); // writes are fire-and-forget
  const auditQ = async (q: string) => (await http('GET', `/api/audit?from=${encodeURIComponent(t0.toISOString())}&pageSize=200&${q}`, T)).body;
  for (const a of ['proxy.update', 'proxy.create', 'proxy.delete', 'proxy.import', 'library.upload', 'library.update', 'user.create', 'user.update', 'user.delete', 'grants.update', 'alert_channel.create', 'alert_channel.update', 'system.backup_create']) {
    const b = await auditQ(`action=${a}`);
    check(`audit has ${a} entries from this run`, (b?.total ?? 0) > 0 && b.items.every((x: any) => x.action === a), `${b?.total}`);
  }
  const all = await http('GET', `/api/audit?from=${encodeURIComponent(t0.toISOString())}&pageSize=200`, T);
  check('audit entries contain none of the demo secrets / user passwords', leaks(all.text).length === 0 && !Object.values(readCreds(MY_CRED_FILE)).some((x) => all.text.includes(x)), leaks(all.text).join(','));
  const pcr = await auditQ('action=proxy.create');
  check('proxy.create detail has auth flag, no username/password', pcr.items.every((x: any) => 'auth' in (x.detail ?? {}) && !('password' in (x.detail ?? {})) && !('username' in (x.detail ?? {}))));
  const fails = await auditQ('ok=false');
  check('?ok=false returns only failed requests (e.g. the 409s above)', fails.total > 0 && fails.items.every((x: any) => x.ok === false));
  const byUser = await auditQ(`user=${encodeURIComponent(ADMIN)}`);
  check('?user= filter', byUser.items.every((x: any) => (x.username ?? '').toLowerCase().includes(ADMIN.toLowerCase())));
  const qd = await auditQ(`q=${encodeURIComponent('demo-ops')}`);
  check('?q= search (demo-ops)', qd.total > 0);
  const p1a = await http('GET', `/api/audit?from=${encodeURIComponent(t0.toISOString())}&page=1&pageSize=5`, T);
  const p2a = await http('GET', `/api/audit?from=${encodeURIComponent(t0.toISOString())}&page=2&pageSize=5`, T);
  check('audit pagination (page 1 ≠ page 2, same total)', p1a.body.items.length === 5 && p1a.body.total === p2a.body.total && p1a.body.items[0].id !== p2a.body.items[0]?.id);
  const acts = await http('GET', '/api/audit/actions', T);
  check('audit action list includes ours', ['proxy.create', 'library.upload', 'alert_channel.create'].every((a) => acts.body.actions.includes(a)));
  const csv = await http('GET', `/api/audit/export.csv?action=proxy.create&from=${encodeURIComponent(t0.toISOString())}`, T);
  check('audit CSV export: header, x-total-rows, BOM, no secrets', csv.status === 200 && /text\/csv/.test(csv.headers.get('content-type') ?? '') && csv.text.startsWith('﻿时间')
    && Number(csv.headers.get('x-total-rows')) === pcr.total && leaks(csv.text).length === 0, `${csv.status} rows=${csv.headers.get('x-total-rows')} vs ${pcr.total}`);
  const logins = await auditQ('action=auth.login');
  check('logins are audited (no password in detail)', logins.total > 0 && !logins.items.some((x: any) => JSON.stringify(x.detail ?? {}).match(/pass/i)), JSON.stringify(logins.items[0]?.detail));
}
