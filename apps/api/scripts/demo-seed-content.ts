/**
 * Demo data for 内容中心 (素材库 / 话术库 / 内容管理) through the real HTTP API (no DB writes).
 * Everything is named with a `demo` prefix; lookups are by exact name, so a second run creates nothing new.
 * - Logs in as ADMIN_USERNAME / ADMIN_PASSWORD from the env (never printed).
 * - Ensures the normal user `demo-user`; its password is random and written ONLY to var/demo-credentials.txt
 *   (gitignored), never to stdout. If the user exists but the file is missing, the password is reset and rewritten.
 * - Media are generated locally (sharp for JPEG/PNG, ffmpeg for MP4) into var/demo-media/ and uploaded.
 * - var/demo-content-state.json remembers what this script created; --clean removes exactly that
 *   (matched by id AND the exact demo name); demo-user is kept unless --drop-user is also given (and only if this
 *   script created it), because other demo seeds may use demo-user too and deleting a user cascades its data.
 * Usage (from apps/api, API running):
 *   npx tsx --env-file=../../.env scripts/demo-seed-content.ts           # seed (idempotent)
 *   npx tsx --env-file=../../.env scripts/demo-seed-content.ts --clean   # remove the demo data (keeps demo-user)
 *   npx tsx --env-file=../../.env scripts/demo-seed-content.ts --clean --drop-user   # also delete demo-user
 */
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import sharp from 'sharp';

const API = process.env.E2E_API ?? `http://127.0.0.1:${process.env.API_PORT ?? 3000}`;
const VAR = path.resolve('var');
const MEDIA_DIR = path.join(VAR, 'demo-media');
const CRED_FILE = path.join(VAR, 'demo-credentials.txt');
const STATE_FILE = path.join(VAR, 'demo-content-state.json');
const DEMO_USER = 'demo-user';
const FFMPEG = process.env.FFMPEG_PATH ?? 'ffmpeg';
const run = promisify(execFile);

// ---------------------------------------------------------------- spec (exported for the verify script)

export type Owner = 'public' | 'admin' | 'user';
export interface MediaSpec { file: string; owner: Owner; w: number; h: number; color: [string, string]; label: string; category?: string; tags: string[]; secs?: number; disabled?: boolean }
export const CATEGORIES: { name: string; owner: Owner }[] = [
  { name: 'demo 产品图', owner: 'public' },
  { name: 'demo 生活方式', owner: 'public' },
  { name: 'demo 节日活动', owner: 'public' },
  { name: 'demo 待审素材', owner: 'admin' },
  { name: 'demo 我的拍摄', owner: 'user' },
];
export const MEDIA: MediaSpec[] = [
  { file: 'demo-咖啡新品-方图.jpg', owner: 'public', w: 1080, h: 1080, color: ['#6f4e37', '#d9b38c'], label: 'NEW COFFEE', category: 'demo 产品图', tags: ['demo', 'Coffee', '新品'] },
  { file: 'demo-咖啡新品-竖图.jpg', owner: 'public', w: 1080, h: 1350, color: ['#3e2723', '#bcaaa4'], label: 'LATTE 4:5', category: 'demo 产品图', tags: ['demo', 'coffee', 'portrait'] },
  { file: 'demo-耳机-横幅.png', owner: 'public', w: 1600, h: 900, color: ['#263238', '#80cbc4'], label: 'HEADPHONES', category: 'demo 产品图', tags: ['demo', 'Tech'] },
  { file: 'demo-运动鞋-白底.jpg', owner: 'public', w: 1000, h: 1000, color: ['#fafafa', '#ff7043'], label: 'SNEAKER', category: 'demo 产品图', tags: ['demo', 'Fashion', '新品'] },
  { file: 'demo-海边日落.jpg', owner: 'public', w: 1920, h: 1080, color: ['#ff8a65', '#4a148c'], label: 'SUNSET', category: 'demo 生活方式', tags: ['demo', 'Summer', 'travel'] },
  { file: 'demo-城市夜景.jpg', owner: 'public', w: 1080, h: 1920, color: ['#0d1b2a', '#e0aaff'], label: 'CITY NIGHT', category: 'demo 生活方式', tags: ['demo', 'City', 'night'] },
  { file: 'demo-早餐摆拍.png', owner: 'public', w: 1200, h: 1200, color: ['#fff3e0', '#8d6e63'], label: 'BREAKFAST', category: 'demo 生活方式', tags: ['demo', 'food'] },
  { file: 'demo-双十一海报.jpg', owner: 'public', w: 1080, h: 1350, color: ['#b71c1c', '#ffd54f'], label: '11.11', category: 'demo 节日活动', tags: ['demo', 'Promo', '双十一'] },
  { file: 'demo-圣诞倒计时.mp4', owner: 'public', w: 720, h: 1280, color: ['#1b5e20', '#c62828'], label: 'XMAS', category: 'demo 节日活动', tags: ['demo', 'promo', 'christmas'], secs: 5 },
  { file: 'demo-开箱短片.mp4', owner: 'public', w: 1280, h: 720, color: ['#212121', '#90caf9'], label: 'UNBOXING', category: 'demo 产品图', tags: ['demo', 'tech', 'unboxing'], secs: 6 },
  { file: 'demo-旧版LOGO.png', owner: 'public', w: 512, h: 512, color: ['#9e9e9e', '#424242'], label: 'OLD LOGO', tags: ['demo', 'archive'], disabled: true },
  { file: 'demo-admin-草图-01.jpg', owner: 'admin', w: 800, h: 600, color: ['#eceff1', '#546e7a'], label: 'SKETCH', category: 'demo 待审素材', tags: ['demo', 'draft'] },
  { file: 'demo-admin-街拍.mp4', owner: 'admin', w: 1080, h: 1080, color: ['#37474f', '#ffca28'], label: 'STREET', category: 'demo 待审素材', tags: ['demo', 'City'], secs: 4 },
  { file: 'demo-user-自拍-01.jpg', owner: 'user', w: 1080, h: 1350, color: ['#f8bbd0', '#6a1b9a'], label: 'SELFIE', category: 'demo 我的拍摄', tags: ['demo', 'selfie'] },
  { file: 'demo-user-健身打卡.jpg', owner: 'user', w: 1080, h: 1080, color: ['#004d40', '#a5d6a7'], label: 'GYM DAY 1', category: 'demo 我的拍摄', tags: ['demo', 'Fitness', 'GYM'] },
  { file: 'demo-user-午餐.png', owner: 'user', w: 1000, h: 750, color: ['#fff8e1', '#e65100'], label: 'LUNCH', tags: ['demo', 'food'] },
  { file: 'demo-user-跑步vlog.mp4', owner: 'user', w: 720, h: 1280, color: ['#01579b', '#b3e5fc'], label: 'RUN VLOG', category: 'demo 我的拍摄', tags: ['demo', 'fitness', 'vlog'], secs: 5 },
];
export const mediaName = (m: MediaSpec) => m.file.replace(/\.[^.]+$/, '');
/** Favorites of public assets (by file name). */
export const FAVORITES: Record<'admin' | 'user', string[]> = {
  user: ['demo-咖啡新品-方图.jpg', 'demo-海边日落.jpg', 'demo-双十一海报.jpg', 'demo-圣诞倒计时.mp4'],
  admin: ['demo-耳机-横幅.png', 'demo-开箱短片.mp4'],
};

export interface TemplateSpec { name: string; owner: 'shared' | 'admin' | 'user'; kind: 'post' | 'comment'; persona: string | null; tags: string[]; text: string }
export const TEMPLATES: TemplateSpec[] = [
  { name: 'demo 新品上市文案', owner: 'shared', kind: 'post', persona: '品牌官方', tags: ['demo', '新品'], text: '☕ 秋季限定新品上市！丝滑拿铁 + 焦糖风味，到店即享第二杯半价。\n#新品 #咖啡 #秋天的第一杯' },
  { name: 'demo 节日促销文案', owner: 'shared', kind: 'post', persona: '品牌官方', tags: ['demo', 'promo'], text: '🎁 双十一预热开启：全场满 199 减 50，限时 3 天！点击主页链接抢先加购。' },
  { name: 'demo Coffee caption EN', owner: 'shared', kind: 'post', persona: 'Barista Lily', tags: ['demo', 'coffee'], text: 'Monday mood: oat latte, extra foam ☁️ What is your go-to order? #coffeetime #latteart' },
  { name: 'demo 感谢评论', owner: 'shared', kind: 'comment', persona: '客服小助手', tags: ['demo', 'thanks'], text: '谢谢你的喜欢 ❤️ 我们会继续努力带来更多好内容！' },
  { name: 'demo 物流咨询回复', owner: 'shared', kind: 'comment', persona: '客服小助手', tags: ['demo', 'faq'], text: '您好～订单一般 48 小时内发货，发货后可在订单页查看物流信息哦。' },
  { name: 'demo admin 测试草稿', owner: 'admin', kind: 'post', persona: null, tags: ['demo', 'draft'], text: '（草稿）品牌十周年活动文案，待市场部确认。' },
  { name: 'demo admin 差评安抚', owner: 'admin', kind: 'comment', persona: '客服主管', tags: ['demo', 'complaint'], text: '非常抱歉给您带来不好的体验，已私信您处理，请留意消息。' },
  { name: 'demo user 健身日常', owner: 'user', kind: 'post', persona: '健身教练Max', tags: ['demo', 'fitness'], text: '💪 打卡第 30 天：深蹲 5×5，今天比昨天更强一点。#健身 #自律' },
  { name: 'demo user 旅行随笔', owner: 'user', kind: 'post', persona: '旅行博主', tags: ['demo', 'travel'], text: '🌅 海边的日落总是来得刚刚好。下一站，你想看我去哪里？' },
  { name: 'demo user 早安问候', owner: 'user', kind: 'post', persona: '旅行博主', tags: ['demo', 'daily'], text: '早安☀️ 新的一天，从一杯咖啡和一段好音乐开始。' },
  { name: 'demo user 粉丝互动', owner: 'user', kind: 'comment', persona: '健身教练Max', tags: ['demo', 'fans'], text: '加油！坚持就是胜利，有问题随时留言问我～' },
  { name: 'demo user 价格回复', owner: 'user', kind: 'comment', persona: null, tags: ['demo', 'faq'], text: '价格和购买方式请看主页置顶帖哦，谢谢关注！' },
];

export interface ContentSpec { title: string; owner: 'admin' | 'user'; stage: 'draft' | 'ready' | 'archived'; media: string[]; tags: string[]; category: string | null; body: string; caption?: string }
export const CONTENTS: ContentSpec[] = [
  { title: 'demo 新品咖啡上市', owner: 'admin', stage: 'ready', media: ['demo-咖啡新品-方图.jpg', 'demo-咖啡新品-竖图.jpg'], tags: ['demo', 'coffee', '新品'], category: '新品发布', body: '秋季限定拿铁上市，主推两张产品图轮播。', caption: '☕ 秋季限定新品上市！#新品 #咖啡' },
  { title: 'demo 无线耳机开箱', owner: 'admin', stage: 'ready', media: ['demo-开箱短片.mp4', 'demo-耳机-横幅.png'], tags: ['demo', 'Tech'], category: '新品发布', body: '开箱短片 + 横幅，突出降噪和续航。', caption: '🎧 30 小时续航，开箱见真章 #unboxing' },
  { title: 'demo 双十一预热', owner: 'admin', stage: 'draft', media: ['demo-双十一海报.jpg'], tags: ['demo', 'promo'], category: '活动', body: '满 199 减 50，预热期 3 天，文案待定。' },
  { title: 'demo 圣诞倒计时', owner: 'admin', stage: 'draft', media: ['demo-圣诞倒计时.mp4'], tags: ['demo', 'promo', 'christmas'], category: '活动', body: '圣诞倒计时短视频，12 月 1 日起每日一条。', caption: '🎄 Countdown starts now!' },
  { title: 'demo 夏日海边合集', owner: 'admin', stage: 'ready', media: ['demo-海边日落.jpg', 'demo-城市夜景.jpg', 'demo-早餐摆拍.png'], tags: ['demo', 'Summer', 'travel'], category: '生活方式', body: '三图合集：日落、夜景、早餐。', caption: '☀️ Summer memories #travel' },
  { title: 'demo 旧品清仓', owner: 'admin', stage: 'archived', media: ['demo-运动鞋-白底.jpg'], tags: ['demo', 'archive'], category: '活动', body: '上季运动鞋清仓，活动已结束（归档）。' },
  { title: 'demo 品牌故事草稿', owner: 'admin', stage: 'draft', media: [], tags: ['demo'], category: null, body: '十年前，我们在一间 20 平米的小店里烘焙第一批咖啡豆……（品牌故事长文草稿，待补充配图）' },
  { title: 'demo 健身打卡第1天', owner: 'user', stage: 'ready', media: ['demo-user-健身打卡.jpg'], tags: ['demo', 'fitness'], category: '健身', body: '健身打卡系列第一天。', caption: '💪 Day 1 #fitness #gym' },
  { title: 'demo 跑步vlog', owner: 'user', stage: 'draft', media: ['demo-user-跑步vlog.mp4'], tags: ['demo', 'Fitness', 'vlog'], category: '健身', body: '晨跑 5 公里 vlog，待剪辑字幕。' },
  { title: 'demo 周末午餐', owner: 'user', stage: 'ready', media: ['demo-user-午餐.png', 'demo-早餐摆拍.png'], tags: ['demo', 'food'], category: '美食', body: '周末午餐 + 早餐摆拍（公共素材）。', caption: '🍝 Weekend lunch #foodie' },
  { title: 'demo 自拍分享', owner: 'user', stage: 'draft', media: ['demo-user-自拍-01.jpg'], tags: ['demo', 'selfie'], category: null, body: '日常自拍。' },
  { title: 'demo 旅行回顾', owner: 'user', stage: 'archived', media: ['demo-海边日落.jpg'], tags: ['demo', 'travel'], category: '旅行', body: '夏天的旅行回顾（已归档）。' },
  { title: 'demo 早餐灵感', owner: 'user', stage: 'draft', media: ['demo-早餐摆拍.png', 'demo-咖啡新品-方图.jpg'], tags: ['demo', 'food', 'coffee'], category: '美食', body: '早餐灵感合集，使用两张公共素材。' },
];

// ---------------------------------------------------------------- http helpers

export async function http<T = any>(method: string, p: string, token?: string, body?: unknown) {
  const res = await fetch(API + p, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined && !(body instanceof FormData) ? { 'content-type': 'application/json' } : {}) },
    body: body instanceof FormData ? body : body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* 204 / not json */ }
  return { status: res.status, body: json as T, text };
}
export async function login(username: string, password: string): Promise<string> {
  const r = await http('POST', '/api/auth/login', undefined, { username, password });
  if (r.status !== 200 || !r.body?.token) throw new Error(`login ${username} failed: ${r.status} ${r.body?.code ?? ''}`);
  return r.body.token;
}
function must<T = any>(r: { status: number; body: T; text: string }, what: string, ok = [200, 201, 204]) {
  if (!ok.includes(r.status)) throw new Error(`${what}: HTTP ${r.status} ${r.text.slice(0, 300)}`);
  return r.body;
}
export function readCredentials(): { username: string; password: string } | null {
  if (!fs.existsSync(CRED_FILE)) return null;
  const txt = fs.readFileSync(CRED_FILE, 'utf8');
  const u = /^username:\s*(\S+)/m.exec(txt)?.[1]; const p = /^password:\s*(\S+)/m.exec(txt)?.[1];
  return u && p ? { username: u, password: p } : null;
}
interface State { userCreated: boolean; userId?: string; media: string[]; categories: string[]; templates: string[]; contents: string[] }
const loadState = (): State => (fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) : { userCreated: false, media: [], categories: [], templates: [], contents: [] });
const saveState = (s: State) => fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
const addId = (arr: string[], id: string) => { if (!arr.includes(id)) arr.push(id); };

/** All items of a paginated list endpoint. */
export async function listAll(token: string, p: string): Promise<any[]> {
  const out: any[] = [];
  for (let page = 1; ; page++) {
    const r = must(await http('GET', `${p}${p.includes('?') ? '&' : '?'}page=${page}&pageSize=100`, token), `list ${p}`);
    out.push(...r.items);
    if (out.length >= r.total || !r.items.length) return out;
  }
}

// ---------------------------------------------------------------- media generation

async function makeFile(m: MediaSpec): Promise<string> {
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
  const out = path.join(MEDIA_DIR, m.file);
  if (fs.existsSync(out)) return out;
  const fs_ = Math.round(Math.min(m.w, m.h) / 7);
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${m.w}" height="${m.h}">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${m.color[0]}"/><stop offset="1" stop-color="${m.color[1]}"/></linearGradient></defs>
    <rect width="100%" height="100%" fill="url(#g)"/>
    <circle cx="${m.w * 0.78}" cy="${m.h * 0.25}" r="${Math.min(m.w, m.h) * 0.16}" fill="#ffffff" fill-opacity="0.25"/>
    <text x="50%" y="52%" font-family="Helvetica, Arial, sans-serif" font-size="${fs_}" font-weight="bold" fill="#ffffff" fill-opacity="0.92" text-anchor="middle" dominant-baseline="middle">${m.label}</text>
    <text x="50%" y="${m.h - fs_ * 0.6}" font-family="Helvetica, Arial, sans-serif" font-size="${Math.round(fs_ / 3)}" fill="#ffffff" fill-opacity="0.8" text-anchor="middle">DEMO · ${m.w}×${m.h}</text>
  </svg>`);
  if (m.secs) {
    // Still frame from sharp, then a short H.264 clip with a moving zoom so frames differ.
    const still = path.join(MEDIA_DIR, `${m.file}.frame.png`);
    await sharp(svg).png().toFile(still);
    await run(FFMPEG, ['-y', '-loglevel', 'error', '-loop', '1', '-i', still, '-f', 'lavfi', '-i', `sine=frequency=440:duration=${m.secs}`,
      '-vf', `scale=${m.w}:${m.h},zoompan=z='min(zoom+0.0015,1.2)':d=1:s=${m.w}x${m.h}:fps=25,format=yuv420p`,
      '-t', String(m.secs), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '30', '-c:a', 'aac', '-b:a', '64k', '-shortest', '-movflags', '+faststart', out]);
    fs.rmSync(still);
  } else if (m.file.endsWith('.png')) await sharp(svg).png().toFile(out);
  else await sharp(svg).jpeg({ quality: 82 }).toFile(out);
  return out;
}
const mimeOf = (f: string) => (f.endsWith('.png') ? 'image/png' : f.endsWith('.mp4') ? 'video/mp4' : 'image/jpeg');

async function waitReady(token: string, id: string, ms = 120_000) {
  const until = Date.now() + ms;
  for (;;) {
    const r = await http('GET', `/api/media/${id}`, token);
    if (r.status === 200 && r.body.item.status !== 'processing') return r.body.item;
    if (Date.now() > until) throw new Error(`media ${id} still processing after ${ms} ms`);
    await new Promise((res) => setTimeout(res, 500));
  }
}

// ---------------------------------------------------------------- seed

async function ensureUser(T: string, st: State): Promise<{ id: string; token: string }> {
  const users = must(await http('GET', '/api/users', T), 'list users').users as any[];
  let u = users.find((x) => x.username === DEMO_USER);
  let creds = readCredentials();
  if (!u) {
    const password = randomBytes(12).toString('base64url');
    u = must(await http('POST', '/api/users', T, { username: DEMO_USER, password, role: 'user' }), 'create demo-user').user;
    fs.writeFileSync(CRED_FILE, `# Demo normal user for the 内容中心 demo data (created by scripts/demo-seed-content.ts)\nusername: ${DEMO_USER}\npassword: ${password}\n`, { mode: 0o600 });
    st.userCreated = true; st.userId = u.id;
    creds = { username: DEMO_USER, password };
    console.log(`+ user ${DEMO_USER} created (password written to ${path.relative(process.cwd(), CRED_FILE)})`);
  } else if (u.role !== 'user') {
    throw new Error(`${DEMO_USER} exists with role ${u.role}; refusing to use it`);
  } else if (!creds) {
    const password = randomBytes(12).toString('base64url');
    must(await http('PATCH', `/api/users/${u.id}`, T, { password }), 'reset demo-user password');
    fs.writeFileSync(CRED_FILE, `# Demo normal user (password reset by scripts/demo-seed-content.ts)\nusername: ${DEMO_USER}\npassword: ${password}\n`, { mode: 0o600 });
    creds = { username: DEMO_USER, password };
    console.log(`~ user ${DEMO_USER} existed without a credentials file: password reset and written to ${path.relative(process.cwd(), CRED_FILE)}`);
  } else console.log(`= user ${DEMO_USER} exists`);
  if (u.disabled) must(await http('PATCH', `/api/users/${u.id}`, T, { disabled: false }), 'enable demo-user');
  return { id: u.id, token: await login(DEMO_USER, creds.password) };
}

async function seed() {
  const T = await login(process.env.ADMIN_USERNAME!, process.env.ADMIN_PASSWORD!);
  const st = loadState();
  const U = await ensureUser(T, st);
  saveState(st);
  const tok = (o: Owner | 'shared') => (o === 'user' ? U.token : T);
  const counts = { created: 0, existing: 0 };
  const note = (created: boolean) => { counts[created ? 'created' : 'existing']++; };

  // categories
  const catIds = new Map<string, string>();
  for (const c of CATEGORIES) {
    const scope = c.owner === 'public' ? 'public' : 'mine';
    const list = must(await http('GET', `/api/media/categories?scope=${scope}`, tok(c.owner)), 'list categories').categories as any[];
    let row = list.find((x) => x.name === c.name);
    if (!row) row = must(await http('POST', '/api/media/categories', tok(c.owner), { scope, name: c.name }), `create category ${c.name}`).category;
    note(!list.some((x) => x.name === c.name));
    addId(st.categories, row.id); catIds.set(c.name, row.id);
  }
  saveState(st);

  // media
  const existing = {
    public: await listAll(T, '/api/media?scope=public&q=demo-'),
    admin: await listAll(T, '/api/media?scope=mine&q=demo-'),
    user: await listAll(U.token, '/api/media?scope=mine&q=demo-'),
  };
  const mediaIds = new Map<string, string>();
  const fresh: string[] = [];
  for (const m of MEDIA) {
    const name = mediaName(m);
    let item = existing[m.owner].find((x) => x.name === name);
    if (!item) {
      const file = await makeFile(m);
      const fd = new FormData();
      fd.append('scope', m.owner === 'public' ? 'public' : 'mine');
      if (m.category) fd.append('categoryId', catIds.get(m.category)!);
      fd.append('file', new Blob([new Uint8Array(fs.readFileSync(file))], { type: mimeOf(m.file) }), m.file);
      item = must(await http('POST', '/api/media/upload', tok(m.owner), fd), `upload ${m.file}`).item;
      fresh.push(item.id);
    }
    note(!fresh.includes(item.id) ? false : true);
    addId(st.media, item.id); mediaIds.set(m.file, item.id);
  }
  saveState(st);
  for (const m of MEDIA) {
    const id = mediaIds.get(m.file)!;
    const item = await waitReady(tok(m.owner), id);
    const wantStatus = m.disabled ? 'disabled' : 'ready';
    const sameTags = JSON.stringify([...item.tags].map((x: string) => x.toLowerCase()).sort()) === JSON.stringify([...new Set(m.tags.map((x) => x.toLowerCase()))].sort());
    if (!sameTags) must(await http('PUT', `/api/media/${id}`, tok(m.owner), { tags: m.tags }), `tag ${m.file}`);
    if (item.status === 'failed') console.log(`! ${m.file}: processing failed (${item.error ?? item.lastError ?? ''})`);
    else if (item.status !== wantStatus && m.owner === 'public') must(await http('PUT', `/api/media/${id}`, T, { status: wantStatus }), `status ${m.file}`);
  }
  for (const [who, files] of Object.entries(FAVORITES) as ['admin' | 'user', string[]][]) {
    for (const f of files) must(await http('POST', `/api/media/${mediaIds.get(f)}/favorite`, tok(who)), `favorite ${f}`);
  }

  // templates
  const tplLists = { admin: must(await http('GET', '/api/comment-templates?kind=all&q=demo', T), 'templates').templates as any[], user: must(await http('GET', '/api/comment-templates?kind=all&scope=own&q=demo', U.token), 'templates').templates as any[] };
  for (const t of TEMPLATES) {
    const pool = t.owner === 'user' ? tplLists.user : tplLists.admin;
    let row = pool.find((x) => x.name === t.name && (t.owner === 'shared' ? x.shared : t.owner === 'admin' ? !x.shared && x.userId !== U.id : x.userId === U.id));
    note(!row);
    if (!row) row = must(await http('POST', '/api/comment-templates', tok(t.owner), { name: t.name, text: t.text, kind: t.kind, persona: t.persona, tags: t.tags, shared: t.owner === 'shared' || undefined }), `template ${t.name}`).template;
    addId(st.templates, row.id);
  }
  saveState(st);

  // contents
  const contentLists = { admin: await listAll(T, '/api/contents?q=demo'), user: await listAll(U.token, '/api/contents?q=demo') };
  for (const c of CONTENTS) {
    const pool = c.owner === 'user' ? contentLists.user : contentLists.admin.filter((x) => x.userId !== U.id);
    let row = pool.find((x) => x.title === c.title);
    note(!row);
    if (!row) {
      row = must(await http('POST', '/api/contents', tok(c.owner), {
        title: c.title, body: c.body, category: c.category, tags: c.tags, mediaIds: c.media.map((f) => mediaIds.get(f)!),
        platformHints: c.caption ? { instagram: { caption: c.caption } } : {}, stage: c.stage === 'archived' ? 'ready' : c.stage,
      }), `content ${c.title}`).content;
      if (c.stage === 'archived') row = must(await http('PUT', `/api/contents/${row.id}`, tok(c.owner), { stage: 'archived' }), `archive ${c.title}`).content;
    }
    addId(st.contents, row.id);
  }
  saveState(st);

  console.log(`\nseed done: ${counts.created} created, ${counts.existing} already present`);
  console.log(`  categories ${CATEGORIES.length} · media ${MEDIA.length} (public ${MEDIA.filter((m) => m.owner === 'public').length}, admin private ${MEDIA.filter((m) => m.owner === 'admin').length}, ${DEMO_USER} private ${MEDIA.filter((m) => m.owner === 'user').length})`);
  console.log(`  templates ${TEMPLATES.length} (shared ${TEMPLATES.filter((t) => t.owner === 'shared').length}, admin ${TEMPLATES.filter((t) => t.owner === 'admin').length}, ${DEMO_USER} ${TEMPLATES.filter((t) => t.owner === 'user').length}) · contents ${CONTENTS.length} (admin ${CONTENTS.filter((c) => c.owner === 'admin').length}, ${DEMO_USER} ${CONTENTS.filter((c) => c.owner === 'user').length})`);
  console.log(`  ${DEMO_USER} credentials: ${path.relative(process.cwd(), CRED_FILE)}`);
}

// ---------------------------------------------------------------- clean

async function clean() {
  const T = await login(process.env.ADMIN_USERNAME!, process.env.ADMIN_PASSWORD!);
  const st = loadState();
  const titles = new Set(CONTENTS.map((c) => c.title)); const tnames = new Set(TEMPLATES.map((t) => t.name));
  const mnames = new Set(MEDIA.map(mediaName)); const cnames = new Set(CATEGORIES.map((c) => c.name));
  let n = 0;
  const del = async (p: string, what: string) => { const r = await http('DELETE', p, T); if (r.status === 204) n++; else if (r.status !== 404) console.log(`! ${what}: HTTP ${r.status} ${r.text.slice(0, 200)}`); };
  for (const id of st.contents) {
    const r = await http('GET', `/api/contents/${id}`, T);
    if (r.status === 200 && titles.has(r.body.content.title)) await del(`/api/contents/${id}`, `content ${id}`);
  }
  for (const id of st.templates) {
    const all = must(await http('GET', '/api/comment-templates?kind=all&q=demo', T), 'templates').templates as any[];
    const t = all.find((x) => x.id === id);
    if (t && tnames.has(t.name)) await del(`/api/comment-templates/${id}`, `template ${id}`);
  }
  for (const id of st.media) {
    const r = await http('GET', `/api/media/${id}`, T);
    if (r.status === 200 && mnames.has(r.body.item.name)) await del(`/api/media/${id}`, `media ${id}`);
  }
  const cats = [
    ...must(await http('GET', '/api/media/categories?scope=public', T), 'cats').categories,
    ...must(await http('GET', '/api/media/categories?scope=mine', T), 'cats').categories,
    ...(st.userId ? must(await http('GET', `/api/media/categories?scope=mine&ownerId=${st.userId}`, T), 'cats').categories : []),
  ] as any[];
  for (const id of st.categories) if (cats.some((c) => c.id === id && cnames.has(c.name))) await del(`/api/media/categories/${id}`, `category ${id}`);
  // demo-user may also own other agents'/scripts' demo data (deleting a user cascades it), so it is only removed on request.
  if (!process.argv.includes('--drop-user')) console.log(`= ${DEMO_USER} kept (pass --drop-user as well to delete it and everything it owns)`);
  else if (st.userCreated && st.userId) {
    const users = must(await http('GET', '/api/users', T), 'users').users as any[];
    if (users.some((u) => u.id === st.userId && u.username === DEMO_USER)) await del(`/api/users/${st.userId}`, DEMO_USER);
    fs.rmSync(CRED_FILE, { force: true });
  } else if (!st.userCreated) console.log(`= ${DEMO_USER} was not created by this script; left in place`);
  if (process.argv.includes('--drop-user') || !st.userCreated) fs.rmSync(STATE_FILE, { force: true });
  else saveState({ userCreated: true, userId: st.userId, media: [], categories: [], templates: [], contents: [] });
  fs.rmSync(MEDIA_DIR, { recursive: true, force: true });
  console.log(`clean done: ${n} objects deleted`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  (process.argv.includes('--clean') ? clean() : seed()).catch((e) => { console.error('✗', (e as Error).message); process.exit(1); });
}
