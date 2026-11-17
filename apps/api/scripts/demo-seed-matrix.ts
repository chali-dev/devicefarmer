/**
 * 媒体矩阵 demo data + verification through the real HTTP API (no mocks; DB access only for the own posts below).
 *
 * Seeds (idempotent, everything recognisable by the `demo` prefix, Instagram only):
 * - 社交号管理: 16 Instagram social accounts (admin + demo-user) in 5 groups, tags, notes, varied statuses.
 * - 账号分析: manual daily stats (30–90 days, deterministic growth curves) for 13 of them, plus up to 10 own posts each
 *   with likes/comments (帖子 tab; written with the refresh's own upsert, the only step that touches the DB directly).
 * - 追踪账号: 10 tracked Instagram accounts (categories, tags, favourites, weekly snapshots, posts).
 * - 评论互动: ~35 manual comments with threads, reply drafts in every review state, 3 templates with 人设 (one public, one demo-user's).
 * - 账号人设: demo-user's fitness accounts → 健身教练 (personal), two admin accounts → 品牌客服 (public).
 * Then verifies filters, RBAC/isolation, logs, batch actions (throw-away `demotmp.*` accounts), exact
 * analytics numbers, tracked deltas, the reply review state machine and in-app notifications.
 * Nothing is sent to Instagram: manual comments always hand replies over to an operator (awaiting_operator).
 *
 * Usage (from apps/api, API running):
 *   npx tsx --env-file=../../.env scripts/demo-seed-matrix.ts           # seed + verify
 *   npx tsx --env-file=../../.env scripts/demo-seed-matrix.ts --clean   # remove the demo data this script creates
 * demo-user: reused when it exists (credentials from var/demo-credentials.txt), else created with a random
 * password written only to that file. --clean keeps the user (other demo seeders share it).
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withCaptcha } from './lib/login.js';

const API = process.env.E2E_API ?? `http://127.0.0.1:${process.env.API_PORT ?? 3000}`;
const CRED_FILE = resolve(dirname(fileURLToPath(import.meta.url)), '../var/demo-credentials.txt');
const DEMO_USER = 'demo-user';
const CLEAN = process.argv.includes('--clean');

const results: [string, boolean][] = [];
const check = (name: string, ok: boolean, detail = '') => { results.push([name, ok]); console.log(`${ok ? '✓' : '✗'} ${name}${detail && !ok ? ` — ${detail.slice(0, 300)}` : ''}`); };

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
async function must<T = any>(method: string, path: string, token: string, body?: unknown, ok = [200, 201, 202, 204]) {
  const r = await http<T>(method, path, token, body);
  if (!ok.includes(r.status)) throw new Error(`${method} ${path} → ${r.status} ${r.text.slice(0, 300)}`);
  return r.body;
}
async function login(username: string, password: string): Promise<string> {
  const r = await http('POST', '/api/auth/login', null, await withCaptcha(API, { username, password }));
  if (r.status !== 200 || !r.body?.token) throw new Error(`login ${username} failed (${r.status})`);
  return r.body.token;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor<T>(label: string, fn: () => Promise<T | null | false | undefined>, ms = 60_000): Promise<T | null> {
  const t0 = Date.now();
  for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() - t0 > ms) { console.log(`  (timeout: ${label})`); return null; } await sleep(500); }
}

// ---------------------------------------------------------------- demo-user credentials
function readDemoPassword(): string | null {
  if (!existsSync(CRED_FILE)) return null;
  const lines = readFileSync(CRED_FILE, 'utf8').split(/\r?\n/);
  const i = lines.findIndex((l) => l.includes(DEMO_USER));
  if (i < 0) return null;
  const same = lines[i]!.match(/password\s*[:=]\s*(\S+)/i) ?? lines[i]!.match(new RegExp(`${DEMO_USER}\\s*[:/,|\\s]\\s*(\\S+)`));
  if (same && !/^password/i.test(same[1]!)) return same[1]!;
  for (const l of lines.slice(i + 1, i + 4)) { const m = l.match(/password\s*[:=]\s*(\S+)/i); if (m) return m[1]!; }
  return null;
}

async function demoUser(admin: string): Promise<{ id: string; token: string; created: boolean }> {
  const find = async () => ((await must('GET', '/api/users', admin)).users as any[]).find((u) => u.username === DEMO_USER);
  let u = await find();
  let created = false;
  if (!u && !existsSync(CRED_FILE)) {
    const password = randomBytes(15).toString('base64url');
    const r = await http('POST', '/api/users', admin, { username: DEMO_USER, password, role: 'user' });
    if (r.status === 201) {
      mkdirSync(dirname(CRED_FILE), { recursive: true });
      try {
        writeFileSync(CRED_FILE, `# local demo accounts (generated, do not commit)\nusername: ${DEMO_USER}\npassword: ${password}\n`, { flag: 'wx', mode: 0o600 });
        console.log(`created user ${DEMO_USER}; password written to ${CRED_FILE}`);
        created = true;
      } catch {
        throw new Error(`${CRED_FILE} appeared while creating ${DEMO_USER}; resolve by hand`);
      }
    }
    u = await find();
  }
  // The other seeder may be creating the user/file right now: wait for both.
  let pw = readDemoPassword();
  for (let i = 0; (!u || !pw) && i < 60; i++) { await sleep(1000); u ??= await find(); pw = readDemoPassword(); }
  if (!u || !pw) throw new Error(`${DEMO_USER} exists but no password in ${CRED_FILE}`);
  return { id: u.id, token: await login(DEMO_USER, pw), created };
}

// ---------------------------------------------------------------- deterministic data
function hashStr(s: string): number { let h = 2166136261; for (const c of s) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }
function rnd(key: string, n: number): number {
  let t = (hashStr(key) ^ Math.imul(n + 1, 2654435761)) >>> 0;
  t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const DAY = 86_400_000;
const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const dayNum = (d: string) => Math.round(Date.parse(`${d}T00:00:00Z`) / DAY);
const TODAY = utcDay(Date.now());
const TODAY_N = dayNum(TODAY);
/** Stats histories end at the anchor (or today, whichever is later) and start at anchor - (days-1); fixed, so re-runs keep the same rows. */
const ANCHOR_N = dayNum('2026-11-17');

type Owner = 'admin' | 'user';
interface AccSpec {
  handle: string; owner: Owner; displayName: string; group: string | null; tags: string[]; notes: string;
  login: 'unknown' | 'logged_in' | 'logged_out' | 'needs_verification'; status: 'active' | 'limited' | 'suspended' | 'disabled'; lastError?: string;
  /** days of stats history (0 = none); f0 followers at the first day; g daily growth; vr views/followers */
  days: number; f0: number; g: number; vr: number;
}
const G = { travel: 'demo · 旅行 Travel', food: 'demo · 美食 Food', fashion: 'demo · 时尚 Fashion', life: 'demo · 生活 Lifestyle', fit: 'demo · 健身 Fitness' };
const ACCOUNTS: AccSpec[] = [
  { handle: 'demo.wanderlust.lena', owner: 'admin', displayName: 'Lena · Wanderlust', group: G.travel, tags: ['travel', 'europe', '主力'], notes: 'demo: 主力旅行号，每周 3 篇图文', login: 'logged_in', status: 'active', days: 90, f0: 18_400, g: 0.0065, vr: 0.32 },
  { handle: 'demo.island.hopper', owner: 'admin', displayName: 'Island Hopper', group: G.travel, tags: ['travel', 'asia'], notes: 'demo: 东南亚海岛', login: 'logged_in', status: 'active', days: 75, f0: 6_200, g: 0.0110, vr: 0.41 },
  { handle: 'demo.roadtrip.max', owner: 'admin', displayName: 'Max on the Road', group: G.travel, tags: ['travel', 'video'], notes: 'demo: 需要短信验证', login: 'needs_verification', status: 'active', lastError: 'demo: 登录时要求短信验证', days: 60, f0: 2_950, g: 0.0042, vr: 0.22 },
  { handle: 'demo.tokyo.bites', owner: 'admin', displayName: 'Tokyo Bites 東京', group: G.food, tags: ['food', 'asia', '主力'], notes: 'demo: 日料探店', login: 'logged_in', status: 'active', days: 90, f0: 42_100, g: 0.0038, vr: 0.18 },
  { handle: 'demo.vegan.kitchen', owner: 'admin', displayName: 'Green Vegan Kitchen', group: G.food, tags: ['food', 'recipes'], notes: 'demo: 账号受限，暂停发布', login: 'logged_in', status: 'limited', days: 45, f0: 9_800, g: -0.0012, vr: 0.09 },
  { handle: 'demo.street.eats.sg', owner: 'admin', displayName: 'Street Eats SG', group: G.food, tags: ['food'], notes: 'demo: 已退出登录', login: 'logged_out', status: 'active', days: 30, f0: 1_240, g: 0.0150, vr: 0.55 },
  { handle: 'demo.minimal.closet', owner: 'admin', displayName: 'Minimal Closet', group: G.fashion, tags: ['fashion', '主力'], notes: 'demo: 极简穿搭', login: 'logged_in', status: 'active', days: 90, f0: 27_600, g: 0.0052, vr: 0.26 },
  { handle: 'demo.vintage.finds', owner: 'admin', displayName: 'Vintage Finds', group: G.fashion, tags: ['fashion', 'vintage'], notes: 'demo: 新号，尚无数据', login: 'unknown', status: 'active', days: 0, f0: 0, g: 0, vr: 0 },
  { handle: 'demo.sneaker.drop', owner: 'admin', displayName: 'Sneaker Drop', group: null, tags: ['fashion', 'test'], notes: 'demo: 被平台封禁（演示）', login: 'logged_in', status: 'suspended', days: 40, f0: 15_300, g: -0.0025, vr: 0.05 },
  { handle: 'demo.brand.backup', owner: 'admin', displayName: 'Brand Backup', group: null, tags: ['backup'], notes: 'demo: 备用号', login: 'unknown', status: 'active', days: 0, f0: 0, g: 0, vr: 0 },
  { handle: 'demo.cozy.home', owner: 'user', displayName: 'Cozy Home 小家', group: G.life, tags: ['lifestyle', 'home'], notes: 'demo: 家居生活', login: 'logged_in', status: 'active', days: 90, f0: 11_900, g: 0.0071, vr: 0.29 },
  { handle: 'demo.plant.parent', owner: 'user', displayName: 'Plant Parent', group: G.life, tags: ['lifestyle', 'plants'], notes: 'demo: 绿植', login: 'logged_in', status: 'active', days: 60, f0: 3_400, g: 0.0124, vr: 0.47 },
  { handle: 'demo.morning.journal', owner: 'user', displayName: 'Morning Journal', group: G.life, tags: ['lifestyle'], notes: 'demo: 需要验证', login: 'needs_verification', status: 'active', days: 35, f0: 860, g: 0.0090, vr: 0.61 },
  { handle: 'demo.fit.with.mia', owner: 'user', displayName: 'Fit with Mia', group: G.fit, tags: ['fitness', '主力'], notes: 'demo: 健身主力号', login: 'logged_in', status: 'active', days: 90, f0: 33_500, g: 0.0058, vr: 0.24 },
  { handle: 'demo.yoga.daily', owner: 'user', displayName: 'Yoga Daily', group: G.fit, tags: ['fitness', 'yoga'], notes: 'demo: 已退出登录', login: 'logged_out', status: 'active', days: 50, f0: 5_100, g: 0.0031, vr: 0.2 },
  { handle: 'demo.run.club.sh', owner: 'user', displayName: 'Run Club Shanghai', group: null, tags: ['fitness', 'running'], notes: 'demo: 受限', login: 'logged_in', status: 'limited', days: 30, f0: 2_200, g: 0.0005, vr: 0.12 },
];
const GROUPS: { name: string; owner: Owner }[] = [
  { name: G.travel, owner: 'admin' }, { name: G.food, owner: 'admin' }, { name: G.fashion, owner: 'admin' },
  { name: G.life, owner: 'user' }, { name: G.fit, owner: 'user' },
];

interface Day { day: string; followers: number; following: number; posts: number; views: number; likes: number; shares: number; comments: number }
/** Deterministic daily stats of an account from its first day through max(anchor, today). */
function series(a: AccSpec): Day[] {
  if (!a.days) return [];
  const first = ANCHOR_N - (a.days - 1);
  const out: Day[] = [];
  for (let n = first; n <= Math.max(ANCHOR_N, TODAY_N) && n <= TODAY_N; n++) {
    const d = n - first;
    const wobble = 1 + 0.003 * Math.sin(d * 0.9 + (hashStr(a.handle) % 7));
    const followers = Math.max(0, Math.round(a.f0 * Math.exp(a.g * d) * wobble + (rnd(a.handle, n) - 0.5) * a.f0 * 0.0015));
    const weekly = 1 + 0.3 * Math.sin((2 * Math.PI * n) / 7 + (hashStr(a.handle) % 5));
    const viral = rnd(`${a.handle}:v`, n) > 0.965 ? 3 + rnd(`${a.handle}:vv`, n) * 3 : 1;
    const views = Math.round(followers * a.vr * weekly * viral * (0.75 + 0.5 * rnd(`${a.handle}:w`, n)));
    const likes = Math.round(views * (0.05 + 0.05 * rnd(`${a.handle}:l`, n)));
    out.push({
      day: utcDay(n * DAY), followers,
      following: 180 + (hashStr(a.handle) % 400) + Math.floor(d / 6),
      posts: 40 + (hashStr(a.handle) % 300) + Math.floor(d / (2 + (hashStr(a.handle) % 3))),
      views, likes,
      shares: Math.round(likes * (0.06 + 0.06 * rnd(`${a.handle}:s`, n))),
      comments: Math.round(likes * (0.03 + 0.04 * rnd(`${a.handle}:c`, n))),
    });
  }
  return out;
}

interface TrackedSpec { input: string; handle: string; owner: Owner; displayName: string; category: string; tags: string[]; favorite: boolean; notes: string; f0: number; g: number }
const TRACKED: TrackedSpec[] = [
  { input: 'https://www.instagram.com/demo.alpine.lens/', handle: 'demo.alpine.lens', owner: 'admin', displayName: 'Alpine Lens', category: '灵感', tags: ['travel', 'photo'], favorite: true, notes: 'demo: 构图参考', f0: 128_000, g: 0.012 },
  { input: '@demo.citybike.diaries', handle: 'demo.citybike.diaries', owner: 'admin', displayName: 'Citybike Diaries', category: '竞品', tags: ['travel'], favorite: false, notes: 'demo: 同类旅行号', f0: 21_500, g: 0.025 },
  { input: 'instagram.com/demo.ramen.radar', handle: 'demo.ramen.radar', owner: 'admin', displayName: 'Ramen Radar', category: '竞品', tags: ['food', 'asia'], favorite: true, notes: 'demo: 东京拉面', f0: 64_300, g: 0.018 },
  { input: '@demo.pastry.lab', handle: 'demo.pastry.lab', owner: 'admin', displayName: 'Pastry Lab', category: '合作候选', tags: ['food'], favorite: false, notes: 'demo: 可谈合作', f0: 9_700, g: 0.04 },
  { input: 'https://www.instagram.com/demo.capsule.wardrobe/', handle: 'demo.capsule.wardrobe', owner: 'admin', displayName: 'Capsule Wardrobe', category: '灵感', tags: ['fashion'], favorite: false, notes: 'demo: 极简穿搭', f0: 210_000, g: 0.006 },
  { input: '@demo.retro.kicks', handle: 'demo.retro.kicks', owner: 'admin', displayName: 'Retro Kicks', category: '竞品', tags: ['fashion', 'sneakers'], favorite: false, notes: 'demo: 粉丝下滑中', f0: 47_800, g: -0.008 },
  { input: '@demo.indie.travel.tips', handle: 'demo.indie.travel.tips', owner: 'admin', displayName: 'Indie Travel Tips', category: '合作候选', tags: ['travel', 'budget'], favorite: false, notes: 'demo', f0: 3_900, g: 0.05 },
  { input: '@demo.homegym.coach', handle: 'demo.homegym.coach', owner: 'user', displayName: 'Homegym Coach', category: '竞品', tags: ['fitness'], favorite: true, notes: 'demo: 居家健身', f0: 88_000, g: 0.015 },
  { input: 'https://www.instagram.com/demo.balcony.garden/', handle: 'demo.balcony.garden', owner: 'user', displayName: 'Balcony Garden', category: '灵感', tags: ['lifestyle', 'plants'], favorite: false, notes: 'demo', f0: 15_200, g: 0.022 },
  { input: '@demo.slow.mornings', handle: 'demo.slow.mornings', owner: 'user', displayName: 'Slow Mornings', category: '灵感', tags: ['lifestyle'], favorite: false, notes: 'demo', f0: 6_600, g: 0.01 },
];
const SNAPSHOT_WEEKS = 8;
/** Weekly snapshots, oldest first (captured at 09:00 UTC, n weeks before the anchor). */
function snapshots(t: TrackedSpec) {
  return Array.from({ length: SNAPSHOT_WEEKS }, (_, i) => {
    const w = i; // weeks since first
    const followers = Math.round(t.f0 * Math.pow(1 + t.g, w) * (1 + (rnd(t.handle, w) - 0.5) * 0.004));
    return {
      capturedAt: new Date((ANCHOR_N - (SNAPSHOT_WEEKS - 1 - i) * 7) * DAY + 9 * 3600_000).toISOString(),
      followers, following: 300 + (hashStr(t.handle) % 700) + w * 2, posts: 200 + (hashStr(t.handle) % 900) + w * 4,
      views: Math.round(followers * 9.5 * (1 + w * 0.05)),
    };
  });
}
const POST_TITLES = ['清晨的第一缕光 ☀️', '这周最受欢迎的一组', '幕后花絮 | Behind the scenes', '收藏级攻略，建议保存', '粉丝问答合集 Q&A', '新系列预告 Coming soon'];

/** 人设 of the reply templates: shared templates may only use a public persona. */
const PERSONAS = [
  { name: 'demo · 品牌客服', owner: 'admin' as Owner, scope: 'public', description: '礼貌、简短，引导私信' },
  { name: 'demo · 健身教练', owner: 'user' as Owner, scope: 'mine', description: null },
];
/** 账号人设: accounts → persona name (personal personas only on their owner's accounts). */
const ACCOUNT_PERSONAS: Record<string, string> = {
  'demo.fit.with.mia': 'demo · 健身教练', 'demo.yoga.daily': 'demo · 健身教练', 'demo.run.club.sh': 'demo · 健身教练',
  'demo.minimal.closet': 'demo · 品牌客服', 'demo.brand.backup': 'demo · 品牌客服',
};
const TEMPLATES = [
  { name: 'demo · 感谢支持', text: '谢谢你的喜欢！我们会继续分享更多内容 🙏', shared: true, tags: ['thanks'], persona: 'demo · 品牌客服' },
  { name: 'demo · 引导私信', text: '感谢关注～具体信息请私信我们，我们会尽快回复你。', shared: true, tags: ['dm'], persona: 'demo · 品牌客服' },
  { name: 'demo · 健身答疑', text: '好问题！建议从每周 3 次、每次 20 分钟开始，循序渐进。', shared: false, tags: ['fitness'], persona: 'demo · 健身教练' },
];

const COMMENTERS = ['Alice Chen', 'Marco Rossi', 'Yuki Tanaka', 'Sofia García', 'Liam O’Brien', 'Priya Nair', '王小雨', 'Jonas Müller', 'Chloé Martin', '李想'];
const COMMENT_TEXTS = [
  '太好看了！这是在哪里拍的？', 'Love this! Saving for my next trip 😍', '请问有详细攻略吗？', 'Wow the colours here are unreal',
  '第一次刷到，已关注', 'Can you share the recipe please?', '这个配色绝了', 'Where did you get that jacket?',
  '每天都在等你更新', 'This made my day 🌞', '有没有新手版本？', 'Absolutely stunning shot',
];
const COMMENT_ACCOUNTS = ['demo.wanderlust.lena', 'demo.island.hopper', 'demo.tokyo.bites', 'demo.minimal.closet', 'demo.sneaker.drop',
  'demo.cozy.home', 'demo.plant.parent', 'demo.fit.with.mia', 'demo.yoga.daily'];

// ---------------------------------------------------------------- main
const ADMIN = await login(process.env.ADMIN_USERNAME!, process.env.ADMIN_PASSWORD!);
const me = (await must('GET', '/api/auth/me', ADMIN).catch(() => null)) as any;
const adminId: string = me?.user?.id ?? me?.id ?? ((await must('GET', '/api/users', ADMIN)).users as any[]).find((u) => u.username === process.env.ADMIN_USERNAME).id;
const DU = await demoUser(ADMIN);
const tokenOf = (o: Owner) => (o === 'admin' ? ADMIN : DU.token);
const ownerIdOf = (o: Owner) => (o === 'admin' ? adminId : DU.id);

async function listAll(path: string, token: string, key = 'items'): Promise<any[]> {
  const out: any[] = [];
  for (let page = 1; ; page++) {
    const b = await must('GET', `${path}${path.includes('?') ? '&' : '?'}page=${page}&pageSize=200`, token);
    out.push(...b[key]);
    if (out.length >= b.total || !b[key].length) return out;
  }
}
const myAccounts = async () => (await listAll('/api/social/accounts?platform=instagram', ADMIN)).filter((a) => ACCOUNTS.some((s) => s.handle === a.handle));
const tmpAccounts = async () => (await listAll('/api/social/accounts?q=demotmp', ADMIN)).filter((a) => a.handle.startsWith('demotmp.'));

// ---------------------------------------------------------------- --clean
if (CLEAN) {
  let n = 0;
  for (const a of [...await myAccounts(), ...await tmpAccounts()]) { await must('DELETE', `/api/social/accounts/${a.id}`, ADMIN); n++; }
  console.log(`deleted ${n} social accounts (with their stats, comments, replies and logs)`);
  const groups = ((await must('GET', '/api/social/groups', ADMIN)).groups as any[])
    .filter((g) => GROUPS.some((s) => s.name === g.name && ownerIdOf(s.owner) === g.userId) || g.name.startsWith('demotmp'));
  for (const g of groups) await must('DELETE', `/api/social/groups/${g.id}`, ADMIN);
  console.log(`deleted ${groups.length} groups`);
  const tracked = (await listAll('/api/tracked-accounts?platform=instagram', ADMIN)).filter((t) => TRACKED.some((s) => s.handle === t.handle && ownerIdOf(s.owner) === t.userId));
  for (const t of tracked) await must('DELETE', `/api/tracked-accounts/${t.id}`, ADMIN);
  console.log(`deleted ${tracked.length} tracked accounts (with snapshots and posts)`);
  const tpls = ((await must('GET', '/api/comment-templates?kind=comment', ADMIN)).templates as any[]).filter((t) => TEMPLATES.some((s) => s.name === t.name) || t.name.startsWith('demotmp'));
  for (const t of tpls) await must('DELETE', `/api/comment-templates/${t.id}`, ADMIN);
  console.log(`deleted ${tpls.length} comment templates`);
  const pers = [...(await must('GET', '/api/personas?scope=public', ADMIN)).personas, ...(await must('GET', `/api/personas?scope=all-users&ownerId=${DU.id}`, ADMIN)).personas]
    .filter((x: any) => PERSONAS.some((s) => s.name === x.name && (s.scope === 'public' ? x.ownerType === 'public' : x.ownerId === DU.id)));
  for (const x of pers) await must('DELETE', `/api/personas/${x.id}`, ADMIN);
  console.log(`deleted ${pers.length} personas`);
  console.log(`kept user ${DEMO_USER} (shared with the other demo seeders) and in-app notifications (no delete endpoint)`);
  process.exit(0);
}

// ---------------------------------------------------------------- seed: groups
const counts = { groups: 0, accounts: 0, statDays: 0, ownPosts: 0, tracked: 0, snapshots: 0, posts: 0, comments: 0, replies: 0, templates: 0, personas: 0 };
const groupId = new Map<string, string>();
for (const o of ['admin', 'user'] as Owner[]) {
  const existing = (await must('GET', '/api/social/groups', tokenOf(o))).groups as any[];
  for (const g of GROUPS.filter((x) => x.owner === o)) {
    let row = existing.find((e) => e.name === g.name && e.userId === ownerIdOf(o));
    if (!row) { row = (await must('POST', '/api/social/groups', tokenOf(o), { name: g.name })).group; counts.groups++; }
    groupId.set(g.name, row.id);
  }
}

// ---------------------------------------------------------------- seed: social accounts
const accByHandle = new Map<string, any>();
for (const a of await myAccounts()) accByHandle.set(a.handle, a);
for (const s of ACCOUNTS) {
  if (accByHandle.has(s.handle)) continue;
  const r = await must('POST', '/api/social/accounts', tokenOf(s.owner), {
    platform: 'instagram', handle: s.handle, displayName: s.displayName, groupId: s.group ? groupId.get(s.group) : null, tags: s.tags,
    notes: s.notes, loginStatus: s.login, accountStatus: s.status === 'suspended' ? 'active' : s.status, lastError: s.lastError ?? null,
  });
  let acc = r.account;
  counts.accounts++;
  if (s.status === 'suspended') {
    // As an operator would: the check found the account suspended (raises account.problem in-app).
    acc = (await must('POST', `/api/social/accounts/${acc.id}/checked`, tokenOf(s.owner), { accountStatus: 'suspended', lastError: 'demo: 平台提示账号已被停用', message: 'demo: 手动检查' })).account;
  } else if (s.login === 'logged_in') {
    acc = (await must('POST', `/api/social/accounts/${acc.id}/checked`, tokenOf(s.owner), { message: 'demo: 手动检查正常' })).account;
  }
  accByHandle.set(s.handle, acc);
}

// ---------------------------------------------------------------- seed: daily stats
for (const s of ACCOUNTS) {
  const want = series(s);
  if (!want.length) continue;
  const acc = accByHandle.get(s.handle)!;
  const have = new Map(((await must('GET', `/api/analytics/accounts/${acc.id}?days=90`, tokenOf(s.owner))).days as any[]).map((d) => [d.day, d]));
  for (const d of want) {
    const h = have.get(d.day);
    if (h && h.source && (['followers', 'following', 'posts', 'views', 'likes', 'shares', 'comments'] as const).every((k) => h[k] === d[k])) continue;
    const { day, ...values } = d;
    await must('POST', `/api/analytics/accounts/${acc.id}/stats`, tokenOf(s.owner), { day, ...values });
    counts.statDays++;
  }
}

// ---------------------------------------------------------------- seed: own posts (帖子 tab)
// Own posts only ever come from the official API (account-stats refresh) and there is no Instagram connection
// here, so this one step writes through the same upsert the refresh uses (DB, not HTTP). No permalinks: a made-up
// instagram.com link would point at nobody's post.
const { upsertAccountPosts } = await import('../src/modules/analytics/analytics.js');
const CAPTIONS = ['demo: 周末出行清单', 'demo: 新品试用', 'demo: 幕后花絮', 'demo: 粉丝问答', 'demo: 本周精选', 'demo: 教程第 3 集', 'demo: 合作预告', 'demo: 日常记录'];
/** Deterministic own posts of an account: one every 3 days back from the anchor, counters scaled by its followers. */
function postsOf(a: AccSpec) {
  if (!a.days) return [];
  const n = Math.min(10, Math.floor(a.days / 3));
  const followers = series(a).at(-1)?.followers ?? a.f0;
  return Array.from({ length: n }, (_, i) => {
    const kind = (hashStr(a.handle) + i) % 3;
    const likes = Math.round(followers * (0.02 + 0.06 * rnd(`${a.handle}:pl`, i)));
    return {
      id: `demo-${a.handle}-${i}`, mediaType: kind === 1 ? 'VIDEO' : kind === 2 ? 'CAROUSEL_ALBUM' : 'IMAGE', productType: kind === 1 ? 'REELS' : 'FEED',
      caption: CAPTIONS[(hashStr(a.handle) + i) % CAPTIONS.length]!, permalink: null,
      publishedAt: new Date((ANCHOR_N - i * 3) * DAY + (9 + (i % 10)) * 3600_000).toISOString(),
      // One post with likes hidden by the owner (the API then returns no like_count).
      likes: i === 4 ? null : likes, comments: Math.round(likes * (0.02 + 0.05 * rnd(`${a.handle}:pc`, i))),
    };
  });
}
for (const s of ACCOUNTS) {
  const want = postsOf(s);
  if (!want.length) continue;
  const r = await upsertAccountPosts(accByHandle.get(s.handle)!.id, 'instagram', want);
  counts.ownPosts += r.inserted;
}

// ---------------------------------------------------------------- seed: tracked accounts
const trackedByHandle = new Map<string, any>();
for (const o of ['admin', 'user'] as Owner[]) {
  for (const t of await listAll('/api/tracked-accounts?platform=instagram', tokenOf(o))) if (t.userId === ownerIdOf(o)) trackedByHandle.set(`${o}:${t.handle}`, t);
}
for (const t of TRACKED) {
  const tok = tokenOf(t.owner);
  let row = trackedByHandle.get(`${t.owner}:${t.handle}`);
  if (!row) {
    row = (await must('POST', '/api/tracked-accounts', tok, {
      input: t.input, platform: 'instagram', displayName: t.displayName, category: t.category, tags: t.tags, favorite: t.favorite, notes: t.notes,
    })).account;
    counts.tracked++;
  }
  const snaps = (await must('GET', `/api/tracked-accounts/${row.id}/snapshots`, tok)).snapshots as any[];
  if (!snaps.length) {
    for (const s of snapshots(t)) { await must('POST', `/api/tracked-accounts/${row.id}/snapshots`, tok, s); counts.snapshots++; }
  }
  const nPosts = 3 + (hashStr(t.handle) % 3);
  for (let i = 0; i < nPosts; i++) {
    const r = await must('POST', `/api/tracked-accounts/${row.id}/posts`, tok, {
      externalId: `demo-${t.handle}-p${i + 1}`, url: `https://www.instagram.com/p/DEMO${(hashStr(t.handle + i) % 1e8).toString(36).toUpperCase()}/`,
      title: POST_TITLES[(hashStr(t.handle) + i) % POST_TITLES.length], publishedAt: new Date((ANCHOR_N - i * 4 - 1) * DAY + 14 * 3600_000).toISOString(),
      views: Math.round(t.f0 * (0.6 + rnd(t.handle, 100 + i))), likes: Math.round(t.f0 * 0.05 * (0.5 + rnd(t.handle, 200 + i))), comments: Math.round(t.f0 * 0.002 * (0.5 + rnd(t.handle, 300 + i))),
    });
    if ((r as any).created) counts.posts++;
  }
  trackedByHandle.set(`${t.owner}:${t.handle}`, row);
}

// ---------------------------------------------------------------- seed: templates
const personaId = new Map<string, string>();
for (const p of PERSONAS) {
  const list = (await must('GET', `/api/personas?scope=${p.scope}`, tokenOf(p.owner))).personas as any[];
  let row = list.find((x) => x.name === p.name);
  if (!row) { row = (await must('POST', '/api/personas', tokenOf(p.owner), { scope: p.scope, name: p.name, description: p.description })).persona; counts.personas++; }
  personaId.set(p.name, row.id);
}
const tplByName = new Map<string, any>();
for (const t of (await must('GET', '/api/comment-templates?kind=comment', ADMIN)).templates as any[]) tplByName.set(t.name, t);
for (const t of TEMPLATES) {
  const tok = t.shared ? ADMIN : DU.token;
  const pid = personaId.get(t.persona)!;
  const have = tplByName.get(t.name);
  if (have) {
    if (have.persona?.id !== pid) tplByName.set(t.name, (await must('PUT', `/api/comment-templates/${have.id}`, tok, { personaId: pid })).template);
    continue;
  }
  tplByName.set(t.name, (await must('POST', '/api/comment-templates', tok, { name: t.name, text: t.text, kind: 'comment', tags: t.tags, personaId: pid, ...(t.shared ? { shared: true } : {}) })).template);
  counts.templates++;
}

// ---------------------------------------------------------------- seed: account personas (账号人设)
for (const [handle, name] of Object.entries(ACCOUNT_PERSONAS)) {
  const acc = accByHandle.get(handle)!;
  const pid = personaId.get(name)!;
  if (acc.personaId === pid) continue;
  const owner = ACCOUNTS.find((x) => x.handle === handle)!.owner;
  accByHandle.set(handle, (await must('PUT', `/api/social/accounts/${acc.id}`, tokenOf(owner), { personaId: pid })).account);
}

// ---------------------------------------------------------------- seed: comments + threads
const commentsOf = async (accId: string, tok: string) => {
  const b = await must('GET', `/api/comments?accountId=${accId}&limit=200`, tok);
  return (b.items as any[]).flatMap((i) => [i, ...i.children]);
};
const commentByExt = new Map<string, any>();
for (const [ai, handle] of COMMENT_ACCOUNTS.entries()) {
  const spec = ACCOUNTS.find((a) => a.handle === handle)!;
  const tok = tokenOf(spec.owner);
  const acc = accByHandle.get(handle)!;
  const have = new Map((await commentsOf(acc.id, tok)).map((c) => [c.externalId, c]));
  const nTop = 3 + (ai % 2);
  for (let i = 0; i < nTop; i++) {
    const ext = `demo:${handle}:c${i + 1}`;
    const post = `demo_post_${handle}_${(i % 2) + 1}`;
    let c = have.get(ext);
    if (!c) {
      const who = COMMENTERS[(ai * 3 + i) % COMMENTERS.length]!;
      c = (await must('POST', '/api/comments', tok, {
        accountId: acc.id, text: COMMENT_TEXTS[(ai * 5 + i) % COMMENT_TEXTS.length], authorName: who,
        authorHandle: `demo_${who.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z]+/g, '_').replace(/^_|_$/g, '') || 'fan'}_${ai}${i}`,
        externalId: ext, externalPostId: post, postUrl: `https://www.instagram.com/p/DEMO${(hashStr(post) % 1e8).toString(36).toUpperCase()}/`,
        publishedAt: new Date(Date.now() - ((ai * 7 + i * 11) % 72 + 1) * 3600_000).toISOString(),
      })).comment;
      counts.comments++;
    }
    commentByExt.set(ext, c);
    // a short thread under the first comment of each account
    if (i === 0) {
      for (let k = 0; k < 1 + (ai % 2); k++) {
        const cext = `${ext}:r${k + 1}`;
        if (have.has(cext)) { commentByExt.set(cext, have.get(cext)); continue; }
        const who = COMMENTERS[(ai + k + 5) % COMMENTERS.length]!;
        commentByExt.set(cext, (await must('POST', '/api/comments', tok, {
          accountId: acc.id, parentId: c.id, text: k === 0 ? '同问！+1' : 'Same question here 👀', authorName: who, externalId: cext,
          publishedAt: new Date(Date.now() - (((ai * 7 + i * 11) % 72 + 1) * 3600_000) + (k + 1) * 600_000).toISOString(), // after the parent, never in the future
        })).comment);
        counts.comments++;
      }
    }
  }
}

// ---------------------------------------------------------------- seed: replies (never sent: manual comments → awaiting_operator)
const latestReply = async (commentId: string, tok: string) => ((await must('GET', `/api/comment-replies?commentId=${commentId}&limit=5`, tok)).items as any[])[0] ?? null;
const tplId = (name: string) => tplByName.get(name)?.id ?? null;
type ReplyPlan = { ext: string; owner: Owner; text: string; tpl?: string; flow: 'draft' | 'pending' | 'approve' | 'reject' | 'cancel' | 'admin-submit' };
const REPLIES: ReplyPlan[] = [
  { ext: 'demo:demo.wanderlust.lena:c1', owner: 'admin', text: '谢谢你的喜欢！这是在多洛米蒂拍的，攻略下周发～', tpl: 'demo · 感谢支持', flow: 'admin-submit' },
  { ext: 'demo:demo.tokyo.bites:c2', owner: 'admin', text: 'Thank you! The recipe is in our story highlights 🍜', flow: 'admin-submit' },
  { ext: 'demo:demo.minimal.closet:c1', owner: 'admin', text: '这件外套是去年秋季款，我们整理一下链接再回复你（草稿）', flow: 'draft' },
  { ext: 'demo:demo.island.hopper:c2', owner: 'admin', text: '感谢关注，海岛攻略整理中（已取消的演示回复）', flow: 'cancel' },
  { ext: 'demo:demo.cozy.home:c1', owner: 'user', text: '谢谢！沙发是二手淘来的，改天写一篇改造记录（草稿）', flow: 'draft' },
  { ext: 'demo:demo.cozy.home:c2', owner: 'user', text: '很高兴你喜欢这个角落，灯具信息我放在置顶评论了～', flow: 'pending' },
  { ext: 'demo:demo.plant.parent:c1', owner: 'user', text: '龟背竹一周浇一次水就够了，记得放在散射光的位置 🌿', flow: 'pending' },
  { ext: 'demo:demo.fit.with.mia:c1', owner: 'user', text: '好问题！新手建议从每周 3 次、每次 20 分钟开始，循序渐进 💪', tpl: 'demo · 健身答疑', flow: 'approve' },
  { ext: 'demo:demo.fit.with.mia:c2', owner: 'user', text: '马上下单我们的训练营，限时 5 折！！！', flow: 'reject' },
  { ext: 'demo:demo.yoga.daily:c1', owner: 'user', text: '感谢关注～课程安排请私信我们，我们会尽快回复你。', tpl: 'demo · 引导私信', flow: 'pending' },
];
for (const p of REPLIES) {
  const c = commentByExt.get(p.ext);
  if (!c) throw new Error(`missing comment ${p.ext}`);
  const tok = tokenOf(p.owner);
  if (await latestReply(c.id, ADMIN)) continue; // already seeded (any state)
  const r = (await must('POST', `/api/comments/${c.id}/replies`, tok, { text: p.text, templateId: p.tpl ? tplId(p.tpl) : null })).reply;
  counts.replies++;
  if (p.flow === 'draft') continue;
  if (p.flow === 'cancel') { await must('POST', `/api/comment-replies/${r.id}/cancel`, tok); continue; }
  await must('POST', `/api/comment-replies/${r.id}/submit`, tok, {});
  if (p.flow === 'approve') await must('POST', `/api/comment-replies/${r.id}/approve`, ADMIN, { note: 'demo: 内容合适，人工回复即可' });
  if (p.flow === 'reject') await must('POST', `/api/comment-replies/${r.id}/reject`, ADMIN, { reason: 'demo: 语气过于营销，请针对评论本身回答' });
}
// A few local comment states for the filters.
for (const [ext, status] of [['demo:demo.tokyo.bites:c3', 'read'], ['demo:demo.sneaker.drop:c2', 'hidden'], ['demo:demo.island.hopper:c3', 'ignored'], ['demo:demo.yoga.daily:c3', 'read']] as const) {
  const c = commentByExt.get(ext);
  const spec = ACCOUNTS.find((a) => ext.includes(a.handle))!;
  if (c && c.status === 'new') await must('PATCH', `/api/comments/${c.id}`, tokenOf(spec.owner), { status });
}
console.log(`seeded (new this run): ${JSON.stringify(counts)}`);

// ================================================================= verification
const tmpTag = randomBytes(3).toString('hex');
const tmpIds: string[] = [];
const tmpGroups: [string, string][] = [];
const tmpTemplates: string[] = [];
const codeOf = (r: { body: any }) => r.body?.code;
try {
  // ---------------------------------------------------------------- platform scope
  {
    const r = await http('GET', '/api/social/platforms', DU.token);
    check('social platforms: only instagram is listed', r.status === 200 && r.body.platforms.map((p: any) => p.id).join() === 'instagram', r.text);
    for (const p of ['youtube', 'tiktok', 'facebook']) {
      const c = await http('POST', '/api/social/accounts', ADMIN, { platform: p, handle: `demotmp.${tmpTag}.${p}` });
      check(`social account on ${p} refused: 400 platform.disabled`, c.status === 400 && codeOf(c) === 'platform.disabled', c.text);
    }
    const lim = await http('PUT', '/api/social/settings', ADMIN, { limits: { youtube: 2 } });
    check('per-device limit for youtube refused: platform.disabled', lim.status === 400 && codeOf(lim) === 'platform.disabled', lim.text);
    for (const [input, platform] of [['https://www.youtube.com/@demotmp', undefined], ['@demotmp', 'tiktok']] as const) {
      const t = await http('POST', '/api/tracked-accounts', ADMIN, { input, platform });
      check(`tracked ${platform ?? 'youtube URL'} refused: platform.disabled`, t.status === 400 && codeOf(t) === 'platform.disabled', t.text);
    }
    const tp = await http('GET', '/api/tracked-accounts/platforms', ADMIN);
    check('tracked platforms: only instagram, manual entry (no API source)', tp.status === 200 && tp.body.platforms.length === 1 && tp.body.platforms[0].id === 'instagram' && tp.body.platforms[0].api === null, tp.text);
  }

  // ---------------------------------------------------------------- social: listing, filters, pagination
  {
    const all = await myAccounts();
    check(`all ${ACCOUNTS.length} demo social accounts present`, all.length === ACCOUNTS.length, `${all.length}`);
    const okSpec = ACCOUNTS.every((s) => {
      const a = all.find((x) => x.handle === s.handle);
      return a && a.userId === ownerIdOf(s.owner) && a.groupName === s.group && a.loginStatus === s.login && a.accountStatus === s.status && a.notes === s.notes
        && a.tags.map((t: string) => t.toLowerCase()).sort().join() === [...s.tags].sort().join() && a.profileUrl === `https://www.instagram.com/${s.handle}/`;
    });
    check('seeded accounts: owner, group, statuses, notes, tags, profile URL as specified', okSpec);
    check('account personas (账号人设) as specified', Object.entries(ACCOUNT_PERSONAS).every(([h, name]) => all.find((x) => x.handle === h)?.personaName === name));
    const coach = await listAll(`/api/social/accounts?personaId=${personaId.get('demo · 健身教练')}`, DU.token);
    check('persona filter (demo-user, 健身教练): the 3 fitness accounts', coach.map((a) => a.handle).sort().join() === ['demo.fit.with.mia', 'demo.run.club.sh', 'demo.yoga.daily'].join(), coach.map((a) => a.handle).join());
    const du = await listAll('/api/social/accounts', DU.token);
    check('demo-user list: only own accounts', du.length > 0 && du.every((a) => a.userId === DU.id) && ACCOUNTS.filter((s) => s.owner === 'user').every((s) => du.some((a) => a.handle === s.handle)), `${du.length}`);
    const own = await http('GET', `/api/social/accounts?ownerId=${DU.id}&pageSize=200`, ADMIN);
    check('admin ownerId filter = demo-user rows', own.status === 200 && own.body.items.every((a: any) => a.userId === DU.id) && own.body.total === du.length);
    const q = await http('GET', '/api/social/accounts?q=WANDERLUST', ADMIN);
    check('search q (case-insensitive handle/display name)', q.body.items.some((a: any) => a.handle === 'demo.wanderlust.lena'));
    const qn = await http('GET', `/api/social/accounts?q=${encodeURIComponent('主力旅行号')}`, ADMIN);
    check('search q matches notes', qn.body.items.length >= 1 && qn.body.items.every((a: any) => a.notes?.includes('主力旅行号')));
    const qt = await http('GET', '/api/social/accounts?q=vintage', ADMIN);
    check('search q matches tags', qt.body.items.some((a: any) => a.handle === 'demo.vintage.finds'));
    const tg = await http('GET', `/api/social/accounts?tags=${encodeURIComponent('FOOD,Asia')}&pageSize=200`, ADMIN);
    const tgMine = tg.body.items.filter((a: any) => ACCOUNTS.some((s) => s.handle === a.handle)).map((a: any) => a.handle);
    check('tags filter: all given tags, case-insensitive', tgMine.join() === 'demo.tokyo.bites', JSON.stringify(tgMine));
    const gf = await http('GET', `/api/social/accounts?groupId=${groupId.get(G.food)}&pageSize=200`, ADMIN);
    check('group filter', gf.body.total === 3 && gf.body.items.every((a: any) => a.groupName === G.food), gf.text.slice(0, 200));
    const ug = await http('GET', `/api/social/accounts?groupId=none&q=demo.&pageSize=200`, ADMIN);
    check('groupId=none filter (ungrouped)', ['demo.sneaker.drop', 'demo.brand.backup', 'demo.run.club.sh'].every((h) => ug.body.items.some((a: any) => a.handle === h)) && ug.body.items.every((a: any) => a.groupId === null));
    const ls = await http('GET', '/api/social/accounts?loginStatus=needs_verification&pageSize=200', ADMIN);
    check('loginStatus filter', ['demo.roadtrip.max', 'demo.morning.journal'].every((h) => ls.body.items.some((a: any) => a.handle === h)) && ls.body.items.every((a: any) => a.loginStatus === 'needs_verification'));
    const as = await http('GET', '/api/social/accounts?accountStatus=limited&pageSize=200', DU.token);
    check('accountStatus filter (demo-user)', as.body.items.map((a: any) => a.handle).join() === 'demo.run.club.sh', as.text.slice(0, 200));
    const ex = await http('GET', `/api/social/accounts?exception=true&ownerId=${adminId}&pageSize=200`, ADMIN);
    const exMine = ex.body.items.filter((a: any) => ACCOUNTS.some((s) => s.handle === a.handle)).map((a: any) => a.handle).sort();
    const exWant = ACCOUNTS.filter((s) => s.owner === 'admin' && (s.login === 'logged_out' || s.login === 'needs_verification' || s.status !== 'active' || s.lastError)).map((s) => s.handle).sort();
    check('exception filter = logged_out/needs_verification/not active/lastError', exMine.join() === exWant.join(), `${exMine} vs ${exWant}`);
    const p1 = await http('GET', '/api/social/accounts?q=demo.&pageSize=5&page=1', ADMIN);
    const p2 = await http('GET', '/api/social/accounts?q=demo.&pageSize=5&page=2', ADMIN);
    const ids1 = p1.body.items.map((a: any) => a.id); const ids2 = p2.body.items.map((a: any) => a.id);
    check('pagination: page size, disjoint pages, same total', ids1.length === 5 && ids2.length === 5 && !ids1.some((i: string) => ids2.includes(i)) && p1.body.total === p2.body.total && p1.body.total >= ACCOUNTS.length);
    const tags = await http('GET', '/api/social/tags', DU.token);
    check('demo-user tag suggestions: own tags only', tags.status === 200 && tags.body.tags.includes('fitness') && !tags.body.tags.includes('europe'), tags.text);
    const grp = await http('GET', '/api/social/groups', DU.token);
    check('demo-user groups: own only, with counts', grp.body.groups.every((g: any) => g.userId === DU.id) && grp.body.groups.find((g: any) => g.name === G.fit)?.count === 2);
    const dev = await http('GET', '/api/social/accounts?instanceId=none&q=demo.&pageSize=200', ADMIN);
    check('device link read-only: demo accounts unlinked (instanceId=none)', ACCOUNTS.every((s) => dev.body.items.some((a: any) => a.handle === s.handle && a.instance === null && a.proxy === null)));
    const sus = all.find((a) => a.handle === 'demo.sneaker.drop');
    check('suspended account: exception flag, lastCheckedAt, lastError', sus.exception === true && !!sus.lastCheckedAt && !!sus.lastError);
  }

  // ---------------------------------------------------------------- social: RBAC / isolation
  {
    const adminAcc = accByHandle.get('demo.tokyo.bites');
    const userAcc = accByHandle.get('demo.cozy.home');
    for (const [m, p, b] of [['GET', `/api/social/accounts/${adminAcc.id}`], ['PUT', `/api/social/accounts/${adminAcc.id}`, { notes: 'x' }], ['GET', `/api/social/accounts/${adminAcc.id}/logs`],
      ['POST', `/api/social/accounts/${adminAcc.id}/checked`, {}], ['DELETE', `/api/social/accounts/${adminAcc.id}`], ['GET', `/api/analytics/accounts/${adminAcc.id}`]] as const) {
      const r = await http(m, p, DU.token, b);
      check(`demo-user ${m} ${p.replace(adminAcc.id, ':adminAccount')} → 404`, r.status === 404, `${r.status}`);
    }
    const b = await http('POST', '/api/social/accounts/batch', DU.token, { ids: [userAcc.id, adminAcc.id], action: 'add-tags', tags: ['x'] });
    check('demo-user batch including another owner\'s account → 404, nothing changed', b.status === 404 && !(await must('GET', `/api/social/accounts/${userAcc.id}`, DU.token)).account.tags.includes('x'));
    const o = await http('POST', '/api/social/accounts', DU.token, { platform: 'instagram', handle: `demotmp.${tmpTag}.forother`, ownerId: adminId });
    check('demo-user cannot create for another owner → 403 social.admin_only', o.status === 403 && codeOf(o) === 'social.admin_only', o.text);
    const g = await http('PUT', `/api/social/accounts/${userAcc.id}`, DU.token, { groupId: groupId.get(G.travel) });
    check('demo-user cannot use admin\'s group → 404 social.group_not_found', g.status === 404 && codeOf(g) === 'social.group_not_found', g.text);
    const dup = await http('POST', '/api/social/accounts', DU.token, { platform: 'instagram', handle: '@DEMO.Tokyo.Bites' });
    check('handle unique per platform across owners (case-insensitive) → 409 social.account_exists', dup.status === 409 && codeOf(dup) === 'social.account_exists', dup.text);
    const s1 = await http('GET', '/api/social/settings', DU.token);
    const s2 = await http('GET', '/api/social/settings', ADMIN);
    check('per-device limits: user 403, admin sees instagram limit', s1.status === 403 && s2.status === 200 && Number.isInteger(s2.body.limits.instagram));
    const fake = await http('PUT', `/api/social/accounts/${userAcc.id}`, DU.token, { instanceId: '00000000-0000-4000-8000-000000000001' });
    check('linking an unknown device → 404 instances.not_found (no link written)', fake.status === 404 && codeOf(fake) === 'instances.not_found', fake.text);
  }

  // ---------------------------------------------------------------- social: edits, logs, mark checked, batch (throw-away accounts)
  {
    const tg = (await must('POST', '/api/social/groups', DU.token, { name: `demotmp-${tmpTag}-A` })).group; tmpGroups.push([tg.id, DU.token]);
    const tg2 = (await must('POST', '/api/social/groups', DU.token, { name: `demotmp-${tmpTag}-B` })).group; tmpGroups.push([tg2.id, DU.token]);
    const mk = async (n: number, tok = DU.token) => {
      const a = (await must('POST', '/api/social/accounts', tok, { platform: 'instagram', handle: `@demotmp.${tmpTag}.${n}`, tags: ['Tmp', 'tmp', 'Batch'], groupId: tok === DU.token ? tg.id : null })).account;
      tmpIds.push(a.id); return a;
    };
    const a1 = await mk(1); const a2 = await mk(2); const a3 = await mk(3);
    check('create: @ stripped, duplicate tags merged case-insensitively', a1.handle === `demotmp.${tmpTag}.1` && a1.tags.length === 2 && a1.loginStatus === 'unknown' && a1.accountStatus === 'active');
    const u = await must('PUT', `/api/social/accounts/${a1.id}`, DU.token, { displayName: 'Temp One', notes: 'demo: edited', loginStatus: 'logged_in', tags: ['tmp', 'edited'] });
    const back = (await must('GET', `/api/social/accounts/${a1.id}`, DU.token)).account;
    check('edit persists (displayName, notes, loginStatus, tags)', back.displayName === 'Temp One' && back.notes === 'demo: edited' && back.loginStatus === 'logged_in' && back.tags.map((t: string) => t.toLowerCase()).sort().join() === 'edited,tmp' && u.account.id === a1.id);
    let logs = (await must('GET', `/api/social/accounts/${a1.id}/logs`, DU.token)).logs as any[];
    check('logs: create + field updates + status + tags (with from → to, actor)', logs.some((l) => l.action === 'create') && logs.some((l) => l.field === 'displayName' && l.toValue === 'Temp One')
      && logs.some((l) => l.action === 'status' && l.field === 'loginStatus' && l.fromValue === 'unknown' && l.toValue === 'logged_in') && logs.some((l) => l.field === 'tags') && logs.every((l) => l.actorName === DEMO_USER));
    const nop = await must('PUT', `/api/social/accounts/${a1.id}`, DU.token, { notes: 'demo: edited' });
    const logs2 = (await must('GET', `/api/social/accounts/${a1.id}/logs`, DU.token)).logs as any[];
    check('unchanged edit writes no log', logs2.length === logs.length && !!nop);
    const unread0 = (await must('GET', '/api/notifications?limit=1', DU.token)).unread as number;
    const ck = (await must('POST', `/api/social/accounts/${a2.id}/checked`, DU.token, { accountStatus: 'suspended', message: 'demo: 检查发现被封' })).account;
    logs = (await must('GET', `/api/social/accounts/${a2.id}/logs`, DU.token)).logs as any[];
    check('mark checked: lastCheckedAt, status change, checked + status logs', !!ck.lastCheckedAt && ck.accountStatus === 'suspended' && ck.exception
      && logs.some((l) => l.action === 'checked' && l.message === 'demo: 检查发现被封') && logs.some((l) => l.action === 'status' && l.toValue === 'suspended'));
    // 告警: account.problem for the owner (and admins)
    const notif = await waitFor('account.problem notification', async () => {
      const n = await must('GET', '/api/notifications?unread=1&limit=50', DU.token);
      return (n.notifications as any[]).find((x) => x.kind === 'account.problem' && x.refId === a2.id);
    }, 10_000);
    check('告警: suspended → account.problem in-app for the owner (unread, warning)', !!notif && notif.severity === 'warning' && notif.readAt === null && notif.params?.reason === 'suspended');
    const adminN = await must('GET', '/api/notifications?unread=1&limit=100', ADMIN);
    check('告警: admins notified too (notifyAdmins)', (adminN.notifications as any[]).some((x) => x.kind === 'account.problem' && x.refId === a2.id));
    if (notif) {
      const unread1 = (await must('GET', '/api/notifications?limit=1', DU.token)).unread as number;
      const mr = await must('POST', `/api/notifications/${notif.id}/read`, DU.token);
      check('告警: mark read → readAt set, unread count -1', !!mr.notification.readAt && mr.unread === unread1 - 1 && unread1 >= unread0 + 1);
      const other = await http('POST', `/api/notifications/${notif.id}/read`, ADMIN);
      check('告警: another user\'s notification → 404', other.status === 404, `${other.status}`);
      // admin's copy of this throw-away alert: mark read (own demo notification)
      const mine = (adminN.notifications as any[]).find((x) => x.kind === 'account.problem' && x.refId === a2.id);
      if (mine) await must('POST', `/api/notifications/${mine.id}/read`, ADMIN);
    }
    const rec = (await must('POST', `/api/social/accounts/${a2.id}/checked`, DU.token, { accountStatus: 'active', loginStatus: 'logged_in' })).account;
    const recN = await waitFor('recovered notification', async () => ((await must('GET', '/api/notifications?unread=1&limit=50', DU.token)).notifications as any[]).find((x) => x.kind === 'account.problem' && x.refId === a2.id && x.recovered), 10_000);
    check('告警: clean check → recovered notification (info)', rec.exception === false && !!recN && recN.severity === 'info');
    if (recN) await must('POST', `/api/notifications/${recN.id}/read`, DU.token);
    const adminRec = ((await must('GET', '/api/notifications?unread=1&limit=100', ADMIN)).notifications as any[]).find((x) => x.refId === a2.id);
    if (adminRec) await must('POST', `/api/notifications/${adminRec.id}/read`, ADMIN);

    // batch
    const mg = await must('POST', '/api/social/accounts/batch', DU.token, { ids: [a1.id, a2.id, a3.id], action: 'move-group', groupId: tg2.id });
    const moved = await Promise.all([a1, a2, a3].map(async (a) => (await must('GET', `/api/social/accounts/${a.id}`, DU.token)).account.groupId));
    logs = (await must('GET', `/api/social/accounts/${a3.id}/logs`, DU.token)).logs as any[];
    check('batch move-group: all moved, changed count, group log', mg.changed === 3 && moved.every((g) => g === tg2.id) && logs.some((l) => l.field === 'group' && l.toValue === tg2.name));
    const at = await must('POST', '/api/social/accounts/batch', DU.token, { ids: [a1.id, a2.id], action: 'add-tags', tags: ['BATCH', 'demo-x'] });
    const t1 = (await must('GET', `/api/social/accounts/${a1.id}`, DU.token)).account.tags as string[];
    check('batch add-tags (case-insensitive merge)', at.changed === 2 && t1.some((t) => t.toLowerCase() === 'batch') && t1.includes('demo-x') && t1.filter((t) => t.toLowerCase() === 'batch').length === 1, JSON.stringify(t1));
    const rt = await must('POST', '/api/social/accounts/batch', DU.token, { ids: [a1.id, a2.id, a3.id], action: 'remove-tags', tags: ['DEMO-X', 'tmp'] });
    const t3 = await Promise.all([a1, a2, a3].map(async (a) => (await must('GET', `/api/social/accounts/${a.id}`, DU.token)).account.tags as string[]));
    check('batch remove-tags (case-insensitive)', rt.changed === 3 && t3.every((t) => !t.some((x) => ['demo-x', 'tmp'].includes(x.toLowerCase()))), JSON.stringify(t3));
    const ga = (await must('POST', '/api/social/accounts', ADMIN, { platform: 'instagram', handle: `demotmp.${tmpTag}.adm` })).account; tmpIds.push(ga.id);
    const mix = await http('POST', '/api/social/accounts/batch', ADMIN, { ids: [a1.id, ga.id], action: 'move-group', groupId: tg.id });
    check('batch move-group across owners → 409 social.group_owner_mismatch', mix.status === 409 && codeOf(mix) === 'social.group_owner_mismatch', mix.text);
    const ngr = await http('POST', '/api/social/accounts/batch', DU.token, { ids: [a1.id], action: 'add-tags' });
    check('batch add-tags without tags → 400', ngr.status === 400);
    const del = await must('POST', '/api/social/accounts/batch', DU.token, { ids: [a2.id, a3.id], action: 'delete' });
    const gone = await http('GET', `/api/social/accounts/${a2.id}`, DU.token);
    check('batch delete', del.count === 2 && gone.status === 404);
    const ren = await must('PUT', `/api/social/groups/${tg2.id}`, DU.token, { name: `demotmp-${tmpTag}-B2` });
    const gl = await must('DELETE', `/api/social/groups/${tg2.id}`, DU.token);
    const a1b = (await must('GET', `/api/social/accounts/${a1.id}`, DU.token)).account;
    logs = (await must('GET', `/api/social/accounts/${a1.id}/logs`, DU.token)).logs as any[];
    check('group rename + delete: account ungrouped, both logged', !!ren && gl === null && a1b.groupId === null && logs.some((l) => l.field === 'group' && l.toValue === `demotmp-${tmpTag}-B2`) && logs.some((l) => l.message === 'group deleted'));
    tmpGroups.splice(tmpGroups.findIndex(([id]) => id === tg2.id), 1);
  }

  // ---------------------------------------------------------------- 账号分析 (exact numbers)
  {
    const want = new Map(ACCOUNTS.map((s) => [s.handle, series(s)]));
    const windowOf = (days: number) => { const from = utcDay((TODAY_N - days + 1) * DAY); return { from, to: TODAY }; };
    const expectRange = (s: AccSpec, days: number) => {
      const rows = want.get(s.handle)!; const { from } = windowOf(days);
      const inW = rows.filter((r) => r.day >= from && r.day <= TODAY);
      if (!inW.length) return { followersGained: null, views: null, likes: null, shares: null, comments: null };
      const before = rows.filter((r) => r.day < from).at(-1);
      const base = before ?? inW[0]!;
      const gained = before || inW.length > 1 ? inW.at(-1)!.followers - base.followers : null;
      const sum = (k: keyof Day) => inW.reduce((a, r) => a + (r[k] as number), 0);
      return { followersGained: gained, views: sum('views'), likes: sum('likes'), shares: sum('shares'), comments: sum('comments') };
    };
    for (const days of [7, 30, 90]) {
      const s = await must('GET', `/api/analytics/summary?days=${days}`, ADMIN);
      const bad: string[] = [];
      for (const spec of ACCOUNTS) {
        const a = (s.accounts as any[]).find((x) => x.handle === spec.handle);
        const e = expectRange(spec, days);
        const latest = want.get(spec.handle)!.at(-1)?.followers ?? null;
        if (!a || (a.latest?.followers ?? null) !== latest || (['followersGained', 'views', 'likes', 'shares', 'comments'] as const).some((k) => a.range[k] !== e[k])) bad.push(`${spec.handle}: ${JSON.stringify(a?.range)} vs ${JSON.stringify(e)}`);
      }
      check(`analytics ${days}d: per-account gains/views/likes/shares/comments + latest followers exact`, !bad.length && s.from === windowOf(days).from && s.to === TODAY && s.days.length === days, bad.join('; '));
      const consistent = (['followersGained', 'views', 'likes', 'shares', 'comments'] as const).every((k) => {
        const byAcc = (s.accounts as any[]).reduce((t, a) => t + (a.range[k] ?? 0), 0);
        const byDay = (s.days as any[]).reduce((t, d) => t + (d[k] ?? 0), 0);
        return byAcc === (s.totals[k] ?? 0) && byDay === (s.totals[k] ?? 0);
      });
      check(`analytics ${days}d: totals = Σ accounts = Σ days (admin, all owners)`, consistent);
    }
    // demo-user scope: exact totals and per-day sums, when every demo-user account is one of ours
    const duSpecs = ACCOUNTS.filter((s) => s.owner === 'user');
    for (const days of [7, 30]) {
      const s = await must('GET', `/api/analytics/summary?days=${days}`, DU.token);
      const foreign = (s.accounts as any[]).filter((a) => !duSpecs.some((x) => x.handle === a.handle));
      const onlyOwn = (s.accounts as any[]).every((a) => a.userId === DU.id);
      // Accounts of demo-user seeded by other scripts: must have no stats in the window for exact sums.
      if (foreign.some((a) => a.latest || Object.values(a.range).some((v) => v !== null))) { check(`analytics demo-user ${days}d: only own accounts (other seeders' stats present, exact sums skipped)`, onlyOwn); continue; }
      const { from } = windowOf(days);
      const expDays = new Map<string, { followersGained: number | null; views: number | null }>();
      for (const spec of duSpecs) {
        const rows = want.get(spec.handle)!;
        rows.forEach((r, i) => {
          if (r.day < from) return;
          const e = expDays.get(r.day) ?? { followersGained: null, views: null };
          if (i > 0) e.followersGained = (e.followersGained ?? 0) + r.followers - rows[i - 1]!.followers;
          e.views = (e.views ?? 0) + r.views;
          expDays.set(r.day, e);
        });
      }
      const dayOk = (s.days as any[]).every((d) => { const e = expDays.get(d.day) ?? { followersGained: null, views: null }; return d.followersGained === e.followersGained && d.views === e.views; });
      const expFollowers = duSpecs.reduce((t, x) => t + (want.get(x.handle)!.at(-1)?.followers ?? 0), 0);
      const expGained = duSpecs.reduce((t, x) => t + (expectRange(x, days).followersGained ?? 0), 0);
      check(`analytics demo-user ${days}d: own accounts only, totals (followers ${expFollowers}, +${expGained}) and per-day sums exact`,
        onlyOwn && dayOk && s.totals.accounts === duSpecs.length + foreign.length && s.totals.withData === duSpecs.filter((x) => x.days).length && s.totals.followers === expFollowers && s.totals.followersGained === expGained,
        JSON.stringify(s.totals));
    }
    // per-account series
    const spec = ACCOUNTS.find((x) => x.handle === 'demo.plant.parent')!;
    const acc = accByHandle.get(spec.handle);
    const ser = await must('GET', `/api/analytics/accounts/${acc.id}?days=30`, DU.token);
    const rows = want.get(spec.handle)!;
    const sOk = ser.days.length === 30 && (ser.days as any[]).every((d) => {
      const i = rows.findIndex((r) => r.day === d.day); const r = rows[i];
      if (!r) return d.source === null;
      return d.source === 'manual' && d.followers === r.followers && d.views === r.views && d.likes === r.likes && d.followersGained === (i > 0 ? r.followers - rows[i - 1]!.followers : null);
    });
    check('per-account series 30d: every day, values + daily gain exact, apiStats flag', sOk && ser.from === windowOf(30).from && typeof ser.apiStats === 'boolean');
    const ref = await http('POST', `/api/analytics/accounts/${acc.id}/refresh`, DU.token);
    check('refresh without platform connection refused (409 analytics.not_connected, no API call)', ref.status === 409 && codeOf(ref) === 'analytics.not_connected', ref.text);
    // delete a day (throw-away account)
    const t = (await must('POST', '/api/social/accounts', DU.token, { platform: 'instagram', handle: `demotmp.${tmpTag}.stats` })).account; tmpIds.push(t.id);
    const d = (k: number) => utcDay((TODAY_N - k) * DAY);
    for (const [k, f, v] of [[3, 1000, 50], [2, 1030, 70], [1, 1100, 90], [0, 1105, 20]] as const) await must('POST', `/api/analytics/accounts/${t.id}/stats`, DU.token, { day: d(k), followers: f, views: v });
    let s7 = ((await must('GET', `/api/analytics/accounts/${t.id}?days=7`, DU.token)).days as any[]);
    const gainOf = (day: string) => s7.find((x) => x.day === day)?.followersGained;
    check('manual stats: daily gains 30/70/5', gainOf(d(2)) === 30 && gainOf(d(1)) === 70 && gainOf(d(0)) === 5);
    await must('POST', `/api/analytics/accounts/${t.id}/stats`, DU.token, { day: d(1), followers: 1100, views: 90 });
    const again = ((await must('GET', `/api/analytics/accounts/${t.id}?days=7`, DU.token)).days as any[]).filter((x) => x.source).length;
    check('same day twice = one row (upsert)', again === 4);
    const dl = await http('DELETE', `/api/analytics/accounts/${t.id}/stats/${d(1)}`, DU.token);
    s7 = ((await must('GET', `/api/analytics/accounts/${t.id}?days=7`, DU.token)).days as any[]);
    check('delete a day: 204, day empty, next gain spans the gap (1105-1030=75)', dl.status === 204 && s7.find((x) => x.day === d(1))?.source === null && gainOf(d(0)) === 75);
    const dl2 = await http('DELETE', `/api/analytics/accounts/${t.id}/stats/${d(1)}`, DU.token);
    check('delete a missing day → 404 analytics.stats_not_found', dl2.status === 404 && codeOf(dl2) === 'analytics.stats_not_found');
    const fut = await http('POST', `/api/analytics/accounts/${t.id}/stats`, DU.token, { day: utcDay((TODAY_N + 1) * DAY), followers: 1 });
    const emp = await http('POST', `/api/analytics/accounts/${t.id}/stats`, DU.token, { day: d(5) });
    check('validation: future day 400 analytics.future_day, empty 400 analytics.stats_empty', codeOf(fut) === 'analytics.future_day' && codeOf(emp) === 'analytics.stats_empty', `${fut.text} ${emp.text}`);
  }

  // ---------------------------------------------------------------- 账号分析 → 帖子 (own posts)
  {
    const spec = ACCOUNTS.find((s) => s.handle === 'demo.fit.with.mia')!;
    const exp = postsOf(spec);
    const acc = accByHandle.get(spec.handle)!;
    const p = await must('GET', `/api/analytics/accounts/${acc.id}/posts?limit=100`, DU.token);
    const sum = (k: 'likes' | 'comments') => exp.reduce((s, x) => s + (x[k] ?? 0), 0);
    check('帖子: demo-user sees the seeded posts of an own account, newest first, exact like/comment totals, hidden likes null',
      p.total === exp.length && p.likes === sum('likes') && p.comments === sum('comments') && p.posts[0].externalId === exp[0]!.id
        && p.posts.find((x: any) => x.externalId === exp[4]!.id)?.likes === null && p.apiPosts === true, JSON.stringify({ total: p.total, likes: p.likes, exp: sum('likes') }));
    const adminAcc = accByHandle.get('demo.tokyo.bites')!;
    const denied = await http('GET', `/api/analytics/accounts/${adminAcc.id}/posts`, DU.token);
    const asAdmin = await http('GET', `/api/analytics/accounts/${acc.id}/posts`, ADMIN);
    check('帖子 RBAC: demo-user on an admin account → 404, admin sees demo-user\'s posts', denied.status === 404 && asAdmin.status === 200 && asAdmin.body.total === exp.length);
    const none = await must('GET', `/api/analytics/accounts/${accByHandle.get('demo.vintage.finds')!.id}/posts`, ADMIN);
    check('帖子: account without stats history has no posts', none.total === 0);
  }

  // ---------------------------------------------------------------- 追踪账号
  {
    const adminT = await listAll('/api/tracked-accounts?platform=instagram', ADMIN);
    const mine = adminT.filter((t) => TRACKED.some((s) => s.handle === t.handle && ownerIdOf(s.owner) === t.userId));
    check(`all ${TRACKED.length} tracked accounts present (admin sees all owners)`, mine.length === TRACKED.length, `${mine.length}`);
    const bad: string[] = [];
    for (const s of TRACKED) {
      const row = mine.find((t) => t.handle === s.handle)!;
      const snaps = snapshots(s);
      const cur = snaps.at(-1)!.followers; const prev = snaps.at(-2)!.followers;
      if (!row || row.followers !== cur || row.followersDelta !== cur - prev || row.followersPrevAt !== snaps.at(-2)!.capturedAt || row.category !== s.category
        || row.tags.join() !== s.tags.join() || row.favorite !== s.favorite || row.profileUrl !== `https://www.instagram.com/${s.handle}/` || row.dataMode !== 'manual_only') {
        bad.push(`${s.handle}: ${row?.followers}/${row?.followersDelta} vs ${cur}/${cur - prev}`);
      }
    }
    check('tracked: URL/@handle normalised, category/tags/favorite, latest followers + delta vs previous snapshot exact, manual_only', !bad.length, bad.join('; '));
    const du = await listAll('/api/tracked-accounts', DU.token);
    check('tracked demo-user: only own rows', du.every((t) => t.userId === DU.id) && TRACKED.filter((s) => s.owner === 'user').every((s) => du.some((t) => t.handle === s.handle)));
    const adm = mine.find((t) => t.handle === 'demo.ramen.radar');
    const iso = await http('GET', `/api/tracked-accounts/${adm.id}`, DU.token);
    const iso2 = await http('GET', `/api/tracked-accounts/${adm.id}/snapshots`, DU.token);
    const iso3 = await http('GET', `/api/tracked-accounts?ownerId=${adminId}`, DU.token);
    check('tracked isolation: other owner\'s row 404, ownerId filter 403', iso.status === 404 && iso2.status === 404 && iso3.status === 403, `${iso.status} ${iso2.status} ${iso3.status}`);
    const cat = await http('GET', `/api/tracked-accounts?category=${encodeURIComponent('竞品')}&ownerId=${adminId}&pageSize=200`, ADMIN);
    check('filter category', cat.body.items.filter((t: any) => t.handle.startsWith('demo.')).map((t: any) => t.handle).sort().join() === TRACKED.filter((s) => s.owner === 'admin' && s.category === '竞品').map((s) => s.handle).sort().join());
    const tag = await http('GET', `/api/tracked-accounts?tag=FOOD&ownerId=${adminId}&pageSize=200`, ADMIN);
    check('filter tag (case-insensitive)', tag.body.items.filter((t: any) => t.handle.startsWith('demo.')).map((t: any) => t.handle).sort().join() === 'demo.pastry.lab,demo.ramen.radar');
    const fav = await http('GET', `/api/tracked-accounts?favorite=true&ownerId=${adminId}&pageSize=200`, ADMIN);
    check('filter favorite', fav.body.items.filter((t: any) => t.handle.startsWith('demo.')).map((t: any) => t.handle).sort().join() === 'demo.alpine.lens,demo.ramen.radar');
    const q = await http('GET', `/api/tracked-accounts?q=${encodeURIComponent('拉面')}`, ADMIN);
    check('search q (notes)', q.body.items.some((t: any) => t.handle === 'demo.ramen.radar'));
    const pg1 = await http('GET', `/api/tracked-accounts?ownerId=${adminId}&pageSize=3&page=1`, ADMIN);
    const pg2 = await http('GET', `/api/tracked-accounts?ownerId=${adminId}&pageSize=3&page=2`, ADMIN);
    check('tracked pagination (favorites first)', pg1.body.items.length === 3 && pg2.body.items.length >= 1 && !pg1.body.items.some((a: any) => pg2.body.items.some((b: any) => b.id === a.id)) && pg1.body.items[0].favorite === true);
    const fac = await http('GET', '/api/tracked-accounts/facets', DU.token);
    check('facets (demo-user): own categories/tags', fac.body.categories.includes('竞品') && fac.body.tags.includes('fitness') && !fac.body.tags.includes('sneakers'), fac.text);
    const dup = await http('POST', '/api/tracked-accounts', ADMIN, { input: 'https://instagram.com/DEMO.Ramen.Radar' });
    check('duplicate (URL vs handle, case-insensitive) → 409 tracked.duplicate', dup.status === 409 && codeOf(dup) === 'tracked.duplicate', dup.text);
    const parse = await http('POST', '/api/tracked-accounts/parse', ADMIN, { input: 'https://www.instagram.com/demo.ramen.radar/?hl=en' });
    check('parse URL → instagram handle', parse.body.profile?.platform === 'instagram' && parse.body.profile?.handle === 'demo.ramen.radar', parse.text);
    const sch = await http('PATCH', `/api/tracked-accounts/${adm.id}`, ADMIN, { refreshIntervalHours: 24 });
    check('schedule for manual-only Instagram refused → 400 tracked.schedule_manual_only', sch.status === 400 && codeOf(sch) === 'tracked.schedule_manual_only', sch.text);
    const snaps = (await must('GET', `/api/tracked-accounts/${adm.id}/snapshots`, ADMIN)).snapshots as any[];
    check('snapshots history oldest first, 8 weekly manual readings', snaps.length === SNAPSHOT_WEEKS && snaps.every((s, i) => i === 0 || s.capturedAt > snaps[i - 1].capturedAt) && snaps.every((s) => s.source === 'manual'));
    const posts = await must('GET', `/api/tracked-accounts/${adm.id}/posts`, ADMIN);
    check('posts listed newest first', posts.total === 3 + (hashStr('demo.ramen.radar') % 3) && posts.posts.every((p: any, i: number) => i === 0 || p.publishedAt <= posts.posts[i - 1].publishedAt));
    const re = await must('POST', `/api/tracked-accounts/${adm.id}/posts`, ADMIN, { externalId: 'demo-demo.ramen.radar-p1' });
    const post1 = (posts.posts as any[]).find((p) => p.externalId === 'demo-demo.ramen.radar-p1');
    check('posts dedupe by external id: 200, values + first_seen_at kept', re.created === false && re.post.views === post1.views && re.post.firstSeenAt === post1.firstSeenAt);
    // throw-away tracked account: snapshot delta + delete
    const tt = (await must('POST', '/api/tracked-accounts', DU.token, { input: `@demotmp.${tmpTag}.t`, platform: 'instagram' })).account;
    await must('POST', `/api/tracked-accounts/${tt.id}/snapshots`, DU.token, { capturedAt: new Date(Date.now() - 2 * DAY).toISOString(), followers: 500 });
    const sn2 = (await must('POST', `/api/tracked-accounts/${tt.id}/snapshots`, DU.token, { followers: 480, views: 10 })).snapshot;
    let ttRow = (await must('GET', `/api/tracked-accounts/${tt.id}`, DU.token)).account;
    const d1 = ttRow.followersDelta;
    await must('DELETE', `/api/tracked-accounts/${tt.id}/snapshots/${sn2.id}`, DU.token);
    ttRow = (await must('GET', `/api/tracked-accounts/${tt.id}`, DU.token)).account;
    const fut = await http('POST', `/api/tracked-accounts/${tt.id}/snapshots`, DU.token, { capturedAt: new Date(Date.now() + DAY).toISOString(), followers: 1 });
    check('tracked delta -20, after deleting latest: 500 with no delta; future snapshot refused', d1 === -20 && ttRow.followers === 500 && ttRow.followersDelta === null && codeOf(fut) === 'tracked.future_time');
    const rf = await http('POST', `/api/tracked-accounts/${tt.id}/refresh`, DU.token);
    check('refresh of manual-only account: 202 manualOnly (no-op task, no external call)', rf.status === 202 && rf.body.manualOnly === true, rf.text);
    if (rf.body?.taskId) {
      const done = await waitFor('tracked-refresh', async () => { const t = await must('GET', `/api/tasks/${rf.body.taskId}`, DU.token); return ['success', 'failed'].includes(t.task?.status) && t.task; }, 20_000);
      check('manual-only refresh task completes as success', done?.status === 'success', JSON.stringify(done)?.slice(0, 200));
    }
    await must('DELETE', `/api/tracked-accounts/${tt.id}`, DU.token);
  }

  // ---------------------------------------------------------------- 评论互动
  {
    const accIds = new Set(ACCOUNTS.map((s) => accByHandle.get(s.handle).id));
    const adminList = await must('GET', '/api/comments?limit=200', ADMIN);
    const threads = (adminList.items as any[]).filter((i) => accIds.has(i.accountId));
    const total = threads.reduce((t, i) => t + 1 + i.children.length, 0);
    check(`comments: ${total} demo comments in ${threads.length} threads, children nested`, total >= 30 && threads.some((t) => t.children.length === 2) && threads.every((t) => t.parentExternalId === null));
    const du = await must('GET', '/api/comments?limit=200', DU.token);
    check('comments demo-user: own accounts only', (du.items as any[]).every((i) => i.userId === DU.id) && (du.items as any[]).length >= 12);
    const adminC = commentByExt.get('demo:demo.tokyo.bites:c1');
    const iso = await http('GET', `/api/comments/${adminC.id}`, DU.token);
    const isoR = await http('POST', `/api/comments/${adminC.id}/replies`, DU.token, { text: 'x' });
    const isoE = await http('POST', '/api/comments', DU.token, { accountId: accByHandle.get('demo.tokyo.bites').id, text: 'x', authorName: 'x' });
    check('comments isolation: other owner\'s comment/reply/entry → 404', iso.status === 404 && isoR.status === 404 && isoE.status === 404, `${iso.status} ${isoR.status} ${isoE.status}`);
    const st = await must('GET', `/api/comments?status=hidden&accountId=${accByHandle.get('demo.sneaker.drop').id}`, ADMIN);
    check('status filter (hidden)', st.items.length === 1 && st.items[0].status === 'hidden');
    const q = await must('GET', `/api/comments?q=${encodeURIComponent('同问')}&limit=200`, ADMIN);
    check('search q matches thread replies', (q.items as any[]).filter((i) => accIds.has(i.accountId)).length === COMMENT_ACCOUNTS.length);
    const det = await must('GET', `/api/comments/${commentByExt.get('demo:demo.fit.with.mia:c1').id}`, DU.token);
    check('comment detail: thread, replies, logs, replyMode manual (manual source)', det.thread.length >= 2 && det.replies.length >= 1 && det.logs.some((l: any) => l.action === 'entered') && det.replyMode.mode === 'manual' && det.replyMode.reason === 'comment.manual_source');
    const posts = await must('GET', `/api/comments/posts?accountId=${accByHandle.get('demo.cozy.home').id}`, DU.token);
    check('posts with comments (filter)', posts.posts.length === 2);
    const sync = await http('POST', `/api/comments/accounts/${accByHandle.get('demo.cozy.home').id}/sync`, DU.token);
    check('API sync refused without a connection (409, no task)', sync.status === 409, sync.text);
    const ca = await must('GET', '/api/comments/accounts', DU.token);
    check('comment accounts (demo-user): own only, read/reply mode manual', (ca.accounts as any[]).every((a) => a.userId === DU.id && a.readMode === 'manual' && a.replyMode === 'manual'));

    // review state machine on seeded data
    const replyOf = async (ext: string, tok: string) => latestReply(commentByExt.get(ext).id, tok);
    const pending = await replyOf('demo:demo.cozy.home:c2', DU.token);
    check('seeded: demo-user reply pending_review (needs approval by someone else)', pending?.status === 'pending_review' && pending.canReview === false && pending.canEdit === true);
    const self = await http('POST', `/api/comment-replies/${pending.id}/approve`, DU.token, {});
    check('self-approval refused → 403 comment.self_approval', self.status === 403 && codeOf(self) === 'comment.self_approval', self.text);
    const selfRej = await http('POST', `/api/comment-replies/${pending.id}/reject`, DU.token, { reason: 'x' });
    check('self-rejection refused → 403', selfRej.status === 403);
    const queue = await must('GET', '/api/comment-replies?reviewable=true&limit=200', ADMIN);
    const queueDu = await must('GET', '/api/comment-replies?reviewable=true&limit=200', DU.token);
    check('review queue: admin sees demo-user\'s pending replies (canReview), demo-user\'s queue excludes own', (queue.items as any[]).filter((r) => r.userId === DU.id).length >= 3
      && (queue.items as any[]).every((r) => r.canReview) && !(queueDu.items as any[]).some((r) => r.authorId === DU.id));
    const approved = await replyOf('demo:demo.fit.with.mia:c1', DU.token);
    const ao = await waitFor('awaiting_operator', async () => { const r = await replyOf('demo:demo.fit.with.mia:c1', DU.token); return r?.status === 'awaiting_operator' && r; }, 30_000);
    check('approved by admin → handed to operator (awaiting_operator, method manual), never sent', !!ao && ao.method === 'manual' && ao.reviewerName === process.env.ADMIN_USERNAME && !ao.sentAt && !!approved.templateId, JSON.stringify(approved)?.slice(0, 200));
    const rej = await replyOf('demo:demo.fit.with.mia:c2', DU.token);
    check('rejected by admin with reason', rej?.status === 'rejected' && !!rej.reviewNote && rej.reviewerName === process.env.ADMIN_USERNAME);
    const draft = await replyOf('demo:demo.cozy.home:c1', DU.token);
    check('draft stays draft, editable', draft?.status === 'draft' && draft.canEdit === true);
    const adm = await waitFor('admin awaiting_operator', async () => { const r = await replyOf('demo:demo.wanderlust.lena:c1', ADMIN); return r?.status === 'awaiting_operator' && r; }, 30_000);
    check('admin reply: approved without review → awaiting_operator', !!adm && adm.reviewNote === 'admin');
    const canc = await replyOf('demo:demo.island.hopper:c2', ADMIN);
    check('cancelled demo reply', canc?.status === 'cancelled');
    const byStatus = (await must('GET', `/api/comment-replies?ownerId=${DU.id}&limit=1`, ADMIN)).byStatus;
    check('reply byStatus counts (demo-user): draft/pending/awaiting/rejected', byStatus.draft >= 1 && byStatus.pending_review >= 3 && byStatus.awaiting_operator >= 1 && byStatus.rejected >= 1, JSON.stringify(byStatus));

    // full flow on throw-away account: draft → edit → submit → reject → new reply → approve → cancel; duplicate rules
    const ta = (await must('POST', '/api/social/accounts', DU.token, { platform: 'instagram', handle: `demotmp.${tmpTag}.cmt` })).account; tmpIds.push(ta.id);
    const mkC = async (n: number) => (await must('POST', '/api/comments', DU.token, { accountId: ta.id, text: `demo tmp comment ${n}`, authorName: 'Tmp Fan', externalPostId: 'demotmp_post' })).comment;
    const c1 = await mkC(1);
    const ext2 = await http('POST', '/api/comments', DU.token, { accountId: ta.id, text: 'dup', authorName: 'x', externalId: c1.externalId });
    check('manual comment: duplicate external id → 409', ext2.status === 409 && codeOf(ext2) === 'comment.duplicate_external_id');
    const ch = await must('POST', '/api/comments', DU.token, { accountId: ta.id, parentId: c1.id, text: 'child', authorName: 'Other Fan' });
    check('thread child inherits parent post id', ch.comment.parentExternalId === c1.externalId && ch.comment.externalPostId === 'demotmp_post');
    let r = (await must('POST', `/api/comments/${c1.id}/replies`, DU.token, { text: 'Thanks a lot for watching!', templateId: tplId('demo · 健身答疑') })).reply;
    check('reply draft created, comment marked read', r.status === 'draft' && (await must('GET', `/api/comments/${c1.id}`, DU.token)).comment.status === 'read');
    const second = await http('POST', `/api/comments/${c1.id}/replies`, DU.token, { text: 'another' });
    check('one active reply per comment → 409 comment.already_replied', second.status === 409 && codeOf(second) === 'comment.already_replied');
    r = (await must('PATCH', `/api/comment-replies/${r.id}`, DU.token, { text: 'Thanks a lot for watching, more soon!' })).reply;
    r = (await must('POST', `/api/comment-replies/${r.id}/submit`, DU.token, {})).reply;
    check('draft → edit → submit → pending_review', r.status === 'pending_review' && r.text === 'Thanks a lot for watching, more soon!');
    const tplShared = tplByName.get('demo · 感谢支持');
    const ut = await http('PUT', `/api/comment-templates/${tplShared.id}`, DU.token, { name: 'hijack' });
    const us = await http('POST', '/api/comment-templates', DU.token, { name: 'demotmp shared', text: 'x', shared: true });
    const tl = await must('GET', '/api/comment-templates', DU.token);
    check('templates: user sees shared + own, cannot edit shared or create shared (403)', ut.status === 403 && us.status === 403
      && (tl.templates as any[]).some((t) => t.name === 'demo · 感谢支持' && t.shared && !t.writable) && (tl.templates as any[]).some((t) => t.name === 'demo · 健身答疑' && t.writable));
    check('templates: persona shown (public on shared, demo-user\'s on private)', (tl.templates as any[]).some((t) => t.name === 'demo · 感谢支持' && t.persona?.name === 'demo · 品牌客服' && t.persona.ownerType === 'public')
      && (tl.templates as any[]).some((t) => t.name === 'demo · 健身答疑' && t.persona?.name === 'demo · 健身教练' && t.persona.ownerId === DU.id));
    const badP = await http('PUT', `/api/comment-templates/${tplShared.id}`, ADMIN, { personaId: personaId.get('demo · 健身教练') });
    check('templates: a shared template cannot use a personal persona (400 persona.not_allowed)', badP.status === 400 && codeOf(badP) === 'persona.not_allowed');
    const tlA = await must('GET', '/api/comment-templates?q=demo', ADMIN);
    check('templates: admin sees demo-user\'s private template too', (tlA.templates as any[]).some((t) => t.name === 'demo · 健身答疑' && t.userId === DU.id));
    const noReason = await http('POST', `/api/comment-replies/${r.id}/reject`, ADMIN, {});
    check('reject without reason → 400', noReason.status === 400);
    r = (await must('POST', `/api/comment-replies/${r.id}/reject`, ADMIN, { reason: 'demo: please be more specific' })).reply;
    const edRej = await http('PATCH', `/api/comment-replies/${r.id}`, DU.token, { text: 'x' });
    check('rejected: no further edit (409 comment.bad_status)', r.status === 'rejected' && edRej.status === 409 && codeOf(edRej) === 'comment.bad_status');
    let r2 = (await must('POST', `/api/comments/${c1.id}/replies`, DU.token, { text: 'Glad you liked it — the full routine is in the caption.', submit: true })).reply;
    check('after rejection a new reply is allowed (submit at once → pending_review)', r2.status === 'pending_review');
    const twice = await http('POST', `/api/comment-replies/${r2.id}/submit`, DU.token, {});
    check('submit twice → 409 comment.bad_status', twice.status === 409 && codeOf(twice) === 'comment.bad_status');
    r2 = (await must('POST', `/api/comment-replies/${r2.id}/approve`, ADMIN, { note: 'demo ok' })).reply;
    const ao2 = await waitFor('tmp awaiting_operator', async () => { const x = (await must('GET', `/api/comment-replies/${r2.id}`, DU.token)); return x.reply.status === 'awaiting_operator' && x; }, 30_000);
    check('approve → task → awaiting_operator (manual hand-over, no platform call), run logged', !!ao2 && ao2.reply.method === 'manual' && ao2.runs.length === 1 && ao2.logs.some((l: any) => l.action === 'handed_over'));
    const reApprove = await http('POST', `/api/comment-replies/${r2.id}/approve`, ADMIN, {});
    check('approve again → 409', reApprove.status === 409);
    const outcomeNoReason = await http('POST', `/api/comment-replies/${r2.id}/outcome`, DU.token, { result: 'failed' });
    check('operator outcome "failed" needs a reason → 400', outcomeNoReason.status === 400 && codeOf(outcomeNoReason) === 'comment.outcome_needs_reason');
    const cr = (await must('POST', `/api/comment-replies/${r2.id}/cancel`, DU.token)).reply;
    check('awaiting_operator → cancel (nothing recorded as sent)', cr.status === 'cancelled' && !cr.sentAt);
    const delBusy = await http('DELETE', `/api/comments/${c1.id}`, DU.token);
    check('delete manual comment (no reply in progress) → 204', delBusy.status === 204);
    // rules: duplicate text (admin replies skip review; they are only handed over, then cancelled)
    const rules = await must('GET', '/api/comments/settings', DU.token);
    const ruleW = await http('PUT', '/api/comments/settings', DU.token, { duplicateMax: 50 });
    check('rules readable by users, writable only by admins (403)', !!rules.rules && ruleW.status === 403 && codeOf(ruleW) === 'comment.admin_only');
    const max = rules.rules.duplicateMax as number;
    const same = 'Thank you so much! (demo duplicate-rule check)';
    const made: any[] = [];
    let blockedCode: string | undefined;
    for (let i = 0; i <= max; i++) {
      const c = await mkC(100 + i);
      const x = await http('POST', `/api/comments/${c.id}/replies`, ADMIN, { text: same, submit: true });
      if (x.status === 201) made.push(x.body.reply); else blockedCode = codeOf(x);
    }
    check(`duplicate-text rule: ${max} identical submits allowed, the next is blocked (comment.duplicate_text)`, made.length === max && blockedCode === 'comment.duplicate_text', `${made.length} ${blockedCode}`);
    const blockLog = (await must('GET', `/api/comments?accountId=${ta.id}&limit=200`, DU.token)).items as any[];
    const lastC = blockLog.find((i) => i.text === `demo tmp comment ${100 + max}`);
    const lastDet = lastC ? await must('GET', `/api/comments/${lastC.id}`, DU.token) : null;
    check('rule block is logged with its code', !!lastDet && lastDet.logs.some((l: any) => l.action === 'blocked' && l.code === 'comment.duplicate_text'));
    for (const m of made) {
      await waitFor('handover', async () => ['awaiting_operator', 'approved', 'scheduled'].includes((await must('GET', `/api/comment-replies/${m.id}`, ADMIN)).reply.status) && true, 15_000);
      await http('POST', `/api/comment-replies/${m.id}/cancel`, ADMIN);
    }
    const leftovers = (await must('GET', `/api/comment-replies?accountId=${ta.id}&status=approved,scheduled,sending,awaiting_operator,sent&limit=50`, ADMIN)).total;
    check('throw-away replies all cancelled, none sent', leftovers === 0, `${leftovers}`);
  }

  // ---------------------------------------------------------------- 告警 on seeded data (read-only)
  {
    const adminN = await must('GET', '/api/notifications?limit=200', ADMIN);
    const sus = accByHandle.get('demo.sneaker.drop');
    check('告警: seeded suspended account has an account.problem notification (admin)', (adminN.notifications as any[]).some((n) => n.kind === 'account.problem' && n.refId === sus.id));
    const duN = await must('GET', '/api/notifications?limit=200', DU.token);
    check('告警: demo-user only gets own notifications', (duN.notifications as any[]).every((n) => n.userId === DU.id));
  }
} catch (err) {
  check('verification ran to the end', false, (err as Error).stack ?? String(err));
} finally {
  for (const id of tmpIds) await http('DELETE', `/api/social/accounts/${id}`, ADMIN);
  for (const [id] of tmpGroups) await http('DELETE', `/api/social/groups/${id}`, ADMIN);
  for (const id of tmpTemplates) await http('DELETE', `/api/comment-templates/${id}`, ADMIN);
  const left = await tmpAccounts();
  for (const a of left) await http('DELETE', `/api/social/accounts/${a.id}`, ADMIN);
}

const failed = results.filter(([, ok]) => !ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed${failed.length ? `; failed: ${failed.map(([n]) => n).join(' | ')}` : ''}`);
process.exit(failed.length ? 1 : 0);
