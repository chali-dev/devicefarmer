import { randomUUID, createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import { and, eq, isNull, ne, sql } from 'drizzle-orm';
import sharp from 'sharp';
import { config } from '../config.js';
import { bannedHits, normaliseStyle, PersonaStyleInput } from '../modules/comments/persona-style.js';
import { analyzeMedia } from '../modules/media/process.js';
import { activeStorage } from '../modules/settings/storage.js';
import { db, schema, sqlClient } from './index.js';

/**
 * Initial data (`npm run db:seed`). Idempotent: a second run changes nothing; existing rows (found by name) are never
 * overwritten, so changes made in the app survive.
 * - the built-in admin ADMIN_USERNAME (password ADMIN_PASSWORD only on creation; ADMIN_RESET_PASSWORD=1 resets it);
 * - the normal user `demo-user`, only when DEMO_USER_PASSWORD is set (password only on creation);
 * - one public media asset 「示例素材」 (an image generated here, stored through the active storage backend with its
 *   thumbnail) in the public media category 「示例」;
 * - three public personas (人设) with a style and 3 范例 each (shared templates).
 * The required apps (Instagram, YouTube) are created once the same way (settings row `seed.requiredApps`).
 * The samples (media + personas) are created once: the settings row `seed.samples` records it, so samples an admin
 * deleted are not re-created by a later seed (deploy.sh runs it on every deploy).
 */

if (!config.ADMIN_PASSWORD) throw new Error('ADMIN_PASSWORD is required to seed the admin user');
const DEMO_USER = 'demo-user';
const log = (m: string) => console.log(m);

// ---------------------------------------------------------------- users
const passwordHash = await bcrypt.hash(config.ADMIN_PASSWORD, 10);
await db.transaction(async (tx) => {
  // Exactly one built-in admin: the configured ADMIN_USERNAME (cannot be deleted, disabled or demoted).
  await tx.update(schema.users).set({ builtin: false }).where(ne(schema.users.username, config.ADMIN_USERNAME));
  await tx.insert(schema.users)
    .values({ username: config.ADMIN_USERNAME, passwordHash, role: 'admin', builtin: true })
    // The password is only set when the account is created: an admin may have changed it in the app.
    // Set ADMIN_RESET_PASSWORD=1 to deliberately reset it to ADMIN_PASSWORD (recovery).
    .onConflictDoUpdate({
      target: schema.users.username,
      set: { role: 'admin', disabled: false, builtin: true, ...(process.env.ADMIN_RESET_PASSWORD === '1' ? { passwordHash } : {}) },
    });
});
log(`admin user "${config.ADMIN_USERNAME}" ready${process.env.ADMIN_RESET_PASSWORD === '1' ? ' (password reset to ADMIN_PASSWORD)' : ''}`);
const [admin] = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.username, config.ADMIN_USERNAME));

const demoPassword = process.env.DEMO_USER_PASSWORD;
if (demoPassword) {
  const made = await db.insert(schema.users)
    .values({ username: DEMO_USER, passwordHash: await bcrypt.hash(demoPassword, 10), role: 'user' })
    .onConflictDoNothing({ target: schema.users.username }).returning({ id: schema.users.id });
  log(made.length ? `user "${DEMO_USER}" created` : `user "${DEMO_USER}" exists (unchanged)`);
} else {
  log(`user "${DEMO_USER}" skipped (DEMO_USER_PASSWORD not set)`);
}

// ---------------------------------------------------------------- 示例素材 (one public image)
const MEDIA_CATEGORY = '示例';
const MEDIA_NAME = '示例素材';

/** A 1080×1080 coffee-coloured illustration (no text: the server may have no CJK fonts). */
function sampleSvg(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1080" viewBox="0 0 1080 1080">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#f3e6d6"/><stop offset="0.55" stop-color="#d9b48f"/><stop offset="1" stop-color="#8a5a3b"/>
    </linearGradient>
    <linearGradient id="cup" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#fffaf3"/><stop offset="1" stop-color="#efe2d1"/>
    </linearGradient>
  </defs>
  <rect width="1080" height="1080" fill="url(#bg)"/>
  <circle cx="860" cy="210" r="150" fill="#ffffff" opacity="0.18"/>
  <circle cx="190" cy="900" r="220" fill="#5b3a26" opacity="0.12"/>
  <ellipse cx="540" cy="800" rx="300" ry="46" fill="#5b3a26" opacity="0.25"/>
  <ellipse cx="540" cy="770" rx="270" ry="40" fill="#fffaf3"/>
  <path d="M330 470 h420 v150 a210 170 0 0 1 -420 0 z" fill="url(#cup)"/>
  <path d="M750 520 a80 80 0 1 1 0 160" fill="none" stroke="#efe2d1" stroke-width="34"/>
  <ellipse cx="540" cy="470" rx="210" ry="34" fill="#6f4e37"/>
  <ellipse cx="540" cy="466" rx="120" ry="16" fill="#c8a27c" opacity="0.7"/>
  <g fill="none" stroke="#fffaf3" stroke-width="16" stroke-linecap="round" opacity="0.85">
    <path d="M470 400 c-30 -40 30 -60 0 -110"/><path d="M540 390 c-30 -40 30 -60 0 -120"/><path d="M610 400 c-30 -40 30 -60 0 -110"/>
  </g>
</svg>`;
}

async function seedMedia(): Promise<void> {
  const C = schema.mediaCategories;
  let [cat] = await db.select({ id: C.id }).from(C).where(and(eq(C.ownerType, 'public'), sql`lower(${C.name}) = lower(${MEDIA_CATEGORY})`));
  if (!cat) {
    [cat] = await db.insert(C).values({ ownerType: 'public', name: MEDIA_CATEGORY, description: '系统自带的示例' }).returning({ id: C.id });
    log(`media category 「${MEDIA_CATEGORY}」 created`);
  }
  const M = schema.mediaAssets;
  const [have] = await db.select({ id: M.id }).from(M).where(and(eq(M.ownerType, 'public'), eq(M.name, MEDIA_NAME), isNull(M.deletedAt)));
  if (have) { log(`media 「${MEDIA_NAME}」 exists (unchanged)`); return; }

  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cp-seed-'));
  try {
    const file = path.join(dir, 'sample.jpg');
    const thumb = path.join(dir, 'thumb.jpg');
    await sharp(Buffer.from(sampleSvg())).jpeg({ quality: 86, mozjpeg: true }).toFile(file);
    const info = await analyzeMedia('image', file, thumb);
    const buf = await fs.promises.readFile(file);
    const thumbSize = (await fs.promises.stat(thumb)).size;
    const storage = await activeStorage();
    const fileKey = `public/images/${randomUUID()}.jpg`;
    const thumbnailKey = `public/thumbnails/${randomUUID()}.jpg`;
    await storage.put(fileKey, file, buf.length, 'image/jpeg');
    await storage.put(thumbnailKey, thumb, thumbSize, 'image/jpeg');
    await db.insert(M).values({
      ownerType: 'public', categoryId: cat!.id, name: MEDIA_NAME, fileName: 'sample.jpg', storage: storage.kind,
      fileKey, thumbnailKey, fileType: 'image', mimeType: 'image/jpeg', fileSize: buf.length, width: info.width, height: info.height,
      checksum: createHash('sha256').update(buf).digest('hex'), status: 'ready', createdBy: admin?.id ?? null,
    });
    log(`media 「${MEDIA_NAME}」 created (${storage.kind} storage, ${info.width}×${info.height}, ${buf.length} bytes)`);
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- 3 public personas with 范例
interface PersonaSeed { name: string; description: string; style: Record<string, unknown>; examples: { name: string; text: string }[] }
const PERSONAS: PersonaSeed[] = [
  {
    name: '咖啡师小林', description: '社区咖啡馆的咖啡师，分享手冲小方法和店里的日常',
    style: {
      topics: ['手冲咖啡', '咖啡豆', '拉花', '咖啡馆日常'], bannedWords: ['最便宜', '包治', '加微信'],
      tone: 'casual', toneNote: '像熟客聊天一样轻松，多用「你」，偶尔分享自己的小失误', emoji: 'medium', length: 'medium',
      hashtags: ['咖啡', '手冲', 'coffeetime'], audience: '喜欢咖啡的城市上班族', notes: '回复评论时一两句就好，先道谢',
    },
    examples: [
      { name: '小林 · 手冲入门', text: '第一次在家手冲，最容易忽略的是水温 🌡️\n我一般用 90–92℃，浅烘的豆子可以再高一点。\n磨豆比冲煮更重要：粗细不对，怎么冲都会苦或者酸。' },
      { name: '小林 · 店里的早晨', text: '早上七点半，店里第一杯是给自己的。\n今天试了新到的埃塞俄比亚豆，柑橘香很明显 🍊\n你们早上会喝咖啡吗，还是先喝水？' },
      { name: '小林 · 回复豆子', text: '这款是浅烘的，酸感明亮，喜欢果香的话会很适合～' },
    ],
  },
  {
    name: '健身教练 Max', description: '健身教练，讲科学训练和不折腾的饮食',
    style: {
      topics: ['力量训练', '减脂饮食', '拉伸恢复'], bannedWords: ['速成', '包瘦', '减肥药'],
      tone: 'pro', toneNote: '直接给方法和理由，少形容词', emoji: 'low', length: 'low',
      hashtags: ['健身', 'fitness'], audience: '刚开始健身的新手', notes: '回复评论时先肯定，再给一个具体建议',
    },
    examples: [
      { name: 'Max · 深蹲要点', text: '深蹲三个要点：脚掌踩稳、膝盖跟脚尖同向、下蹲时保持核心收紧。先把动作做对，再加重量。' },
      { name: 'Max · 训练后吃什么', text: '训练后一小时内吃一份蛋白质加碳水，比如鸡蛋配全麦面包。不用追求完美，稳定最重要。' },
      { name: 'Max · 回复坚持', text: '坚持得很好！下次可以试着把组间休息控制在 90 秒。' },
    ],
  },
  {
    name: '旅行博主小鹿', description: '喜欢城市漫步，分享小众景点和慢节奏的旅行路线',
    style: {
      topics: ['城市漫步', '小众景点', '老街小店', '周末短途'], bannedWords: ['全网最低', '包车联系', '私信下单'],
      tone: 'warm', toneNote: '慢慢讲路上的小发现，像写给朋友的明信片', emoji: 'medium', length: 'medium',
      hashtags: ['城市漫步', '旅行', 'citywalk'], audience: '想在周末出门走走的年轻人', notes: '写清楚怎么去、适合几点去；不编造营业时间和价格',
    },
    examples: [
      { name: '小鹿 · 老街漫步', text: '这条老街只有八百米，我却走了一个下午 🚶‍♀️\n转角的修表铺、二楼的旧书店、门口晒太阳的猫。\n建议下午四点后去，光线最柔和。' },
      { name: '小鹿 · 周末短途', text: '不想走远的周末，就坐地铁到终点站看看。\n这次在终点站旁边发现了一片安静的湖，绕湖一圈刚好一小时 🌿\n你们最近一次说走就走是去了哪里？' },
      { name: '小鹿 · 回复路线', text: '从地铁站出来往北走十分钟就到啦，记得穿双好走的鞋～' },
    ],
  },
];

async function seedPersonas(): Promise<void> {
  const P = schema.personas;
  const T = schema.commentTemplates;
  for (const spec of PERSONAS) {
    const [have] = await db.select({ id: P.id }).from(P).where(and(eq(P.ownerType, 'public'), sql`lower(${P.name}) = lower(${spec.name})`));
    if (have) { log(`persona 「${spec.name}」 exists (unchanged)`); continue; }
    const style = normaliseStyle(PersonaStyleInput.parse(spec.style));
    const hits = bannedHits(style.bannedWords, spec.examples.map((e) => e.text));
    if (hits.length) throw new Error(`persona ${spec.name}: an example contains a banned word (${hits.join(', ')})`);
    await db.transaction(async (tx) => {
      const [p] = await tx.insert(P).values({ ownerType: 'public', name: spec.name, description: spec.description, style, createdBy: admin?.id ?? null }).returning({ id: P.id });
      // Inserted one by one so created_at keeps the spec's order (范例 are listed oldest first).
      for (const e of spec.examples) {
        await tx.insert(T).values({ userId: null, personaId: p!.id, name: e.name, text: e.text, createdBy: admin?.id ?? null, createdAt: sql`clock_timestamp()` });
      }
    });
    log(`persona 「${spec.name}」 created with ${spec.examples.length} examples`);
  }
}
const SAMPLES_KEY = 'seed.samples';
const [samples] = await db.select().from(schema.settings).where(eq(schema.settings.key, SAMPLES_KEY));
if (samples) {
  log('sample media / personas: seeded before (unchanged)');
} else {
  await seedMedia();
  await seedPersonas();
  await db.insert(schema.settings).values({ key: SAMPLES_KEY, value: { at: new Date().toISOString() } }).onConflictDoNothing();
}

// 必装应用 (library/required.ts), once (settings row `seed.requiredApps`, so an entry an admin deleted stays deleted):
// the apps of the owner's list 2026-11-20 with their BitBrowser app-store ids.
const REQUIRED_KEY = 'seed.requiredApps';
const [requiredSeeded] = await db.select().from(schema.settings).where(eq(schema.settings.key, REQUIRED_KEY));
if (requiredSeeded) {
  log('required apps: seeded before (unchanged)');
} else {
  const rows = await db.insert(schema.requiredApps).values([
    { sourceType: 'bitbrowser', package: 'com.instagram.android', name: 'Instagram', storeAppId: '1760185069' },
    { sourceType: 'bitbrowser', package: 'com.google.android.youtube', name: 'YouTube', storeAppId: '437836727' },
  ]).onConflictDoNothing().returning();
  await db.insert(schema.settings).values({ key: REQUIRED_KEY, value: { at: new Date().toISOString() } }).onConflictDoNothing();
  log(`required apps: ${rows.length} created`);
}

await sqlClient.end();
