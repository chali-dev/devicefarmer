/**
 * 内容管理 without a manual 标签 UI (owner decision 2026-11-18): the editor no longer sends `tags`, so the API must
 * keep a content's tags (the system tag `ai-draft` and older manual ones) when a PUT omits them, and the list's
 * 「AI 草稿」 quick filter (`GET /api/contents?tag=ai-draft`) must still filter. Real API + DB, no mocks, no devices.
 * - A user content with tags [ai-draft, legacy-x] (created the way an older page or the AI draft writer does).
 * - PUT with exactly the editor's body (title, body, categoryId, mediaIds, platformHints, targetIds, stage) keeps both.
 * - Admin PUT on it (no tags) keeps them too; a PUT from an older page with `tags` still replaces them (API unchanged).
 * - A content created without `tags` (the editor's POST) has none.
 * - ?tag=ai-draft lists exactly the tagged one (case-insensitive, `#` stripped), the user never sees others' rows.
 * Usage (from apps/api, API running): E2E_API=http://127.0.0.1:3000 npx tsx --env-file=../../.env scripts/content-tags-ui-check.ts
 */
import { randomBytes } from 'node:crypto';
import { inArray } from 'drizzle-orm';
import { db, schema, sqlClient } from '../src/db/index.js';
import { withCaptcha } from './lib/login.js';

const API = process.env.E2E_API ?? 'http://127.0.0.1:3000';
const results: [string, boolean][] = [];
const check = (name: string, ok: boolean, detail = '') => { results.push([name, ok]); console.log(`${ok ? '✓' : '✗'} ${name}${detail && !ok ? ` — ${detail}` : ''}`); };

async function http<T = any>(method: string, p: string, token: string, body?: unknown) {
  const res = await fetch(API + p, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* 204 */ }
  return { status: res.status, body: json as T, text };
}
async function login(username: string, password: string): Promise<string> {
  const r = await fetch(`${API}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(await withCaptcha(API, { username, password })) });
  return (await r.json()).token;
}

const T = await login(process.env.ADMIN_USERNAME!, process.env.ADMIN_PASSWORD!);
const tag = randomBytes(3).toString('hex');
const pw = randomBytes(12).toString('hex');
const userIds: string[] = [];
const contentIds: string[] = [];
const sorted = (a: string[]) => [...a].sort();
const same = (a: string[], b: string[]) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));

try {
  const mk = async (name: string) => {
    const r = await http('POST', '/api/users', T, { username: name, password: pw, role: 'user' });
    const id = r.body.user?.id ?? r.body.id; userIds.push(id);
    return { id: id as string, token: await login(name, pw) };
  };
  const A = await mk(`tagui-a-${tag}`);
  const B = await mk(`tagui-b-${tag}`);

  // an older page / the AI draft writer: tags given on create
  const legacy = `legacy-${tag}`;
  const c1 = await http('POST', '/api/contents', A.token, { title: `tagui ${tag} one`, body: 'hello', tags: ['ai-draft', legacy] });
  check('create with tags (older page) → 201', c1.status === 201, c1.text);
  const id1 = c1.body.content.id as string; contentIds.push(id1);
  check('tags stored', same(c1.body.content.tags, ['ai-draft', legacy]), JSON.stringify(c1.body.content.tags));

  // the editor's POST now: no tags
  const c2 = await http('POST', '/api/contents', A.token, { title: `tagui ${tag} two`, body: 'world', categoryId: null, mediaIds: [], platformHints: {}, targetIds: [], stage: 'draft' });
  check('editor create without tags → 201, no tags', c2.status === 201 && c2.body.content.tags.length === 0, c2.text);
  contentIds.push(c2.body.content.id);
  const c3 = await http('POST', '/api/contents', B.token, { title: `tagui ${tag} other`, body: 'b', tags: ['ai-draft'] });
  contentIds.push(c3.body.content.id);

  // the editor's PUT (exact shape of ContentView.save): no tags
  const editorBody = (title: string) => ({ title, body: 'hello edited', categoryId: null, mediaIds: [], platformHints: {}, targetIds: [], stage: 'ready' });
  const u1 = await http('PUT', `/api/contents/${id1}`, A.token, editorBody(`tagui ${tag} one edited`));
  check('editor PUT without tags → 200', u1.status === 200, u1.text);
  check('editor PUT keeps ai-draft and the older manual tag', same(u1.body.content.tags, ['ai-draft', legacy]), JSON.stringify(u1.body.content.tags));
  const g1 = await http('GET', `/api/contents/${id1}`, A.token);
  check('detail after save still has both tags', same(g1.body.content.tags, ['ai-draft', legacy]) && g1.body.content.title.endsWith('edited'), JSON.stringify(g1.body.content?.tags));

  const u2 = await http('PUT', `/api/contents/${id1}`, T, editorBody(`tagui ${tag} one admin`));
  check('admin editor PUT keeps the tags', u2.status === 200 && same(u2.body.content.tags, ['ai-draft', legacy]), u2.text);

  // list filter (「AI 草稿」 quick filter)
  const l1 = await http('GET', `/api/contents?tag=ai-draft&q=${encodeURIComponent(`tagui ${tag}`)}`, A.token);
  check('?tag=ai-draft (user) lists exactly the tagged own content', l1.status === 200 && l1.body.items.length === 1 && l1.body.items[0].id === id1, JSON.stringify(l1.body.items?.map((x: any) => x.title)));
  const l2 = await http('GET', `/api/contents?tag=%23AI-Draft&q=${encodeURIComponent(`tagui ${tag}`)}`, A.token);
  check('?tag=#AI-Draft is case-insensitive, # stripped', l2.body.items.length === 1 && l2.body.items[0].id === id1);
  const l3 = await http('GET', `/api/contents?q=${encodeURIComponent(`tagui ${tag}`)}`, A.token);
  check('without the filter both own contents are listed', l3.body.items.length === 2);
  const l4 = await http('GET', `/api/contents?tag=ai-draft&status=ready&q=${encodeURIComponent(`tagui ${tag}`)}`, A.token);
  check('?status=ready&tag=ai-draft combine', l4.body.items.length === 1 && l4.body.items[0].id === id1);
  const l5 = await http('GET', `/api/contents?tag=ai-draft&q=${encodeURIComponent(`tagui ${tag}`)}`, T);
  check('admin ?tag=ai-draft sees both users\' tagged contents', l5.body.items.length === 2);

  // API unchanged: an older page's PUT with tags still replaces them
  const u3 = await http('PUT', `/api/contents/${id1}`, A.token, { tags: [legacy] });
  check('older page PUT with tags still replaces them (API unchanged)', u3.status === 200 && same(u3.body.content.tags, [legacy]), u3.text);
} finally {
  if (contentIds.length) await db.delete(schema.contents).where(inArray(schema.contents.id, contentIds));
  for (const id of userIds) await http('DELETE', `/api/users/${id}`, T);
  const left = await db.select({ id: schema.contents.id }).from(schema.contents).where(inArray(schema.contents.id, contentIds.length ? contentIds : ['00000000-0000-0000-0000-000000000000']));
  check('cleanup: test contents and users removed', left.length === 0);
  await sqlClient.end();
}
const failed = results.filter(([, ok]) => !ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
