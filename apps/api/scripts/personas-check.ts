/**
 * 人设 (personas) of the script library against the real API and DB. No mocks.
 * - CRUD + RBAC per scope: public personas admin-managed (users 403), personal ones private (others 404), admin all-users
 *   view with owner filter; names unique per owner, case-insensitive; validation.
 * - Template persona rules: every template needs a persona (template.persona_required, 2026-11-18: the 话术库 page is gone,
 *   templates are the 范例 of personas); shared template → public persona only; personal template → public or the owner's.
 * - 范例 limit: 20 per persona and kind (persona.examples_full; parallel inserts at 18 → exactly 2 more), moves between kinds.
 * - Counts per persona (templates and 账号人设 accounts, exact, per viewer), template filter personaId / none, facets without personas.
 * - Counts equal what the lists return (/social?personaId → accounts total; templates per persona: shared + own for users,
 *   shared + all-users for admins; a personal persona → its owner's templates only).
 * - Delete → its templates are deleted, accounts become 未设人设. No merge for personas (owner decision 2026-11-18): POST …/merge → 404 for
 *   everyone, nothing moved.
 * - The one persona form (owner decision 2026-11-18): 定位 (description), style = shared topics + banned words,
 *   发文风格 `post` (tone + note, emoji, length, hashtags, audience, fixed opening/closing, notes) and 评论风格 `comment`
 *   (tone + note, emoji, length); strict validation (the old flat shape is refused), normalisation, defaults, no language;
 *   an old flat style stored in the DB is read as both kinds and only rewritten on save, GET /api/personas/:id (style for everyone who may see it, 范例 per kind in the persona's own scope,
 *   length ranges, no AI fields: daily drafts are per social account since 2026-11-18), admin-created examples for a user's personal persona (ownerId),
 *   banned words inside the fixed opening/closing refused.
 * - Creating a persona WITH 范例 (POST /api/personas `examples` {post, comment}): one transaction, form order kept, public →
 *   shared templates, admin for a user (ownerId) → that user's; more than 20 per kind → 400 and nothing created; a banned
 *   word of the new persona in an example → 400 persona.banned_word and nothing created; audit counts only.
 * - 复制到我的人设 (POST /api/personas/:id/copy): name 「(副本)」 + numbering (case-insensitive, parallel, 50 chars), 定位 + style +
 *   范例 equal and private to the new owner, no AI fields; 404 for invisible personas, 403 for a user's other ownerId, admin
 *   ownerId; one transaction (a seeded 21-example source fails with nothing left behind); audit persona.copy.
 * - Audit entries (names only).
 * Usage (from apps/api, API running): E2E_API=http://127.0.0.1:3000 npx tsx --env-file=../../.env scripts/personas-check.ts
 */
import { randomBytes } from 'node:crypto';
import { and, eq, ilike, inArray } from 'drizzle-orm';
import { db, schema, sqlClient } from '../src/db/index.js';
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
  check('persona responses carry the style with defaults (no legacy brief)', !('brief' in brand) && brand.style?.post?.tone === 'casual' && brand.style?.comment?.tone === 'casual');
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

  // ================================================================ the persona form: style (shared + 发文风格 + 评论风格), examples, GET /:id
  {
    const st = await persona(A.token, { scope: 'mine', name: `Style ${tag}`, description: '一句话定位', style: {
      topics: ['跑步', ' 跑步 ', 'Run', 'run'], bannedWords: ['Spam', 'spam', '违禁'],
      post: { tone: 'funny', toneNote: '  轻松吐槽  ', emoji: 'high', length: 'low', hashtags: ['#Run', 'run', 'morning run'], audience: '', opening: '早！', closing: '', notes: 'n' },
      comment: { tone: 'warm', toneNote: '', emoji: 'low', length: 'high' },
    } });
    const sp = st.body.persona;
    const ps = sp?.style?.post ?? {};
    const cs = sp?.style?.comment ?? {};
    check('create with style: shared lists + post + comment stored normalised (trimmed, de-duplicated case-insensitively, hashtags without # / spaces, empty texts dropped)',
      st.status === 201 && sp.style.topics.join() === '跑步,Run' && sp.style.bannedWords.join() === 'Spam,违禁'
        && ps.tone === 'funny' && ps.toneNote === '轻松吐槽' && ps.emoji === 'high' && ps.length === 'low' && ps.hashtags.join() === 'Run,morningrun'
        && !('audience' in ps) && ps.opening === '早！' && !('closing' in ps) && ps.notes === 'n'
        && cs.tone === 'warm' && !('toneNote' in cs) && cs.emoji === 'low' && cs.length === 'high' && !('hashtags' in cs)
        && !('tone' in sp.style) && !('hashtags' in sp.style) && sp.description === '一句话定位',
      JSON.stringify(sp?.style ?? st.body));
    const [stored] = await db.select({ brief: P.style }).from(P).where(eq(P.id, sp.id));
    check('stored shape (personas.brief): { topics, bannedWords, post, comment } only, no flat keys',
      Object.keys(stored?.brief ?? {}).sort().join() === 'bannedWords,comment,post,topics', JSON.stringify(stored?.brief));
    const plain = (await persona(A.token, { scope: 'mine', name: `Plain ${tag}` })).body.persona;
    check('defaults on read: both kinds tone casual, emoji medium, length medium; empty lists',
      ['post', 'comment'].every((k) => plain.style[k].tone === 'casual' && plain.style[k].emoji === 'medium' && plain.style[k].length === 'medium')
      && plain.style.topics.length === 0 && plain.style.bannedWords.length === 0 && plain.style.post.hashtags.length === 0, JSON.stringify(plain.style));
    const bad = await Promise.all([
      http('PATCH', `/api/personas/${plain.id}`, A.token, { style: { post: { tone: 'angry' } } }),
      http('PATCH', `/api/personas/${plain.id}`, A.token, { style: { comment: { emoji: 'tons' } } }),
      http('PATCH', `/api/personas/${plain.id}`, A.token, { style: { lang: 'en' } }),
      http('PATCH', `/api/personas/${plain.id}`, A.token, { style: { bannedWords: Array.from({ length: 51 }, (_, k) => `w${k}`) } }),
      http('PATCH', `/api/personas/${plain.id}`, A.token, { style: { post: { notes: 'n'.repeat(1001) } } }),
      http('PATCH', `/api/personas/${plain.id}`, A.token, { style: { tone: 'pro' } }),
      http('PATCH', `/api/personas/${plain.id}`, A.token, { style: { comment: { hashtags: ['x'] } } }),
      http('PATCH', `/api/personas/${plain.id}`, A.token, { style: { comment: { opening: 'x' } } }),
    ]);
    check('style validation: unknown tone/emoji, a language, > 50 banned words, notes > 1000, the old flat shape, post-only fields in comment → 400',
      bad.every((x) => x.status === 400), bad.map((x) => x.status).join());
    let x = await http('PATCH', `/api/personas/${plain.id}`, A.token, { style: { bannedWords: ['早'], post: { opening: '早上好' } } });
    check('a banned word inside the fixed opening/closing of the post style → 400 persona.banned_in_style', x.status === 400 && x.body.code === 'persona.banned_in_style', `${x.status} ${x.body?.code}`);
    x = await http('PATCH', `/api/personas/${plain.id}`, A.token, { style: { post: { tone: 'pro', length: 'high' } }, description: '专业' });
    check('PATCH replaces the whole style together with the description (comment back to defaults)', x.status === 200 && x.body.persona.style.post.tone === 'pro'
      && x.body.persona.style.post.length === 'high' && x.body.persona.style.post.emoji === 'medium' && x.body.persona.style.comment.tone === 'casual' && x.body.persona.description === '专业');

    // compatibility: a persona saved before the split (flat brief) is read as both post and comment style
    const [flat] = await db.insert(P).values({ ownerType: 'user', ownerId: A.id, name: `Flat ${tag}`, style: {
      tone: 'cool', toneNote: '少说话', emoji: 'low', length: 'high', topics: ['咖啡'], bannedWords: ['便宜'], hashtags: ['coffee'], audience: '上班族', opening: '嗨', closing: '回见', notes: '旧备注',
    } }).returning();
    x = await http('GET', `/api/personas/${flat!.id}`, A.token);
    const fs = x.body?.persona?.style;
    check('old flat style read: shared topics/banned words; post = tone/note/emoji/length + hashtags/audience/opening/closing/notes; comment = the same tone/note/emoji/length',
      x.status === 200 && fs.topics.join() === '咖啡' && fs.bannedWords.join() === '便宜'
        && fs.post.tone === 'cool' && fs.post.toneNote === '少说话' && fs.post.emoji === 'low' && fs.post.length === 'high' && fs.post.hashtags.join() === 'coffee'
        && fs.post.audience === '上班族' && fs.post.opening === '嗨' && fs.post.closing === '回见' && fs.post.notes === '旧备注'
        && fs.comment.tone === 'cool' && fs.comment.toneNote === '少说话' && fs.comment.emoji === 'low' && fs.comment.length === 'high' && !('opening' in fs.comment)
        && !('tone' in fs), JSON.stringify(fs));
    const flatList = (await plist(A.token, 'scope=mine')).items.find((p) => p.id === flat!.id);
    check('old flat style read the same way in the list', flatList?.style?.comment?.tone === 'cool' && flatList?.style?.post?.closing === '回见', JSON.stringify(flatList?.style));
    const [flatRow] = await db.select({ brief: P.style }).from(P).where(eq(P.id, flat!.id));
    check('reading does not rewrite the stored flat style (no data migration)', (flatRow?.brief as any)?.tone === 'cool' && !('post' in (flatRow?.brief ?? {})));
    x = await http('PATCH', `/api/personas/${flat!.id}`, A.token, { style: { ...fs, comment: { ...fs.comment, tone: 'warm' } } });
    const [flatRow2] = await db.select({ brief: P.style }).from(P).where(eq(P.id, flat!.id));
    check('saving an old persona stores the split shape (post keeps the old values, comment changed)',
      x.status === 200 && (flatRow2?.brief as any)?.post?.closing === '回见' && (flatRow2?.brief as any)?.comment?.tone === 'warm' && !('tone' in (flatRow2?.brief ?? {})),
      JSON.stringify(flatRow2?.brief));

    // examples: own templates of the persona; admin adds one for A (ownerId)
    const ex1 = await http('POST', '/api/comment-templates', A.token, { kind: 'post', name: 'e1', text: `发文范例 ${tag}`, personaId: sp.id });
    const ex2 = await http('POST', '/api/comment-templates', A.token, { kind: 'comment', name: 'e2', text: `回复范例 ${tag}`, personaId: sp.id });
    const ex3 = await http('POST', '/api/comment-templates', T, { kind: 'comment', name: 'e3', text: `管理员替 A 写的回复范例 ${tag}`, personaId: sp.id, ownerId: A.id });
    const ex4 = await http('POST', '/api/comment-templates', B.token, { kind: 'comment', name: 'e4', text: 'x', personaId: sp.id, ownerId: A.id });
    for (const e of [ex1, ex2, ex3]) if (e.body?.template?.id) templateIds.push(e.body.template.id);
    check('examples: owner adds post + comment examples; admin adds one for A (ownerId → A\'s private template); a user cannot use ownerId (403)',
      ex1.status === 201 && ex2.status === 201 && ex3.status === 201 && ex3.body.template.userId === A.id && ex3.body.template.shared === false && ex4.status === 403,
      `${ex1.status} ${ex2.status} ${ex3.status} ${ex4.status}`);
    x = await http('GET', `/api/personas/${sp.id}`, A.token);
    check('GET /api/personas/:id: style, examples per kind (oldest first), lengths, maxExamples 20, no legacy AI fields (draft owner/runs/draftEnabled)',
      x.status === 200 && x.body.examples.post.map((e: any) => e.text).join() === `发文范例 ${tag}` && x.body.examples.comment.map((e: any) => e.text).join() === `回复范例 ${tag},管理员替 A 写的回复范例 ${tag}`
        && x.body.lengths.comment.low.join() === '4,30' && x.body.lengths.post.medium.join() === '150,500' && x.body.maxExamples === 20
        && !('draftOwnerName' in x.body.persona) && !('runs' in x.body.persona) && !('draftEnabled' in x.body.persona) && !('draftsPerDay' in x.body.persona)
        && x.body.persona.style.bannedWords.join() === 'Spam,违禁', JSON.stringify(x.body).slice(0, 400));

    // 范例 limit: 20 per persona and kind (post / comment counted separately), under a lock on the persona row
    const lim = (await persona(A.token, { scope: 'mine', name: `Limit ${tag}` })).body.persona;
    const add = async (kind: string, i: number) => {
      const y = await http('POST', '/api/comment-templates', A.token, { kind, name: `lim ${tag} ${kind} ${i}`, text: `范例 ${i}`, personaId: lim.id });
      if (y.body?.template?.id) templateIds.push(y.body.template.id);
      return y;
    };
    const first = [];
    for (let i = 0; i < 18; i++) first.push((await add('post', i)).status);
    const race = await Promise.all([18, 19, 20, 21].map((i) => add('post', i)));
    const raceOk = race.filter((y) => y.status === 201).length;
    const full = race.filter((y) => y.status === 400 && y.body.code === 'persona.examples_full');
    const [cnt] = await sqlClient`select count(*)::int n from comment_templates where persona_id = ${lim.id} and kind = 'post'`;
    check('20 post examples accepted (4 parallel at 18 → exactly 2 more), the rest → 400 persona.examples_full {max: 20}',
      first.every((s) => s === 201) && raceOk === 2 && full.length === 2 && full[0]!.body.params?.max === 20 && cnt!.n === 20, `${raceOk} ${cnt!.n} ${race.map((y) => y.status).join()}`);
    const c1 = await add('comment', 0);
    check('comment examples are counted separately (21st example as comment → 201)', c1.status === 201);
    let y = await http('PUT', `/api/comment-templates/${c1.body.template.id}`, A.token, { kind: 'post' });
    check('moving a comment example onto the full post list → 400 persona.examples_full', y.status === 400 && y.body.code === 'persona.examples_full', `${y.status} ${y.body?.code}`);
    const one = race.find((z) => z.status === 201)!.body.template.id;
    y = await http('PUT', `/api/comment-templates/${one}`, A.token, { text: '改过的范例', name: 'renamed' });
    check('editing the text of an example of a full list → 200', y.status === 200);
    await http('DELETE', `/api/comment-templates/${one}`, A.token);
    y = await http('PUT', `/api/comment-templates/${c1.body.template.id}`, A.token, { kind: 'post' });
    check('after deleting one, the move fits again (→ 200)', y.status === 200);
    const bigOwn = await http('POST', '/api/comment-templates', T, { kind: 'post', name: `lim ${tag} admin`, text: 'x', personaId: lim.id, ownerId: A.id });
    check('the limit also applies to an admin writing for the owner (ownerId) → 400', bigOwn.status === 400 && bigOwn.body.code === 'persona.examples_full');
    x = await http('GET', `/api/personas/${lim.id}`, A.token);
    check('GET /:id lists all 20 post examples', x.body.examples.post.length === 20 && x.body.examples.comment.length === 0, `${x.body.examples.post.length}/${x.body.examples.comment.length}`);

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
    check('list carries style and the length table', l2.body.personas.find((p: any) => p.id === sp.id)?.style?.post?.tone === 'funny' && !!l2.body.lengths?.post?.high);
    await http('DELETE', `/api/personas/${lim.id}`, A.token);
    const [limLeft] = await sqlClient`select count(*)::int n from comment_templates where persona_id = ${lim.id}`;
    check('deleting a persona deletes its examples (templates need a persona)', limLeft!.n === 0);
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
  r = await tpl(A.token, { name: `a0 ${tag}` });
  const r0 = await tpl(A.token, { name: `a0 ${tag}`, personaId: null });
  check('template without a persona → 400 template.persona_required (missing or null)', r.status === 400 && r.body.code === 'template.persona_required' && r0.status === 400
    && r0.body.code === 'template.persona_required', `${r.status} ${r.body?.code} ${r0.status}`);
  const A4 = (await tpl(A.token, { name: `a4 ${tag}`, personaId: pre.id })).body.template;
  const B1 = (await tpl(B.token, { name: `b1 ${tag}`, personaId: brand.id })).body.template;
  const B2 = (await tpl(B.token, { name: `b2 ${tag}`, personaId: bCoach.id })).body.template;
  check('templates with allowed personas (shared → public; personal → public or own); persona returned as an object',
    S1?.persona?.name === `Brand ${tag}` && S1.persona.ownerType === 'public' && A1?.persona?.id === aCoach.id && A2?.persona?.id === brand.id
      && B2?.persona?.id === bCoach.id && A4?.persona?.id === pre.id && A1.persona.description === null);
  r = await http('PUT', `/api/comment-templates/${A4.id}`, A.token, { personaId: bCoach.id });
  check('update personal template to another user\'s persona → 400', r.status === 400 && r.body.code === 'persona.not_allowed');
  r = await http('PUT', `/api/comment-templates/${S2.id}`, T, { personaId: aCoach.id });
  check('update shared template to a personal persona → 400 (also for admins)', r.status === 400 && r.body.code === 'persona.not_allowed');
  r = await http('PUT', `/api/comment-templates/${A4.id}`, T, { personaId: aCoach.id });
  const r6 = await http('PUT', `/api/comment-templates/${A4.id}`, T, { personaId: bCoach.id });
  check('admin editing A\'s template: A\'s persona ok, B\'s → 400', r.status === 200 && r.body.template.persona?.id === aCoach.id && r6.status === 400);
  r = await http('PUT', `/api/comment-templates/${A4.id}`, A.token, { personaId: null });
  check('personaId null → 400 template.persona_required (a template keeps its persona)', r.status === 400 && r.body.code === 'template.persona_required', `${r.status} ${r.body?.code}`);
  r = await http('DELETE', `/api/comment-templates/${A4.id}`, A.token);
  check('owner deletes the template', r.status === 204);

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
  check('filter personaId=none: nothing (every template has a persona)', await tl(A.token, 'personaId=none') === '');
  r = await http('GET', '/api/comment-templates?kind=all&personaId=nope', A.token);
  check('invalid personaId → 400', r.status === 400);
  r = await http('GET', '/api/comment-templates/facets?kind=all', A.token);
  check('facets return tags only', r.status === 200 && Array.isArray(r.body.tags) && !('personas' in r.body));

  // ================================================================ delete + merge
  r = await http('DELETE', `/api/personas/${old.id}`, T);
  const [s2row] = await db.select().from(TPL).where(eq(TPL.id, S2.id));
  check('delete public persona → 204, its templates (范例) are deleted with it', r.status === 204 && s2row === undefined);
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
  check('owner deletes own persona → its template is deleted too', r.status === 204 && b2row === undefined);

  // ================================================================ creating a persona with 范例 (one transaction)
  {
    const nm = `WithEx ${tag}`;
    const c = await persona(A.token, { scope: 'mine', name: nm, style: { bannedWords: ['禁词'] }, examples: { post: [`发文甲 ${tag}`, `发文乙 ${tag}`], comment: [`评论甲 ${tag}`] } });
    const pid = c.body?.persona?.id;
    const d = (await http('GET', `/api/personas/${pid}`, A.token)).body;
    const rows = pid ? await db.select().from(TPL).where(eq(TPL.personaId, pid)) : [];
    check('create with examples → 201: 2 post + 1 comment 范例 in form order, private templates of A, names = text start',
      c.status === 201 && d.examples.post.map((e: any) => e.text).join() === `发文甲 ${tag},发文乙 ${tag}` && d.examples.comment.map((e: any) => e.text).join() === `评论甲 ${tag}`
        && rows.length === 3 && rows.every((t) => t.userId === A.id && t.createdBy === A.id) && rows.some((t) => t.name === `发文甲 ${tag}`), `${c.status} ${c.text.slice(0, 200)}`);
    const pub = await persona(T, { scope: 'public', name: `WithExPub ${tag}`, examples: { post: [`公共甲 ${tag}`] } });
    const forA = await persona(T, { scope: 'mine', ownerId: A.id, name: `WithExForA ${tag}`, examples: { comment: [`替A ${tag}`] } });
    const pubRows = pub.body?.persona ? await db.select().from(TPL).where(eq(TPL.personaId, pub.body.persona.id)) : [];
    const forARows = forA.body?.persona ? await db.select().from(TPL).where(eq(TPL.personaId, forA.body.persona.id)) : [];
    check('public persona with examples → shared templates; admin for A (ownerId) → A\'s templates',
      pub.status === 201 && pubRows.length === 1 && pubRows[0]!.userId === null && forA.status === 201 && forARows.length === 1 && forARows[0]!.userId === A.id && forARows[0]!.kind === 'comment',
      `${pub.status} ${forA.status}`);
    const many = Array.from({ length: 21 }, (_, i) => `多 ${i}`);
    const big = await persona(A.token, { scope: 'mine', name: `TooMany ${tag}`, examples: { post: many } });
    const bigC = await persona(A.token, { scope: 'mine', name: `TooManyC ${tag}`, examples: { comment: many } });
    const longC = await persona(A.token, { scope: 'mine', name: `TooLong ${tag}`, examples: { comment: ['x'.repeat(501)] } });
    const ban = await persona(A.token, { scope: 'mine', name: `Banned ${tag}`, style: { bannedWords: ['最便宜'] }, examples: { post: ['普通一条'], comment: ['这是全网最便宜的'] } });
    const left = await db.select({ id: schema.personas.id }).from(schema.personas)
      .where(inArray(schema.personas.name, [`TooMany ${tag}`, `TooManyC ${tag}`, `TooLong ${tag}`, `Banned ${tag}`]));
    const leftTpl = await db.select({ id: TPL.id }).from(TPL).where(inArray(TPL.text, ['普通一条', '这是全网最便宜的', '多 0']));
    check('21 post / 21 comment examples or a 501-char comment → 400; a banned word in an example → 400 persona.banned_word; nothing created',
      big.status === 400 && bigC.status === 400 && longC.status === 400 && ban.status === 400 && ban.body.code === 'persona.banned_word' && ban.body.params?.words === '最便宜'
        && left.length === 0 && leftTpl.length === 0, `${big.status} ${bigC.status} ${longC.status} ${ban.status} ${ban.body?.code} left=${left.length}/${leftTpl.length}`);
    const dup = await persona(A.token, { scope: 'mine', name: nm.toUpperCase(), examples: { post: [`重名 ${tag}`] } });
    const dupTpl = await db.select({ id: TPL.id }).from(TPL).where(eq(TPL.text, `重名 ${tag}`));
    check('duplicate name with examples → 409 persona.exists, no template left behind', dup.status === 409 && dup.body.code === 'persona.exists' && dupTpl.length === 0, `${dup.status} ${dup.body?.code}`);
    await sleep(400);
    const au = (await db.select().from(schema.auditLogs).where(and(eq(schema.auditLogs.action, 'persona.create'), eq(schema.auditLogs.target, nm))))[0];
    check('audit persona.create: example counts only, no texts', (au?.detail as any)?.examples?.post === 2 && (au?.detail as any)?.examples?.comment === 1 && !JSON.stringify(au?.detail).includes('发文甲'),
      JSON.stringify(au?.detail));
  }

  // ================================================================ 复制到我的人设 (POST /api/personas/:id/copy)
  const copyIds: { src: string; id: string }[] = [];
  {
    const [adminRow] = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.username, process.env.ADMIN_USERNAME!));
    const adminId = adminRow!.id;
    const style = {
      topics: ['跑步', '早餐'], bannedWords: ['广告', '最便宜'],
      post: { tone: 'pro', toneNote: '干货', emoji: 'low', length: 'high', hashtags: ['run', 'morning'], audience: '上班族', opening: '早安', closing: '明天见', notes: '少用感叹号' },
      comment: { tone: 'warm', toneNote: '温柔', emoji: 'high', length: 'low' },
    };
    const src = (await persona(T, { scope: 'public', name: `Copy ${tag}`, description: '复制定位', style })).body.persona;
    const ex = async (token: string, body: Record<string, unknown>) => {
      const x = await http('POST', '/api/comment-templates', token, body);
      if (x.body?.template?.id) templateIds.push(x.body.template.id);
      return x;
    };
    const exs = [
      await ex(T, { shared: true, kind: 'post', name: 'p1', text: `发文一 ${tag}`, personaId: src.id, tags: ['a'] }),
      await ex(T, { shared: true, kind: 'comment', name: 'c1', text: `评论一 ${tag}`, personaId: src.id }),
      await ex(T, { shared: true, kind: 'post', name: 'p2', text: `发文二 ${tag}`, personaId: src.id, tags: ['b', 'c'] }),
      await ex(T, { shared: true, kind: 'comment', name: 'c2', text: `评论二 ${tag}`, personaId: src.id }),
      await ex(A.token, { kind: 'post', name: 'own', text: `A 自己的 ${tag}`, personaId: src.id }), // A's private template on the public persona: not one of its 范例
    ];
    check('copy setup: public persona with style, 2 post + 2 comment examples', !!src?.id && exs.every((x) => x.status === 201), exs.map((x) => x.status).join());
    const srcDetail = (await http('GET', `/api/personas/${src.id}`, T)).body;

    let c = await http('POST', `/api/personas/${src.id}/copy`, A.token);
    const cp = c.body?.persona;
    if (cp) copyIds.push({ src: src.id, id: cp.id });
    check('user copies a public persona → 201, personal persona of the caller named 「原名 (副本)」, examples {post 2, comment 2}',
      c.status === 201 && cp.ownerType === 'user' && cp.ownerId === A.id && cp.name === `Copy ${tag} (副本)` && c.body.examples.post === 2 && c.body.examples.comment === 2,
      `${c.status} ${c.text.slice(0, 200)}`);
    const d = (await http('GET', `/api/personas/${cp?.id}`, A.token)).body;
    check('copy: 定位 and the whole style (shared + 发文 + 评论) equal the source',
      d.persona.description === '复制定位' && JSON.stringify(d.persona.style) === JSON.stringify(srcDetail.persona.style) && d.persona.style.post.closing === '明天见' && d.persona.style.comment.tone === 'warm',
      JSON.stringify(d.persona.style));
    check('copy: no legacy AI fields in the response (daily drafts are per social account)',
      !('draftEnabled' in cp) && !('draftOwnerId' in cp) && !('draftOwnerName' in d.persona));
    check('copy: examples per kind equal the source in the same order (A\'s own template on the source not copied)',
      d.examples.post.map((e: any) => `${e.name}:${e.text}`).join() === srcDetail.examples.post.map((e: any) => `${e.name}:${e.text}`).join()
        && d.examples.comment.map((e: any) => e.text).join() === `评论一 ${tag},评论二 ${tag}` && d.examples.post.length === 2,
      JSON.stringify(d.examples));
    const copied = await db.select().from(TPL).where(eq(TPL.personaId, cp.id));
    check('copy: examples are private templates of the caller on the new persona, tags kept',
      copied.length === 4 && copied.every((t) => t.userId === A.id && t.createdBy === A.id)
        && copied.find((t) => t.name === 'p2')?.tags.join() === 'b,c', JSON.stringify(copied.map((t) => [t.userId, t.name, t.tags])));
    const srcAfter = await db.select().from(TPL).where(eq(TPL.personaId, src.id));
    check('copy: the source keeps its 4 shared examples (+ A\'s own template)', srcAfter.length === 5 && srcAfter.filter((t) => t.userId === null).length === 4);
    const mineList = await plist(A.token, 'scope=mine');
    check('copy is listed under 我的人设 with count 4', mineList.items.find((p) => p.id === cp.id)?.count === 4);

    // names: next free number, case-insensitive
    c = await http('POST', `/api/personas/${src.id}/copy`, A.token, {});
    if (c.body?.persona) copyIds.push({ src: src.id, id: c.body.persona.id });
    const taken = await persona(A.token, { scope: 'mine', name: `COPY ${tag.toUpperCase()} (副本 3)` });
    const c3 = await http('POST', `/api/personas/${src.id}/copy`, A.token, { ownerId: A.id });
    if (c3.body?.persona) copyIds.push({ src: src.id, id: c3.body.persona.id });
    check('names: second copy 「(副本 2)」; with 「COPY … (副本 3)」 taken (other case) the next is 「(副本 4)」; ownerId = self allowed',
      c.status === 201 && c.body.persona.name === `Copy ${tag} (副本 2)` && taken.status === 201 && c3.status === 201 && c3.body.persona.name === `Copy ${tag} (副本 4)`,
      `${c.body?.persona?.name} | ${c3.status} ${c3.body?.persona?.name ?? c3.text}`);
    const longSrc = (await persona(T, { scope: 'public', name: `${tag}${'长'.repeat(44)}` })).body.persona;
    c = await http('POST', `/api/personas/${longSrc.id}/copy`, A.token);
    check('a 50-character name is shortened so 「 (副本)」 fits (≤ 50)', c.status === 201 && [...c.body.persona.name].length === 50 && c.body.persona.name.endsWith(' (副本)')
      && c.body.persona.name.startsWith(tag), `${c.status} ${c.body?.persona?.name}`);
    const par = await Promise.all([1, 2, 3].map(() => http('POST', `/api/personas/${src.id}/copy`, B.token)));
    check('3 parallel copies by one user → 3 × 201 with distinct names (副本, 副本 2, 副本 3)',
      par.every((x) => x.status === 201) && par.map((x) => x.body.persona.name).sort().join() === [`Copy ${tag} (副本)`, `Copy ${tag} (副本 2)`, `Copy ${tag} (副本 3)`].sort().join(),
      par.map((x) => `${x.status} ${x.body?.persona?.name ?? x.body?.code}`).join());

    // RBAC
    const bOwn = (await persona(B.token, { scope: 'mine', name: `BOwn ${tag}`, description: 'B 的定位', style })).body.persona;
    await ex(B.token, { kind: 'comment', name: 'bc', text: `B 评论 ${tag}`, personaId: bOwn.id });
    const before = (await sqlClient`select (select count(*) from personas)::int p, (select count(*) from comment_templates)::int t`)[0]!;
    const n1 = await http('POST', `/api/personas/${bOwn.id}/copy`, A.token);
    const n2 = await http('POST', '/api/personas/00000000-0000-4000-8000-000000000000/copy', A.token);
    check('another user\'s personal persona / unknown id → 404 persona.not_found', n1.status === 404 && n1.body.code === 'persona.not_found' && n2.status === 404 && n2.body.code === 'persona.not_found',
      `${n1.status} ${n1.body?.code} ${n2.status}`);
    const f1 = await http('POST', `/api/personas/${src.id}/copy`, A.token, { ownerId: B.id });
    check('user with another ownerId → 403 persona.admin_only', f1.status === 403 && f1.body.code === 'persona.admin_only', `${f1.status} ${f1.body?.code}`);
    const ub = await http('POST', `/api/personas/${src.id}/copy`, A.token, { ownerId: 'x' });
    const ux = await http('POST', `/api/personas/${src.id}/copy`, A.token, { ownerId: A.id, name: 'x' });
    check('invalid body (ownerId not a uuid, unknown field) → 400', ub.status === 400 && ux.status === 400, `${ub.status} ${ux.status}`);
    const after = (await sqlClient`select (select count(*) from personas)::int p, (select count(*) from comment_templates)::int t`)[0]!;
    check('refused copies create nothing', before.p === after.p && before.t === after.t, JSON.stringify([before, after]));
    const own = await http('POST', `/api/personas/${bOwn.id}/copy`, B.token);
    if (own.body?.persona) copyIds.push({ src: bOwn.id, id: own.body.persona.id });
    const ownT = own.body?.persona ? await db.select().from(TPL).where(eq(TPL.personaId, own.body.persona.id)) : [];
    check('owner copies an own personal persona → 「BOwn … (副本)」 with its example', own.status === 201 && own.body.persona.name === `BOwn ${tag} (副本)`
      && own.body.persona.description === 'B 的定位' && ownT.length === 1 && ownT[0]!.userId === B.id);
    const ad = await http('POST', `/api/personas/${bOwn.id}/copy`, T, { ownerId: A.id });
    if (ad.body?.persona) copyIds.push({ src: bOwn.id, id: ad.body.persona.id });
    const adT = ad.body?.persona ? await db.select().from(TPL).where(eq(TPL.personaId, ad.body.persona.id)) : [];
    check('admin copies B\'s personal persona to A (ownerId): A\'s persona, B\'s example becomes A\'s private template', ad.status === 201 && ad.body.persona.ownerId === A.id
      && ad.body.persona.name === `BOwn ${tag} (副本)` && adT.length === 1 && adT[0]!.userId === A.id && adT[0]!.text === `B 评论 ${tag}`, `${ad.status} ${ad.text.slice(0, 200)}`);
    const self = await http('POST', `/api/personas/${src.id}/copy`, T);
    if (self.body?.persona) copyIds.push({ src: src.id, id: self.body.persona.id });
    check('admin without ownerId → own personal persona', self.status === 201 && self.body.persona.ownerId === adminId && self.body.persona.ownerType === 'user');
    const nu = await http('POST', `/api/personas/${src.id}/copy`, T, { ownerId: '00000000-0000-4000-8000-000000000000' });
    check('admin with an unknown ownerId → 404 users.not_found', nu.status === 404 && nu.body.code === 'users.not_found', `${nu.status} ${nu.body?.code}`);

    // one transaction: a source with 21 post examples (seeded past the API limit) fails after the persona and the first
    // templates were inserted → nothing left behind
    const big = (await persona(T, { scope: 'public', name: `Big ${tag}` })).body.persona;
    const seeded = await db.insert(TPL).values(Array.from({ length: 21 }, (_, i) => ({ userId: null, kind: 'post' as const, personaId: big.id, name: `big${i}`, text: `big ${i} ${tag}` }))).returning({ id: TPL.id });
    templateIds.push(...seeded.map((x) => x.id));
    const b0 = (await sqlClient`select (select count(*) from personas)::int p, (select count(*) from comment_templates)::int t`)[0]!;
    const bad = await http('POST', `/api/personas/${big.id}/copy`, A.token);
    const b1 = (await sqlClient`select (select count(*) from personas)::int p, (select count(*) from comment_templates)::int t`)[0]!;
    const half = await db.select().from(P).where(ilike(P.name, `Big ${tag} (%`));
    check('transaction: a copy failing the 20-per-kind check (seeded 21) → 400 persona.examples_full, no persona and no templates left',
      bad.status === 400 && bad.body.code === 'persona.examples_full' && b0.p === b1.p && b0.t === b1.t && half.length === 0, `${bad.status} ${bad.body?.code} ${JSON.stringify([b0, b1])}`);
    const again = await http('POST', `/api/personas/${src.id}/copy`, A.token);
    if (again.body?.persona) copyIds.push({ src: src.id, id: again.body.persona.id });
    check('after the rolled-back copy the next copy works (「(副本 5)」)', again.status === 201 && again.body.persona.name === `Copy ${tag} (副本 5)`, again.body?.persona?.name);
  }

  // ================================================================ audit
  await sleep(500);
  const acts = await sqlClient`select action, target, detail from audit_logs where at >= ${startedAt.toISOString()}::timestamptz and action like 'persona.%'`;
  const have = new Set(acts.map((x) => x.action as string));
  check('audit actions persona.create/update/delete recorded, no persona.merge', ['persona.create', 'persona.update', 'persona.delete'].every((x) => have.has(x)) && !have.has('persona.merge'), [...have].join());
  check('audit: names only (target = persona name, no description text)',
    acts.some((x) => x.action === 'persona.delete' && x.target === `Old ${tag}`)
      && !JSON.stringify(acts).includes('Upbeat') && !JSON.stringify(acts).includes('Calm'));
  const copyActs = await sqlClient`select target, target_id, status, detail from audit_logs where at >= ${startedAt.toISOString()}::timestamptz and action = 'persona.copy' and status = 201`;
  check(`audit persona.copy: one entry per successful copy (${copyIds.length}+${3 + 1}), targetId/sourceId = source, id = new persona, no texts`,
    copyIds.every((x) => copyActs.some((a) => a.target_id === x.src && a.detail?.sourceId === x.src && a.detail?.id === x.id))
      && copyActs.length === copyIds.length + 3 + 1 && copyActs.some((a) => a.target === `Copy ${tag}`) && !JSON.stringify(copyActs).includes('复制定位'),
    `${copyActs.length} ${JSON.stringify(copyActs[0])}`);
  const failedCopy = await sqlClient`select status, detail from audit_logs where at >= ${startedAt.toISOString()}::timestamptz and action = 'persona.copy' and status >= 400`;
  check('audit persona.copy also records refused copies (404/403/400)', failedCopy.length >= 5, String(failedCopy.length));
  const tplActs = await sqlClient`select detail from audit_logs where at >= ${startedAt.toISOString()}::timestamptz and action = 'comment.template_create' and target = ${`a1 ${tag}`}`;
  check('audit: template create records the persona name', tplActs[0]?.detail?.persona === `Coach ${tag} Pro`, JSON.stringify(tplActs[0]?.detail));
} catch (err) {
  check(`unexpected error: ${(err as Error).stack ?? (err as Error).message}`, false);
} finally {
  if (templateIds.length) await db.delete(TPL).where(inArray(TPL.id, templateIds));
  // copies' examples (e.g. the admin's own copy, not removed with the test users)
  await db.delete(TPL).where(inArray(TPL.personaId, db.select({ id: P.id }).from(P).where(ilike(P.name, `%${tag}%`))));
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
