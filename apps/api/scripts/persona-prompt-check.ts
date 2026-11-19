/**
 * 人设 提示词 + 自定义提示词 (owner 2026-11-19) against the real API, DB and Redis. No mocks of our code: the API under
 * test is started with ANTHROPIC_BASE_URL pointing at a small HTTP listener in this script, so the request the API
 * really sends (through the official SDK) is recorded byte for byte. The listener answers like the Anthropic API would:
 * 401 (→ ai.key_invalid) by default; two checks let it answer 200 with a stand-in body (not model output) to prove the
 * output schema and the banned-word check still apply to a custom prompt. No real Anthropic call is made.
 * - GET /api/personas/:id/prompt?topic=: managers only (other user 404, public persona as user 403, admin 200), the
 *   generated prompt = SYSTEM_PROMPT + buildUserMessage (style, banned words, oldest 5 范例, recent posts; topic line
 *   only with a topic), template with placeholders, model, output schema; topic > 200 → 400; menu 人设 off → 403.
 * - What AI测试 and 「AI生成草稿」 send (captured) equals what GET …/prompt shows, generated and custom.
 * - PUT /api/personas/:id/prompt {customPrompt: {system, user} | null}: strict, non-blank, ≤ 20 000 chars, RBAC; list /
 *   detail only carry `hasCustomPrompt`; placeholders {{topic}} / {{主题}} / {{date}} / {{count}} / {{examples}} /
 *   {{recent_posts}} filled, unknown ones literal; output_config json_schema always sent; non-JSON answer → ai.bad_output;
 *   banned words in the answer reported; copy carries the custom prompt; null restores the generated prompt; audit
 *   persona.prompt_update with flag + lengths, never the text.
 * Usage (from apps/api; a TEST API started with ANTHROPIC_BASE_URL=http://127.0.0.1:$PROMPT_CAPTURE_PORT, default 3359,
 * and without ENABLED_PLATFORMS):
 *   E2E_API=http://127.0.0.1:3352 npx tsx --env-file=../../.env scripts/persona-prompt-check.ts
 */
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { and, eq, gte, inArray, like } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { config } from '../src/config.js';
import { db, schema, sqlClient } from '../src/db/index.js';
import { buildUserMessage, closeAiRedis, DRAFTS_SCHEMA, loadExamples, SYSTEM_PROMPT } from '../src/modules/ai/drafts.js';
import { closeTaskQueues } from '../src/modules/tasks/core.js';
import { withCaptcha } from './lib/login.js';

const API = process.env.E2E_API ?? 'http://127.0.0.1:3000';
const PORT = Number(process.env.PROMPT_CAPTURE_PORT ?? 3359);
const results: [string, boolean][] = [];
const check = (name: string, ok: boolean, detail = '') => { results.push([name, ok]); console.log(`${ok ? '✓' : '✗'} ${name}${detail && !ok ? ` — ${detail}` : ''}`); };

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

// ---- the stand-in Anthropic endpoint: records every request body, answers per `mode`
type Mode = { kind: '401' } | { kind: '200'; text: string };
let mode: Mode = { kind: '401' };
const captured: any[] = [];
const server = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    try { captured.push({ path: req.url, headers: req.headers, body: JSON.parse(raw) }); } catch { captured.push({ path: req.url, raw }); }
    if (mode.kind === '401') {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'msg_capture', type: 'message', role: 'assistant', model: 'claude-opus-5-5', container: null,
      content: [{ type: 'text', text: mode.text }], stop_reason: 'end_turn', stop_sequence: null, stop_details: null,
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    }));
  });
});
await new Promise<void>((r) => server.listen(PORT, '127.0.0.1', r));
const last = () => captured[captured.length - 1]?.body;

const T = await login(process.env.ADMIN_USERNAME!, process.env.ADMIN_PASSWORD!);
const tag = randomBytes(3).toString('hex');
const pw = randomBytes(12).toString('hex');
const userIds: string[] = [];
const publicPersonaIds: string[] = [];
const settingsBefore = (await db.select().from(schema.settings).where(eq(schema.settings.key, 'ai')))[0]?.value ?? null;
const menusBefore = (await db.select().from(schema.settings).where(eq(schema.settings.key, 'rbac.userMenus')))[0]?.value ?? null;
const t0 = new Date((await sqlClient`select now() as now`)[0]!.now as Date);
const redis = new Redis(config.REDIS_URL);
const INVALID_KEY = `sk-ant-api03-invalid-${'x'.repeat(40)}-${tag}`;
const resetLimits = async (...keys: string[]) => { for (const k of keys) await redis.del(k); };

try {
  const mk = async (name: string) => {
    const r = await http('POST', '/api/users', T, { username: name, password: pw, role: 'user' });
    const id = r.body.user?.id ?? r.body.id; userIds.push(id);
    return { id, token: await login(name, pw) };
  };
  const A = await mk(`ppa${tag}`);
  const B = await mk(`ppb${tag}`);
  const STYLE = { topics: ['手冲咖啡'], bannedWords: ['最便宜', 'forbiddenword'], tone: 'pro', toneNote: '讲清原理', emoji: 'medium', length: 'low', hashtags: ['coffee'], audience: '咖啡新手', notes: '不提品牌' };
  const pA = (await http('POST', '/api/personas', A.token, { scope: 'mine', name: `Barista ${tag}`, description: '在家做好一杯手冲', style: STYLE, examples: ['范例一 水温 92 度', '范例二 研磨度'] })).body.persona;
  const pP = (await http('POST', '/api/personas', T, { scope: 'public', name: `Pub ${tag}` })).body.persona;
  publicPersonaIds.push(pP.id);
  const igA = (await http('POST', '/api/social/accounts', A.token, { platform: 'instagram', handle: `pp_ig_${tag}`, personaId: pA.id })).body.account;
  // a recent post of the persona (an AI draft of it, last 30 days) → <recent_posts>
  await db.insert(schema.contents).values({
    userId: A.id, title: `上周的拿铁 ${tag}`, body: '拿铁拉花入门', lang: 'zh-CN', stage: 'draft', status: 'draft', platformHints: {},
    aiGenerated: { via: 'account', accountId: igA.id, personaId: pA.id, personaName: pA.name, model: 'claude-opus-5-5', requestedModel: 'claude-opus-5-5', taskId: null, generatedAt: new Date().toISOString(), mediaTags: [] } as any,
  });
  check('setup: users A/B, A\'s persona with style + 2 范例, a public persona, A\'s ig account with the persona, a recent post', !!pA?.id && !!pP?.id && !!igA?.id);
  await http('PUT', '/api/settings/ai', T, { apiKey: INVALID_KEY, workspaceId: null, model: 'claude-opus-5-5' });

  // ================================================================ view (generated)
  let r = await http('GET', `/api/personas/${pA.id}/prompt`, B.token);
  const rPub = await http('GET', `/api/personas/${pP.id}/prompt`, A.token);
  const rAdm = await http('GET', `/api/personas/${pA.id}/prompt`, T);
  const rLong = await http('GET', `/api/personas/${pA.id}/prompt?topic=${'x'.repeat(201)}`, A.token);
  check('GET prompt: other user 404, public persona as user 403, admin 200, topic > 200 → 400',
    r.status === 404 && rPub.status === 403 && rAdm.status === 200 && rLong.status === 400, `${r.status} ${rPub.status} ${rAdm.status} ${rLong.status}`);
  const g = (await http('GET', `/api/personas/${pA.id}/prompt`, A.token)).body;
  const [row] = await db.select().from(schema.personas).where(eq(schema.personas.id, pA.id));
  const ex = await loadExamples(row!);
  const day = g.prompt.user.match(/^Date: (\S+)/)?.[1];
  const expected = buildUserMessage({ persona: row!, count: 1, day, examples: ex, recent: [{ title: `上周的拿铁 ${tag}`, body: '拿铁拉花入门' }] });
  const u: string = g.prompt.user;
  check('GET prompt (generated): custom false, system = SYSTEM_PROMPT, user = buildUserMessage (count 1, 2 范例, 1 recent post)',
    g.prompt.custom === false && g.customPrompt === null && g.prompt.system === SYSTEM_PROMPT && u === expected && g.prompt.examples === 2 && g.prompt.recent === 1,
    `${g.prompt.custom} ${g.prompt.examples} ${g.prompt.recent}\n${u}\n---\n${expected}`);
  check('GET prompt: style / banned words / 范例 / recent post in the text, no topic line',
    u.includes('Positioning: 在家做好一杯手冲') && u.includes('Tone: pro — 讲清原理') && u.includes('- 最便宜') && u.includes('- forbiddenword') && u.includes('- 手冲咖啡')
      && u.includes('范例一 水温 92 度') && u.includes('范例二 研磨度') && u.includes(`上周的拿铁 ${tag}`) && u.includes('Audience: 咖啡新手') && !u.includes('Requested topic'));
  const gt = (await http('GET', `/api/personas/${pA.id}/prompt?topic=${encodeURIComponent('冷萃')}`, A.token)).body;
  check('GET prompt ?topic=冷萃: the "Requested topic" line names it', gt.prompt.user.includes('Requested topic (every draft is about it, each from a different angle): 冷萃'));
  check('GET prompt: model, output schema = DRAFTS_SCHEMA, placeholders, template with {{topic}} {{date}} {{count}} {{examples}} {{recent_posts}} and the persona\'s settings',
    g.model === 'claude-opus-5-5' && JSON.stringify(g.schema) === JSON.stringify(DRAFTS_SCHEMA) && g.placeholders.join() === 'topic,date,count,examples,recent_posts' && g.maxLength === 20000
      && g.template.system === SYSTEM_PROMPT && ['{{topic}}', '{{date}}', '{{count}}', '{{examples}}', '{{recent_posts}}', 'Positioning: 在家做好一杯手冲', '- 最便宜'].every((x) => g.template.user.includes(x))
      && !g.template.user.includes('范例一'));

  // ================================================================ what is really sent (generated)
  captured.length = 0;
  await resetLimits(`ai:preview:count:${pA.id}`, `ai:account-preview:count:${igA.id}`);
  r = await http('POST', `/api/personas/${pA.id}/drafts/preview`, A.token, { topic: '冷萃' });
  let body = last();
  check('AI测试 (generated) reaches the listener: 502 ai.key_invalid, sent system / user = GET prompt with the same topic, json_schema output, cache_control',
    r.status === 502 && r.body.code === 'ai.key_invalid' && captured.length === 1 && body?.system?.[0]?.text === gt.prompt.system && body?.messages?.[0]?.content === gt.prompt.user
      && body?.output_config?.format?.type === 'json_schema' && JSON.stringify(body.output_config.format.schema) === JSON.stringify(DRAFTS_SCHEMA) && body?.system?.[0]?.cache_control?.type === 'ephemeral'
      && body?.model === 'claude-opus-5-5' && captured[0].headers.authorization === `Bearer ${INVALID_KEY}`,
    `${r.status} ${r.body?.code} captured=${captured.length} (is the API started with ANTHROPIC_BASE_URL=http://127.0.0.1:${PORT}?)`);

  // ================================================================ custom prompt: validation + RBAC
  const SYS = `你是 {{主题}} 写手。只输出 JSON。日期 {{ date }}。`;
  const USR = `写 {{count}} 篇关于「{{topic}}」的草稿。\n范例：\n{{examples}}\n近期：\n{{recent_posts}}\n保留 {{unknown}} 与 {单括号}。`;
  const bad = await Promise.all([
    http('PUT', `/api/personas/${pA.id}/prompt`, A.token, { customPrompt: { system: SYS, user: USR, extra: 1 } }),
    http('PUT', `/api/personas/${pA.id}/prompt`, A.token, { customPrompt: { system: '   ', user: USR } }),
    http('PUT', `/api/personas/${pA.id}/prompt`, A.token, { customPrompt: { system: SYS, user: '' } }),
    http('PUT', `/api/personas/${pA.id}/prompt`, A.token, { customPrompt: { system: SYS, user: 'x'.repeat(20001) } }),
    http('PUT', `/api/personas/${pA.id}/prompt`, A.token, {}),
    http('PUT', `/api/personas/${pA.id}/prompt`, A.token, { customPrompt: { system: SYS, user: USR }, other: true }),
  ]);
  const rb = await http('PUT', `/api/personas/${pA.id}/prompt`, B.token, { customPrompt: { system: SYS, user: USR } });
  const rp = await http('PUT', `/api/personas/${pP.id}/prompt`, A.token, { customPrompt: { system: SYS, user: USR } });
  check('PUT prompt: unknown fields / blank system / empty user / > 20 000 chars / missing customPrompt → 400; other user 404; public persona as user 403',
    bad.every((x) => x.status === 400) && rb.status === 404 && rp.status === 403, `${bad.map((x) => x.status).join()} ${rb.status} ${rp.status}`);
  r = await http('PUT', `/api/personas/${pA.id}/prompt`, A.token, { customPrompt: { system: SYS, user: USR } });
  const [stored] = await db.select().from(schema.personas).where(eq(schema.personas.id, pA.id));
  check('PUT prompt: saved as written on the persona (custom_prompt)', r.status === 200 && stored!.customPrompt?.system === SYS && stored!.customPrompt?.user === USR, `${r.status} ${r.text.slice(0, 200)}`);
  const list = (await http('GET', '/api/personas?scope=mine', A.token)).body.personas as any[];
  const det = await http('GET', `/api/personas/${pA.id}`, A.token);
  check('list / detail: only hasCustomPrompt (true), never the text', list.find((p) => p.id === pA.id)?.hasCustomPrompt === true && det.body.persona.hasCustomPrompt === true
    && !JSON.stringify(list).includes('写手') && !det.text.includes('写手') && !('customPrompt' in det.body.persona));

  // ================================================================ custom prompt: view + really sent
  const gc = (await http('GET', `/api/personas/${pA.id}/prompt?topic=${encodeURIComponent('冷萃')}`, A.token)).body;
  const cu: string = gc.prompt.user;
  check('GET prompt (custom): custom true, {{主题}} / {{ date }} / {{count}} / {{topic}} / {{examples}} / {{recent_posts}} filled, {{unknown}} and {单括号} literal, customPrompt returned as stored',
    gc.prompt.custom === true && gc.prompt.system === `你是 冷萃 写手。只输出 JSON。日期 ${day}。` && cu.startsWith('写 1 篇关于「冷萃」的草稿。')
      && cu.includes('<example name=') && cu.includes('范例一 水温 92 度') && cu.includes(`上周的拿铁 ${tag}`) && cu.includes('保留 {{unknown}} 与 {单括号}。') && !cu.includes('Positioning:')
      && gc.customPrompt?.user === USR && gc.template.system === SYSTEM_PROMPT, `${gc.prompt.system}\n${cu}`);
  const gn = (await http('GET', `/api/personas/${pA.id}/prompt`, A.token)).body;
  check('GET prompt (custom) without a topic: {{topic}} empty', gn.prompt.system === `你是  写手。只输出 JSON。日期 ${day}。` && gn.prompt.user.startsWith('写 1 篇关于「」的草稿。'));
  captured.length = 0;
  r = await http('POST', `/api/personas/${pA.id}/drafts/preview`, A.token, { topic: '冷萃' });
  body = last();
  check('AI测试 sends the custom prompt (= GET prompt), json_schema output kept, → 502 ai.key_invalid',
    r.status === 502 && r.body.code === 'ai.key_invalid' && body?.system?.[0]?.text === gc.prompt.system && body?.messages?.[0]?.content === gc.prompt.user
      && JSON.stringify(body?.output_config?.format?.schema) === JSON.stringify(DRAFTS_SCHEMA), `${r.status} ${r.body?.code} captured=${captured.length}`);
  captured.length = 0;
  r = await http('POST', `/api/social/accounts/${igA.id}/ai-drafts/preview`, A.token, { topic: '冷萃' });
  body = last();
  check('「AI生成草稿」 preview sends the custom prompt of the account persona (recent posts = the account owner\'s = A) → 502 ai.key_invalid',
    r.status === 502 && r.body.code === 'ai.key_invalid' && body?.system?.[0]?.text === gc.prompt.system && body?.messages?.[0]?.content === gc.prompt.user
      && body?.output_config?.format?.type === 'json_schema', `${r.status} ${r.body?.code} captured=${captured.length}`);
  {
    const banned = await http('POST', `/api/personas/${pA.id}/drafts/preview`, A.token, { topic: '最便宜' });
    check('custom prompt: a topic with a banned word is still refused (400 persona.banned_word, nothing sent)', banned.status === 400 && banned.body.code === 'persona.banned_word');
  }
  // stand-in answers (the listener, not a model): the output schema and the banned-word check still apply
  mode = { kind: '200', text: '好的，这是草稿：今天聊聊冷萃。' };
  r = await http('POST', `/api/personas/${pA.id}/drafts/preview`, A.token, { topic: '冷萃' });
  check('custom prompt + an answer that is not the JSON shape → 502 ai.bad_output', r.status === 502 && r.body.code === 'ai.bad_output', `${r.status} ${r.text.slice(0, 200)}`);
  mode = { kind: '200', text: JSON.stringify({ drafts: [{ title: '冷萃', body: '最便宜的冷萃做法', hashtags: ['coldbrew'], mediaTags: ['咖啡'] }] }) };
  await resetLimits(`ai:preview:count:${pA.id}`);
  r = await http('POST', `/api/personas/${pA.id}/drafts/preview`, A.token, { topic: '冷萃' });
  check('custom prompt + a JSON answer with a banned word → 200 preview with banned ["最便宜"] (banned-word check kept), nothing stored',
    r.status === 200 && r.body.preview?.banned?.join() === '最便宜' && r.body.preview?.text === '最便宜的冷萃做法\n\n#coldbrew', `${r.status} ${r.text.slice(0, 300)}`);
  mode = { kind: '401' };
  {
    const n = await redis.get(`ai:preview:count:${pA.id}`);
    check('custom prompt: AI测试 still counts toward the rate limit', Number(n) === 1, `${n}`);
  }

  // ================================================================ copy + reset
  r = await http('POST', `/api/personas/${pA.id}/copy`, A.token, {});
  const [copy] = await db.select().from(schema.personas).where(eq(schema.personas.id, r.body.persona?.id));
  check('copy carries the custom prompt', r.status === 201 && copy?.customPrompt?.system === SYS && copy?.customPrompt?.user === USR && r.body.persona.hasCustomPrompt === true, `${r.status}`);
  r = await http('PUT', `/api/personas/${pA.id}/prompt`, A.token, { customPrompt: null });
  const gr = (await http('GET', `/api/personas/${pA.id}/prompt?topic=${encodeURIComponent('冷萃')}`, A.token)).body;
  const [afterReset] = await db.select().from(schema.personas).where(eq(schema.personas.id, pA.id));
  check('PUT null = 恢复自动生成: column null, GET prompt generated again (= the first generated view)', r.status === 200 && r.body.customPrompt === null && afterReset!.customPrompt === null
    && gr.prompt.custom === false && gr.prompt.user === gt.prompt.user && gr.prompt.system === SYSTEM_PROMPT);
  captured.length = 0;
  await resetLimits(`ai:preview:count:${pA.id}`);
  r = await http('POST', `/api/personas/${pA.id}/drafts/preview`, A.token, { topic: '冷萃' });
  check('after the reset AI测试 sends the generated prompt again', r.status === 502 && last()?.system?.[0]?.text === SYSTEM_PROMPT && last()?.messages?.[0]?.content === gt.prompt.user);
  r = await http('PUT', `/api/personas/${pP.id}/prompt`, T, { customPrompt: { system: 'S', user: 'U' } });
  const adm = await http('PUT', `/api/personas/${pP.id}/prompt`, T, { customPrompt: null });
  check('admin manages the public persona\'s prompt', r.status === 200 && adm.status === 200);

  // ================================================================ menu rule (人设 off for users)
  {
    const off = await http('PUT', '/api/settings/role-menus', T, { menus: ['social', 'content'] });
    const g1 = await http('GET', `/api/personas/${pA.id}/prompt`, A.token);
    const p1 = await http('PUT', `/api/personas/${pA.id}/prompt`, A.token, { customPrompt: null });
    if (menusBefore) await db.update(schema.settings).set({ value: menusBefore }).where(eq(schema.settings.key, 'rbac.userMenus'));
    else await db.delete(schema.settings).where(eq(schema.settings.key, 'rbac.userMenus'));
    await new Promise((res) => setTimeout(res, 5500)); // the role-menu cache (5 s)
    const g2 = await http('GET', `/api/personas/${pA.id}/prompt`, A.token);
    check('menu 人设 switched off → GET/PUT prompt 403 rbac.menu_disabled; back on → 200', off.status === 200 && g1.status === 403 && g1.body.code === 'rbac.menu_disabled' && p1.status === 403 && g2.status === 200,
      `${off.status} ${g1.status} ${p1.status} ${g2.status}`);
  }

  // ================================================================ audit
  await new Promise((res) => setTimeout(res, 500));
  const audits = await db.select().from(schema.auditLogs).where(and(like(schema.auditLogs.action, 'persona.prompt%'), gte(schema.auditLogs.at, t0)));
  const txt = JSON.stringify(audits);
  check('audit persona.prompt_update: custom true + lengths, custom false on reset, refusals logged, never the text',
    audits.some((a) => a.ok && (a.detail as any)?.custom === true && (a.detail as any)?.userLength === USR.length && (a.detail as any)?.systemLength === SYS.length)
      && audits.some((a) => a.ok && (a.detail as any)?.custom === false) && audits.some((a) => !a.ok) && !txt.includes('写手') && !txt.includes('范例：'),
    txt.slice(0, 400));
  check('GET prompt is not audited (read)', !audits.some((a) => a.action !== 'persona.prompt_update'));
} finally {
  for (const id of userIds) await http('DELETE', `/api/users/${id}`, T).catch(() => undefined);
  if (publicPersonaIds.length) await db.delete(schema.personas).where(inArray(schema.personas.id, publicPersonaIds));
  if (settingsBefore) await db.update(schema.settings).set({ value: settingsBefore }).where(eq(schema.settings.key, 'ai'));
  else await db.delete(schema.settings).where(eq(schema.settings.key, 'ai'));
  redis.disconnect();
  server.close();
  await closeAiRedis();
  await closeTaskQueues();
  await sqlClient.end();
}

const failed = results.filter(([, ok]) => !ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
