/**
 * 人设 (personas) of the script library against the real API and DB. No mocks.
 * - CRUD + RBAC per scope: public personas admin-managed (users 403), personal ones private (others 404), admin all-users
 *   view with owner filter; names unique per owner, case-insensitive; validation.
 * - Template persona rules: shared template → public persona only; personal template → public or the owner's persona.
 * - Counts per persona (templates and 账号人设 accounts, exact, per viewer), template filter personaId / none, facets without personas.
 * - 人设 page links: the counts equal what the linked lists return (/social?personaId → accounts total; /scripts?personaId
 *   → shared + own templates for users, shared + all-users for admins; a personal persona → its owner's templates only).
 * - Delete → templates become 未设人设. No merge for personas (owner decision 2026-11-18): POST …/merge → 404 for
 *   everyone, nothing moved.
 * - The one persona form (owner decision 2026-11-18): 定位 (description), style (tone preset + note, emoji, length,
 *   topics, banned words, hashtags, audience, fixed opening/closing, notes; strict validation, normalisation, defaults,
 *   no language), GET /api/personas/:id (style for everyone who may see it, 范例 per kind in the persona's own scope,
 *   length ranges, draft owner/runs only for managers), admin-created examples for a user's personal persona (ownerId),
 *   banned words inside the fixed opening/closing refused.
 * - Migration 0036 (persona reset) executed inside a transaction on seeded rows and rolled back: personas, their
 *   templates, 账号人设 and legacy texts/groups cleared; contents.ai_generated untouched.
 * - Audit entries (names only).
 * - The data migration (src/db/persona-data-migration.ts): old-style free-text personas seeded directly in the DB
 *   (shared + personal, case/space variants), migrated twice → personas created once, templates linked, no re-link
 *   after a persona is deleted.
 * Usage (from apps/api, API running): E2E_API=http://127.0.0.1:3000 npx tsx --env-file=../../.env scripts/personas-check.ts
 */
import { randomBytes } from 'node:crypto';
import { eq, ilike, inArray } from 'drizzle-orm';
import { db, schema, sqlClient } from '../src/db/index.js';
import { migratePersonaTexts } from '../src/db/persona-data-migration.js';
import { withCaptcha } from './lib/login.js';

const API = process.env.E2E_API ?? 'http://127.0.0.1:3000';
const results: [string, boolean][] = [];
const check = (name: string, ok: boolean, detail = '') => { results.push([name, ok]); console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`); };

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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const TPL = schema.commentTemplates;
const P = schema.personas;

const T = await login(process.env.ADMIN_USERNAME!, process.env.ADMIN_PASSWORD!);
const tag = randomBytes(3).toString('hex');
const pw = randomBytes(12).toString('hex');
const userIds: string[] = [];
const templateIds: string[] = [];
const startedAt = new Date();

try {
  const mk = async (name: string) => {
    const r = await http('POST', '/api/users', T, { username: name, password: pw, role: 'user' });
    const id = r.body.user?.id ?? r.body.id; userIds.push(id);
    return { id, token: await login(name, pw) };
  };
  const A = await mk(`pea${tag}`);
  const B = await mk(`peb${tag}`);
  const persona = (token: string, body: Record<string, unknown>) => http('POST', '/api/personas', token, body);
  const plist = async (token: string, q: string) => {
    const r = await http('GET', `/api/personas?${q}`, token);
    return { status: r.status, code: r.body?.code, items: ((r.body?.personas ?? []) as any[]).filter((x) => x.name.includes(tag)) };
  };

  // ================================================================ CRUD + RBAC
  let r = await persona(A.token, { scope: 'mine', name: `Coach ${tag}`, description: 'Upbeat, short sentences' });
  const aCoach = r.body.persona;
  check('user creates a personal persona with description', r.status === 201 && aCoach.ownerType === 'user' && aCoach.ownerId === A.id && aCoach.description === 'Upbeat, short sentences');
  r = await persona(A.token, { scope: 'mine', name: `  COACH ${tag.toUpperCase()} ` });
  check('same name in another case for the same owner → 409 persona.exists', r.status === 409 && r.body.code === 'persona.exists', `${r.status} ${r.body?.code}`);
  r = await persona(B.token, { scope: 'mine', name: `Coach ${tag}` });
  const bCoach = r.body.persona;
  check('another user may use the same name (unique per owner)', r.status === 201);
  r = await persona(A.token, { scope: 'public', name: `Brand ${tag}` });
  const r2 = await persona(A.token, { scope: 'mine', ownerId: B.id, name: `x ${tag}` });
  check('user cannot create public personas or personas for others (403 persona.admin_only)', r.status === 403 && r.body.code === 'persona.admin_only' && r2.status === 403);
  const [brand, chef, old, pre] = await Promise.all(['Brand', 'Chef', 'Old', 'Pre'].map(async (n) => (await persona(T, { scope: 'public', name: `${n} ${tag}` })).body.persona));
  check('admin creates public personas', [brand, chef, old, pre].every((p) => p?.ownerType === 'public' && p.ownerId === null));
  check('persona responses carry the style with defaults (no legacy brief)', !('brief' in brand) && brand.style?.tone === 'casual');
  r = await persona(T, { scope: 'public', name: `brand ${tag.toUpperCase()}` });
  check('public names unique case-insensitively → 409', r.status === 409 && r.body.code === 'persona.exists');
  r = await persona(T, { scope: 'mine', ownerId: A.id, name: `Coach2 ${tag}` });
  const aCoach2 = r.body.persona;
  check('admin creates a personal persona for a user (ownerId)', r.status === 201 && aCoach2.ownerId === A.id);
  r = await persona(A.token, { scope: 'mine', name: 'p'.repeat(51) });
  const r3 = await persona(A.token, { scope: 'mine', name: `d ${tag}`, description: 'd'.repeat(201) });
  const r4 = await persona(A.token, { scope: 'mine', name: '   ' });
  check('validation: name > 50, description > 200, blank name → 400', r.status === 400 && r3.status === 400 && r4.status === 400);

  let l = await plist(A.token, 'scope=public');
  check('user lists public personas', l.status === 200 && l.items.length === 4 && l.items.every((x) => x.writable === false));
  l = await plist(A.token, 'scope=mine');
  check('user lists only own personal personas', l.items.map((x) => x.id).sort().join() === [aCoach.id, aCoach2.id].sort().join() && l.items.every((x) => x.writable), l.items.map((x) => x.name).join());
  l = await plist(A.token, 'scope=all-users');
  check('user all-users view → 403', l.status === 403 && l.code === 'persona.admin_only');
  l = await plist(T, 'scope=all-users');
  check('admin all-users view: every user\'s personal personas with owner names', l.items.length === 3 && l.items.find((x) => x.id === bCoach.id)?.ownerName === `peb${tag}`);
  l = await plist(T, `scope=all-users&ownerId=${A.id}`);
  check('admin all-users view filtered by owner', l.items.length === 2 && l.items.every((x) => x.ownerId === A.id));

  r = await http('PATCH', `/api/personas/${bCoach.id}`, A.token, { name: 'hijack' });
  const dB = await http('DELETE', `/api/personas/${bCoach.id}`, A.token);
  check('other user\'s personal persona: PATCH/DELETE → 404 persona.not_found', r.status === 404 && dB.status === 404 && r.body.code === 'persona.not_found');
  r = await http('PATCH', `/api/personas/${brand.id}`, A.token, { name: 'x' });
  const dP = await http('DELETE', `/api/personas/${brand.id}`, A.token);
  check('user cannot edit/delete public personas (403)', r.status === 403 && dP.status === 403 && r.body.code === 'persona.admin_only');
  r = await http('PATCH', `/api/personas/${aCoach.id}`, A.token, { name: `Coach ${tag} Pro`, description: 'Calm', sort: 7 });
  check('owner renames / describes / sorts', r.status === 200 && r.body.persona.name === `Coach ${tag} Pro` && r.body.persona.description === 'Calm' && r.body.persona.sort === 7);
  r = await http('PATCH', `/api/personas/${aCoach.id}`, A.token, { description: '' });
  check('description "" → null', r.status === 200 && r.body.persona.description === null);
  r = await http('PATCH', `/api/personas/${aCoach.id}`, A.token, { name: `coach2 ${tag}` });
  check('rename onto an existing name (case-insensitive) → 409', r.status === 409 && r.body.code === 'persona.exists');
  r = await http('PATCH', `/api/personas/${aCoach.id}`, A.token, {});
  check('empty update → 400 common.nothing_to_update', r.status === 400 && r.body.code === 'common.nothing_to_update');
  r = await http('PATCH', `/api/personas/${bCoach.id}`, T, { description: 'by admin' });
  check('admin edits a user\'s personal persona', r.status === 200 && r.body.persona.description === 'by admin');

  // ================================================================ the persona form: style, examples, GET /:id
  {
    const st = await persona(A.token, { scope: 'mine', name: `Style ${tag}`, description: '一句话定位', style: {
      tone: 'funny', toneNote: '  轻松吐槽  ', emoji: 'high', length: 'low', topics: ['跑步', ' 跑步 ', 'Run', 'run'], bannedWords: ['Spam', 'spam', '违禁'],
      hashtags: ['#Run', 'run', 'morning run'], audience: '', opening: '早！', closing: '', notes: 'n',
    } });
    const sp = st.body.persona;
    check('create with style: stored normalised (trimmed, lists de-duplicated case-insensitively, hashtags without # / spaces, empty texts dropped)',
      st.status === 201 && sp.style.tone === 'funny' && sp.style.toneNote === '轻松吐槽' && sp.style.topics.join() === '跑步,Run' && sp.style.bannedWords.join() === 'Spam,违禁'
        && sp.style.hashtags.join() === 'Run,morningrun' && !('audience' in sp.style) && sp.style.opening === '早！' && !('closing' in sp.style) && sp.description === '一句话定位',
      JSON.stringify(sp?.style ?? st.body));
    const plain = (await persona(A.token, { scope: 'mine', name: `Plain ${tag}` })).body.persona;
    check('defaults on read: tone casual, emoji medium, length medium, empty lists', plain.style.tone === 'casual' && plain.style.emoji === 'medium' && plain.style.length === 'medium'
      && plain.style.topics.length === 0 && plain.style.bannedWords.length === 0 && plain.style.hashtags.length === 0);
    const bad = await Promise.all([
      http('PATCH', `/api/personas/${plain.id}`, A.token, { style: { tone: 'angry' } }),
      http('PATCH', `/api/personas/${plain.id}`, A.token, { style: { emoji: 'tons' } }),
      http('PATCH', `/api/personas/${plain.id}`, A.token, { style: { lang: 'en' } }),
      http('PATCH', `/api/personas/${plain.id}`, A.token, { style: { bannedWords: Array.from({ length: 51 }, (_, k) => `w${k}`) } }),
      http('PATCH', `/api/personas/${plain.id}`, A.token, { style: { notes: 'n'.repeat(1001) } }),
    ]);
    check('style validation: unknown tone/emoji, a language, > 50 banned words, notes > 1000 → 400', bad.every((x) => x.status === 400), bad.map((x) => x.status).join());
    let x = await http('PATCH', `/api/personas/${plain.id}`, A.token, { style: { bannedWords: ['早'], opening: '早上好' } });
    check('a banned word inside the fixed opening/closing → 400 persona.banned_in_style', x.status === 400 && x.body.code === 'persona.banned_in_style', `${x.status} ${x.body?.code}`);
    x = await http('PATCH', `/api/personas/${plain.id}`, A.token, { style: { tone: 'pro', length: 'high' }, description: '专业' });
    check('PATCH replaces the whole style together with the description', x.status === 200 && x.body.persona.style.tone === 'pro' && x.body.persona.style.length === 'high'
      && x.body.persona.style.emoji === 'medium' && x.body.persona.description === '专业');
    // examples: own templates of the persona; admin adds one for A (ownerId)
    const ex1 = await http('POST', '/api/comment-templates', A.token, { kind: 'post', name: 'e1', text: `发文范例 ${tag}`, personaId: sp.id });
    const ex2 = await http('POST', '/api/comment-templates', A.token, { kind: 'comment', name: 'e2', text: `回复范例 ${tag}`, personaId: sp.id });
    const ex3 = await http('POST', '/api/comment-templates', T, { kind: 'comment', name: 'e3', text: `管理员替 A 写的回复范例 ${tag}`, personaId: sp.id, ownerId: A.id });
    const ex4 = await http('POST', '/api/comment-templates', B.token, { kind: 'comment', name: 'e4', text: 'x', personaId: sp.id, ownerId: A.id });
    for (const e of [ex1, ex2, ex3]) if (e.body?.template?.id) templateIds.push(e.body.template.id);
    check('examples: owner adds post + reply examples; admin adds one for A (ownerId → A\'s private template); a user cannot use ownerId (403)',
      ex1.status === 201 && ex2.status === 201 && ex3.status === 201 && ex3.body.template.userId === A.id && ex3.body.template.shared === false && ex4.status === 403,
      `${ex1.status} ${ex2.status} ${ex3.status} ${ex4.status}`);
    x = await http('GET', `/api/personas/${sp.id}`, A.token);
    check('GET /api/personas/:id: style, examples per kind (oldest first), lengths, draft owner + runs for the owner',
      x.status === 200 && x.body.examples.post.map((e: any) => e.text).join() === `发文范例 ${tag}` && x.body.examples.comment.map((e: any) => e.text).join() === `回复范例 ${tag},管理员替 A 写的回复范例 ${tag}`
        && x.body.lengths.comment.low.join() === '4,30' && x.body.lengths.post.medium.join() === '150,500' && x.body.persona.draftOwnerName === `pea${tag}` && Array.isArray(x.body.persona.runs)
        && x.body.persona.style.bannedWords.join() === 'Spam,违禁', JSON.stringify(x.body).slice(0, 400));
    x = await http('GET', `/api/personas/${sp.id}`, B.token);
    check('GET /api/personas/:id of another user\'s personal persona → 404', x.status === 404 && x.body.code === 'persona.not_found');
    const pubStyle = (await persona(T, { scope: 'public', name: `PubStyle ${tag}`, style: { bannedWords: ['广告'] } })).body.persona;
    const pubEx = await http('POST', '/api/comment-templates', T, { kind: 'post', name: 'pe', text: `公共范例 ${tag}`, personaId: pubStyle.id, shared: true });
    const aOnPub = await http('POST', '/api/comment-templates', A.token, { kind: 'post', name: 'ape', text: `A 私有 ${tag}`, personaId: pubStyle.id });
    templateIds.push(pubEx.body.template.id, aOnPub.body.template.id);
    x = await http('GET', `/api/personas/${pubStyle.id}`, A.token);
    check('public persona read by a user: style (banned words for the editor card), only shared examples (not A\'s private one), no draft owner/runs',
      x.status === 200 && x.body.persona.style.bannedWords.join() === '广告' && x.body.examples.post.length === 1 && x.body.examples.post[0].text === `公共范例 ${tag}`
        && !('draftOwnerId' in x.body.persona) && !('runs' in x.body.persona) && x.body.persona.writable === false);
    const l2 = await http('GET', '/api/personas?scope=mine', A.token);
    check('list carries style and the length table', l2.body.personas.find((p: any) => p.id === sp.id)?.style?.tone === 'funny' && !!l2.body.lengths?.post?.high);
  }

  // ================================================================ template persona rules
  const tpl = async (token: string, body: Record<string, unknown>) => {
    const x = await http('POST', '/api/comment-templates', token, { kind: 'post', text: 'text', ...body });
    if (x.body?.template?.id) templateIds.push(x.body.template.id);
    return x;
  };
  r = await tpl(T, { name: `s-bad ${tag}`, shared: true, personaId: aCoach.id });
  check('shared template + personal persona → 400 persona.not_allowed', r.status === 400 && r.body.code === 'persona.not_allowed', `${r.status} ${r.body?.code}`);
  r = await tpl(A.token, { name: `a-bad ${tag}`, personaId: bCoach.id });
  const r5 = await tpl(A.token, { name: `a-bad2 ${tag}`, personaId: '7d3c4a1e-0000-4000-8000-000000000000' });
  check('personal template + another user\'s / unknown persona → 400', r.status === 400 && r.body.code === 'persona.not_allowed' && r5.status === 400);
  const S1 = (await tpl(T, { name: `s1 ${tag}`, shared: true, personaId: brand.id })).body.template;
  const S2 = (await tpl(T, { name: `s2 ${tag}`, shared: true, personaId: old.id })).body.template;
  const S3 = (await tpl(T, { name: `s3 ${tag}`, shared: true, personaId: chef.id })).body.template;
  const A1 = (await tpl(A.token, { name: `a1 ${tag}`, personaId: aCoach.id })).body.template;
  const A2 = (await tpl(A.token, { name: `a2 ${tag}`, personaId: brand.id })).body.template;
  const A3 = (await tpl(A.token, { name: `a3 ${tag}`, personaId: aCoach2.id })).body.template;
  const A4 = (await tpl(A.token, { name: `a4 ${tag}` })).body.template;
  const B1 = (await tpl(B.token, { name: `b1 ${tag}`, personaId: brand.id })).body.template;
  const B2 = (await tpl(B.token, { name: `b2 ${tag}`, personaId: bCoach.id })).body.template;
  check('templates with allowed personas (shared → public; personal → public or own); persona returned as an object',
    S1?.persona?.name === `Brand ${tag}` && S1.persona.ownerType === 'public' && A1?.persona?.id === aCoach.id && A2?.persona?.id === brand.id
      && B2?.persona?.id === bCoach.id && A4?.persona === null && A1.persona.description === null);
  r = await http('PUT', `/api/comment-templates/${A4.id}`, A.token, { personaId: bCoach.id });
  check('update personal template to another user\'s persona → 400', r.status === 400 && r.body.code === 'persona.not_allowed');
  r = await http('PUT', `/api/comment-templates/${S2.id}`, T, { personaId: aCoach.id });
  check('update shared template to a personal persona → 400 (also for admins)', r.status === 400 && r.body.code === 'persona.not_allowed');
  r = await http('PUT', `/api/comment-templates/${A4.id}`, T, { personaId: aCoach.id });
  const r6 = await http('PUT', `/api/comment-templates/${A4.id}`, T, { personaId: bCoach.id });
  check('admin editing A\'s template: A\'s persona ok, B\'s → 400', r.status === 200 && r.body.template.persona?.id === aCoach.id && r6.status === 400);
  r = await http('PUT', `/api/comment-templates/${A4.id}`, A.token, { personaId: null });
  check('personaId null clears', r.status === 200 && r.body.template.persona === null && r.body.template.personaId === null);

  // ================================================================ counts, filters, facets
  const count = (xs: any[], id: string) => xs.find((x) => x.id === id)?.count;
  const pubA = (await plist(A.token, 'scope=public')).items;
  const pubT = (await plist(T, 'scope=public')).items;
  const mineA = (await plist(A.token, 'scope=mine')).items;
  check('counts per viewer are exact (Brand: A sees s1+a2 = 2, admin 3; Old 1; Pre 0; Coach 1)',
    count(pubA, brand.id) === 2 && count(pubT, brand.id) === 3 && count(pubA, old.id) === 1 && count(pubA, pre.id) === 0 && count(mineA, aCoach.id) === 1 && count(mineA, aCoach2.id) === 1,
    JSON.stringify([count(pubA, brand.id), count(pubT, brand.id), count(pubA, old.id), count(pubA, pre.id), count(mineA, aCoach.id)]));
  // 账号人设 counts: accounts with the persona that the viewer can see (users: own; admins: all)
  const accA = await http('POST', '/api/social/accounts', A.token, { platform: 'instagram', handle: `pc_${tag}_a`, personaId: brand.id });
  const accB = await http('POST', '/api/social/accounts', B.token, { platform: 'instagram', handle: `pc_${tag}_b`, personaId: brand.id });
  const accounts = (xs: any[], id: string) => xs.find((x) => x.id === id)?.accounts;
  const [pubA2, pubT2] = [(await plist(A.token, 'scope=public')).items, (await plist(T, 'scope=public')).items];
  check('account counts per viewer (Brand: A 1, admin 2; Old 0)', accA.status === 201 && accB.status === 201
    && accounts(pubA2, brand.id) === 1 && accounts(pubT2, brand.id) === 2 && accounts(pubA2, old.id) === 0,
    JSON.stringify([accA.status, accB.status, accounts(pubA2, brand.id), accounts(pubT2, brand.id)]));
  // 人设 page links (/social?personaId=, /scripts?personaId=&tab=…): the numbers shown equal the linked lists
  const socialTotal = async (token: string, id: string) => (await http('GET', `/api/social/accounts?personaId=${id}`, token)).body.total as number;
  const tplCount = async (token: string, q: string) => ((await http('GET', `/api/comment-templates?kind=all&${q}`, token)).body.templates as any[]).length;
  const linkA = [await socialTotal(A.token, brand.id), await tplCount(A.token, `scope=shared&personaId=${brand.id}`) + await tplCount(A.token, `scope=own&personaId=${brand.id}`),
    await tplCount(A.token, `scope=own&personaId=${aCoach.id}`)];
  const linkT = [await socialTotal(T, brand.id), await tplCount(T, `scope=shared&personaId=${brand.id}`) + await tplCount(T, `scope=all-users&personaId=${brand.id}`),
    await tplCount(T, `scope=all-users&personaId=${aCoach.id}`)];
  const mineT = (await plist(T, `scope=all-users&ownerId=${A.id}`)).items;
  check('人设 page links: counts = linked lists (A: accounts 1, Brand scripts 1+1 = 2, Coach 1; admin: accounts 2, Brand 1+2 = 3, A\'s Coach 1)',
    linkA.join() === [accounts(pubA2, brand.id), count(pubA2, brand.id), count(mineA, aCoach.id)].join() && linkA.join() === '1,2,1'
    && linkT.join() === [accounts(pubT2, brand.id), count(pubT2, brand.id), count(mineT, aCoach.id)].join() && linkT.join() === '2,3,1',
    JSON.stringify({ linkA, linkT }));
  const tl = async (token: string, q: string) => ((await http('GET', `/api/comment-templates?kind=all&${q}`, token)).body.templates as any[]).filter((x) => x.name.includes(tag)).map((x) => x.name).sort().join();
  check('filter personaId (A sees s1, a2 — not B\'s b1)', await tl(A.token, `personaId=${brand.id}`) === [`a2 ${tag}`, `s1 ${tag}`].sort().join());
  check('filter personaId as admin (s1, a2, b1)', await tl(T, `personaId=${brand.id}`) === [`a2 ${tag}`, `b1 ${tag}`, `s1 ${tag}`].sort().join());
  check('filter personaId=none', await tl(A.token, 'personaId=none') === `a4 ${tag}`);
  r = await http('GET', '/api/comment-templates?kind=all&personaId=nope', A.token);
  check('invalid personaId → 400', r.status === 400);
  r = await http('GET', '/api/comment-templates/facets?kind=all', A.token);
  check('facets return tags only', r.status === 200 && Array.isArray(r.body.tags) && !('personas' in r.body));

  // ================================================================ delete + merge
  r = await http('DELETE', `/api/personas/${old.id}`, T);
  const [s2row] = await db.select().from(TPL).where(eq(TPL.id, S2.id));
  check('delete public persona → 204, its templates become 未设人设', r.status === 204 && s2row?.personaId === null);
  {
    // no merge for personas: the endpoint is gone for owners and admins alike, nothing moves
    const tries = await Promise.all([
      http('POST', `/api/personas/${aCoach2.id}/merge`, A.token, { into: aCoach.id }),
      http('POST', `/api/personas/${chef.id}/merge`, T, { into: brand.id }),
    ]);
    const [a3row] = await db.select().from(TPL).where(eq(TPL.id, A3.id));
    const [s3row] = await db.select().from(TPL).where(eq(TPL.id, S3.id));
    const both = await db.select().from(P).where(inArray(P.id, [aCoach2.id, chef.id]));
    check('persona merge removed: POST /api/personas/:id/merge → 404 (owner and admin), templates and personas unchanged',
      tries.every((x) => x.status === 404) && a3row?.personaId === aCoach2.id && s3row?.personaId === chef.id && both.length === 2, tries.map((x) => x.status).join());
    check('counts unchanged (Brand as admin: s1 a2 b1 = 3)', count((await plist(T, 'scope=public')).items, brand.id) === 3);
  }
  r = await http('DELETE', `/api/personas/${bCoach.id}`, B.token);
  const [b2row] = await db.select().from(TPL).where(eq(TPL.id, B2.id));
  check('owner deletes own persona → template becomes 未设人设', r.status === 204 && b2row?.personaId === null);

  // ================================================================ audit
  await sleep(500);
  const acts = await sqlClient`select action, target, detail from audit_logs where at >= ${startedAt.toISOString()}::timestamptz and action like 'persona.%'`;
  const have = new Set(acts.map((x) => x.action as string));
  check('audit actions persona.create/update/delete recorded, no persona.merge', ['persona.create', 'persona.update', 'persona.delete'].every((x) => have.has(x)) && !have.has('persona.merge'), [...have].join());
  check('audit: names only (target = persona name, no description text)',
    acts.some((x) => x.action === 'persona.delete' && x.target === `Old ${tag}`)
      && !JSON.stringify(acts).includes('Upbeat') && !JSON.stringify(acts).includes('Calm'));
  const tplActs = await sqlClient`select detail from audit_logs where at >= ${startedAt.toISOString()}::timestamptz and action = 'comment.template_create' and target = ${`a1 ${tag}`}`;
  check('audit: template create records the persona name', tplActs[0]?.detail?.persona === `Coach ${tag} Pro`, JSON.stringify(tplActs[0]?.detail));

  // ================================================================ data migration (legacy free-text persona)
  const legacy = async (userId: string | null, persona: string) => {
    const [row] = await db.insert(TPL).values({ userId, kind: 'post', name: `mig ${tag} ${templateIds.length}`, text: 'x', persona }).returning();
    templateIds.push(row!.id);
    return row!.id;
  };
  const L = {
    s1: await legacy(null, ` Mig Chef ${tag} `), s2: await legacy(null, `mig chef ${tag}`), s3: await legacy(null, `Mig Chef ${tag}`),
    aChef: await legacy(A.id, `MIG CHEF ${tag}`), aCoach1: await legacy(A.id, `Mig Coach ${tag}`), aCoach2: await legacy(A.id, `mig coach ${tag}`),
    bCoach: await legacy(B.id, `Mig Coach ${tag}`), bPre: await legacy(B.id, `pre ${tag}`), bBlank: await legacy(B.id, '   '),
  };
  const run1 = await migratePersonaTexts(sqlClient, () => {});
  const run2 = await migratePersonaTexts(sqlClient, () => {});
  const ps = await db.select().from(P).where(ilike(P.name, `%mig%${tag}%`));
  const rows = await db.select().from(TPL).where(inArray(TPL.id, Object.values(L)));
  const pid = (id: string) => rows.find((x) => x.id === id)?.personaId;
  const pubChef = ps.find((p) => p.ownerType === 'public');
  const aMig = ps.find((p) => p.ownerId === A.id);
  const bMig = ps.find((p) => p.ownerId === B.id);
  check('migration run 1: 3 personas created, 8 templates linked; run 2: nothing', run1.created === 3 && run1.linked === 8 && run2.created === 0 && run2.linked === 0, JSON.stringify([run1, run2]));
  check('migration: shared text → one public persona (trimmed, most used spelling), also covering A\'s personal use',
    ps.length === 3 && pubChef?.name === `Mig Chef ${tag}` && [L.s1, L.s2, L.s3, L.aChef].every((id) => pid(id) === pubChef.id), ps.map((p) => `${p.ownerType}:${p.name}`).join());
  check('migration: personal-only texts → one personal persona per user (case-insensitive)',
    aMig?.ownerType === 'user' && pid(L.aCoach1) === aMig.id && pid(L.aCoach2) === aMig.id && bMig?.ownerType === 'user' && pid(L.bCoach) === bMig.id);
  check('migration: an existing public persona with the same name covers a personal text; blank text skipped',
    pid(L.bPre) === pre.id && pid(L.bBlank) === null);
  r = await http('DELETE', `/api/personas/${aMig!.id}`, A.token);
  r = await http('PUT', `/api/comment-templates/${L.s1}`, T, { personaId: null });
  const run3 = await migratePersonaTexts(sqlClient, () => {});
  const after = await db.select().from(TPL).where(inArray(TPL.id, [L.aCoach1, L.aCoach2, L.s1]));
  check('migration does not re-link templates whose persona was deleted or cleared', run3.created === 0 && run3.linked === 0 && after.every((x) => x.personaId === null && x.persona === null), JSON.stringify(run3));
  r = await http('GET', `/api/comment-templates?kind=all&personaId=${pubChef!.id}`, A.token);
  check('migrated templates are listed by persona (A: s2, s3, own aChef)', r.body.templates.length === 3, String(r.body.templates?.length));

  // ================================================================ migration 0036 (persona reset), rolled back
  {
    const { readFileSync } = await import('node:fs');
    const sqlText = readFileSync(new URL('../drizzle/0036_persona_reset.sql', import.meta.url), 'utf8');
    const stmts = sqlText.split('--> statement-breakpoint').map((x) => x.replace(/^\s*--.*$/gm, '').trim()).filter(Boolean);
    const acc = await http('POST', '/api/social/accounts', A.token, { platform: 'instagram', handle: `mig36_${tag}`, personaId: brand.id });
    const [content] = await db.insert(schema.contents).values({ userId: A.id, title: `ai ${tag}`, body: 'x', stage: 'draft', status: 'draft', platformHints: {},
      aiGenerated: { model: 'm', requestedModel: 'm', personaId: brand.id, personaName: 'Brand', taskId: null, generatedAt: new Date().toISOString(), mediaTags: [] } }).returning();
    const legacyT = (await db.insert(TPL).values({ userId: A.id, kind: 'post', name: `legacy36 ${tag}`, text: 'x', persona: 'Some legacy' }).returning())[0]!;
    templateIds.push(legacyT.id);
    const ROLLBACK = new Error('rollback');
    let seen: Record<string, number> = {};
    try {
      await sqlClient.begin(async (tx) => {
        const before = (await tx`select (select count(*) from personas)::int p, (select count(*) from comment_templates where persona_id is not null)::int t`)[0]!;
        for (const st of stmts) await tx.unsafe(st);
        const after = (await tx`select (select count(*) from personas)::int p, (select count(*) from comment_templates where persona_id is not null)::int t,
          (select count(*) from social_accounts where persona_id is not null or group_id is not null)::int a, (select count(*) from comment_templates where persona is not null)::int legacy,
          (select count(*) from contents where id = ${content!.id} and ai_generated->>'personaId' = ${brand.id})::int ai,
          (select count(*) from comment_templates where id = ${legacyT.id})::int kept`)[0]!;
        seen = { beforeP: before.p, beforeT: before.t, ...after };
        throw ROLLBACK;
      });
    } catch (e) { if (e !== ROLLBACK) throw e; }
    const still = await db.select().from(P).where(eq(P.id, brand.id));
    check('migration 0036: personas, their templates, 账号人设/groups and legacy texts cleared; templates without persona and contents.ai_generated kept (then rolled back)',
      acc.status === 201 && seen.beforeP! > 0 && seen.beforeT! > 0 && seen.p === 0 && seen.t === 0 && seen.a === 0 && seen.legacy === 0 && seen.ai === 1 && seen.kept === 1 && still.length === 1,
      JSON.stringify(seen));
    await db.delete(schema.contents).where(eq(schema.contents.id, content!.id));
  }
} catch (err) {
  check(`unexpected error: ${(err as Error).stack ?? (err as Error).message}`, false);
} finally {
  if (templateIds.length) await db.delete(TPL).where(inArray(TPL.id, templateIds));
  for (const id of userIds) await http('DELETE', `/api/users/${id}`, T);
  await db.delete(P).where(ilike(P.name, `%${tag}%`));
  const left = await db.select().from(P).where(ilike(P.name, `%${tag}%`));
  const leftT = await db.select().from(TPL).where(inArray(TPL.id, templateIds.length ? templateIds : ['00000000-0000-0000-0000-000000000000']));
  check('cleanup: test users, personas and templates removed', left.length === 0 && leftT.length === 0);
  await sqlClient.end();
  const failed = results.filter((x) => !x[1]).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}
