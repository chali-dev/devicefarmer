/**
 * Two test personas (人设) for the new persona form (owner decision 2026-11-18: persona + post/reply style in one
 * place; migration 0036 wiped every persona), through the real HTTP API (no DB writes):
 * - 「咖啡师小林」 public persona (admin-managed), 「健身教练 Max」 personal persona of `demo-user`;
 * - each with 定位, a filled style (tone + note, emoji, length, topics, banned words, hashtags, audience, opening/closing)
 *   and 2 post examples + 2 reply examples (话术库 templates with the persona: shared for the public one, demo-user's
 *   private ones for Max, created by the admin with `ownerId`). AI drafts stay off.
 * Idempotent: personas are found by exact name and scope, examples by persona + kind + exact text; a second run creates
 * nothing and resets the style to the spec. `--clean` removes exactly these personas and their example templates.
 * demo-user must exist (scripts/demo-seed-content.ts creates it); without it only the public persona is seeded.
 * Logs in as ADMIN_USERNAME / ADMIN_PASSWORD (never printed). Not run automatically.
 * Usage (from apps/api, API running):
 *   npx tsx --env-file=../../.env scripts/demo-seed-personas.ts           # seed (idempotent)
 *   npx tsx --env-file=../../.env scripts/demo-seed-personas.ts --clean   # remove them
 */
import { withCaptcha } from './lib/login.js';

const API = process.env.E2E_API ?? `http://127.0.0.1:${process.env.API_PORT ?? 3000}`;
const DEMO_USER = 'demo-user';

interface PersonaSpec {
  name: string; owner: 'public' | 'user'; description: string; style: Record<string, unknown>;
  posts: { name: string; text: string }[]; replies: { name: string; text: string }[];
}
export const PERSONAS: PersonaSpec[] = [
  {
    name: '咖啡师小林', owner: 'public', description: '社区咖啡馆的咖啡师，分享手冲和咖啡馆的日常',
    style: {
      tone: 'casual', toneNote: '像熟客聊天一样轻松，多用「你」，偶尔分享自己的小失误', emoji: 'medium', length: 'medium',
      topics: ['手冲咖啡', '咖啡豆', '拉花', '咖啡馆日常'], bannedWords: ['最便宜', '包治', '加微信'],
      hashtags: ['咖啡', '手冲', 'coffeetime'], audience: '喜欢咖啡的城市上班族', closing: '今天你喝了什么？☕',
    },
    posts: [
      { name: '小林 · 手冲入门', text: '第一次在家手冲，最容易忽略的是水温 🌡️\n我一般用 90–92℃，浅烘的豆子可以再高一点。\n磨豆比冲煮更重要：粗细不对，怎么冲都会苦或者酸。' },
      { name: '小林 · 店里的早晨', text: '早上七点半，店里第一杯是给自己的。\n今天试了新到的埃塞俄比亚豆，柑橘香很明显 🍊\n你们早上会喝咖啡吗，还是先喝水？' },
    ],
    replies: [
      { name: '小林 · 回复谢谢', text: '谢谢你喜欢！下次来店里记得跟我说一声 ☕' },
      { name: '小林 · 回复豆子', text: '这款是浅烘的，酸感明亮，喜欢果香的话会很适合～' },
    ],
  },
  {
    name: '健身教练 Max', owner: 'user', description: '健身教练，讲科学训练和不折腾的饮食',
    style: {
      tone: 'pro', toneNote: '直接给方法和理由，少形容词', emoji: 'low', length: 'low',
      topics: ['力量训练', '减脂饮食', '拉伸恢复'], bannedWords: ['速成', '包瘦', '减肥药'],
      hashtags: ['健身', 'fitness'], audience: '刚开始健身的新手', opening: 'Max 教练小课堂：',
    },
    posts: [
      { name: 'Max · 深蹲要点', text: '深蹲三个要点：脚掌踩稳、膝盖跟脚尖同向、下蹲时保持核心收紧。先把动作做对，再加重量。' },
      { name: 'Max · 训练后吃什么', text: '训练后一小时内吃一份蛋白质加碳水，比如鸡蛋配全麦面包。不用追求完美，稳定最重要。' },
    ],
    replies: [
      { name: 'Max · 回复坚持', text: '坚持得很好！下次可以试着把组间休息控制在 90 秒。' },
      { name: 'Max · 回复动作', text: '动作视频可以发我看看，先别急着加重量。' },
    ],
  },
];

async function http<T = any>(method: string, p: string, token: string, body?: unknown) {
  const res = await fetch(API + p, { method, headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* 204 */ }
  return { status: res.status, body: json as T, text };
}
function must<T = any>(r: { status: number; body: T; text: string }, what: string, ok = [200, 201, 202, 204]): T {
  if (!ok.includes(r.status)) throw new Error(`${what}: HTTP ${r.status} ${r.text.slice(0, 300)}`);
  return r.body;
}
async function login(): Promise<string> {
  const r = await fetch(`${API}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(await withCaptcha(API, { username: process.env.ADMIN_USERNAME!, password: process.env.ADMIN_PASSWORD! })),
  });
  if (!r.ok) throw new Error(`admin login failed: HTTP ${r.status}`);
  return (await r.json()).token;
}

/** The persona with this exact name in its scope (public, or demo-user's), or undefined. */
async function find(T: string, spec: PersonaSpec, userId: string | null) {
  const q = spec.owner === 'public' ? 'scope=public' : `scope=all-users&ownerId=${userId}`;
  return (must(await http('GET', `/api/personas?${q}`, T), 'list personas').personas as any[]).find((p) => p.name === spec.name);
}

export async function seedPersonas(clean = false): Promise<{ personas: string[]; created: number; examples: number }> {
  const T = await login();
  const users = must(await http('GET', '/api/users', T), 'list users').users as any[];
  const demo = users.find((u) => u.username === DEMO_USER && u.role === 'user');
  const out = { personas: [] as string[], created: 0, examples: 0 };
  for (const spec of PERSONAS) {
    if (spec.owner === 'user' && !demo) { console.log(`- ${spec.name}: ${DEMO_USER} does not exist (run scripts/demo-seed-content.ts first), skipped`); continue; }
    const userId = spec.owner === 'user' ? demo.id as string : null;
    let p = await find(T, spec, userId);
    if (clean) {
      if (!p) { console.log(`= ${spec.name}: not there`); continue; }
      const d = must(await http('GET', `/api/personas/${p.id}`, T), 'persona detail');
      const ex = [...d.examples.post, ...d.examples.comment] as any[];
      for (const e of ex) must(await http('DELETE', `/api/comment-templates/${e.id}`, T), `delete example ${e.name}`);
      must(await http('DELETE', `/api/personas/${p.id}`, T), `delete ${spec.name}`);
      console.log(`- ${spec.name}: removed with ${ex.length} examples`);
      continue;
    }
    const body = { description: spec.description, style: spec.style };
    if (!p) {
      p = must(await http('POST', '/api/personas', T, { scope: spec.owner === 'public' ? 'public' : 'mine', ...(userId ? { ownerId: userId } : {}), name: spec.name, ...body }), `create ${spec.name}`).persona;
      out.created++;
      console.log(`+ ${spec.name} (${spec.owner === 'public' ? '公共' : DEMO_USER})`);
    } else {
      must(await http('PATCH', `/api/personas/${p.id}`, T, body), `update ${spec.name}`);
      console.log(`= ${spec.name} exists (style reset to the spec)`);
    }
    out.personas.push(p.id);
    const d = must(await http('GET', `/api/personas/${p.id}`, T), 'persona detail');
    for (const [kind, list] of [['post', spec.posts], ['comment', spec.replies]] as const) {
      const have = d.examples[kind] as any[];
      for (const e of list) {
        if (have.some((x) => x.text === e.text)) continue;
        must(await http('POST', '/api/comment-templates', T, {
          kind, name: e.name, text: e.text, personaId: p.id, ...(userId ? { ownerId: userId } : { shared: true }),
        }), `example ${e.name}`);
        out.examples++;
      }
    }
  }
  console.log(clean ? 'demo personas removed' : `demo personas ready: ${out.personas.length} (new ${out.created}), examples added ${out.examples}`);
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  seedPersonas(process.argv.includes('--clean')).catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
}
