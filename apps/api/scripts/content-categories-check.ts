/**
 * 内容分类 (content categories) against the real API and DB. No mocks.
 * - CRUD + RBAC per scope: public categories admin-managed (users 403), personal ones private (others 404), admin
 *   all-users view with owner filter; names unique per owner, case-insensitive; validation.
 * - Content rules: a content takes a public category or one of its owner's (another user's → 400), categoryId null clears,
 *   admins editing a user's content are bound by the owner's categories.
 * - Counts per category (exact, per viewer), list filter categoryId / none, facets without categories.
 * - Delete → contents become 未分类; merge moves contents and deletes the source (scope rules).
 * - Audit entries (names only).
 * Usage (from apps/api, API running): E2E_API=http://127.0.0.1:3000 npx tsx --env-file=../../.env scripts/content-categories-check.ts
 */
import { randomBytes } from 'node:crypto';
import { eq, ilike, inArray } from 'drizzle-orm';
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
const C = schema.contents;
const CC = schema.contentCategories;

const T = await login(process.env.ADMIN_USERNAME!, process.env.ADMIN_PASSWORD!);
const tag = randomBytes(3).toString('hex');
const pw = randomBytes(12).toString('hex');
const userIds: string[] = [];
const contentIds: string[] = [];
const startedAt = new Date();

try {
  const mk = async (name: string) => {
    const r = await http('POST', '/api/users', T, { username: name, password: pw, role: 'user' });
    const id = r.body.user?.id ?? r.body.id; userIds.push(id);
    return { id, token: await login(name, pw) };
  };
  const A = await mk(`cca${tag}`);
  const B = await mk(`ccb${tag}`);
  const cat = (token: string, body: Record<string, unknown>) => http('POST', '/api/content-categories', token, body);
  const clist = async (token: string, q: string) => {
    const r = await http('GET', `/api/content-categories?${q}`, token);
    return { status: r.status, code: r.body?.code, items: ((r.body?.categories ?? []) as any[]).filter((x) => x.name.includes(tag)) };
  };

  // ================================================================ CRUD + RBAC
  let r = await cat(A.token, { scope: 'mine', name: `Vlog ${tag}`, description: 'Weekly vlogs' });
  const aVlog = r.body.category;
  check('user creates a personal category with description', r.status === 201 && aVlog.ownerType === 'user' && aVlog.ownerId === A.id && aVlog.description === 'Weekly vlogs');
  r = await cat(A.token, { scope: 'mine', name: `  VLOG ${tag.toUpperCase()} ` });
  check('same name in another case for the same owner → 409 content_category.exists', r.status === 409 && r.body.code === 'content_category.exists', `${r.status} ${r.body?.code}`);
  r = await cat(B.token, { scope: 'mine', name: `Vlog ${tag}` });
  const bVlog = r.body.category;
  check('another user may use the same name (unique per owner)', r.status === 201);
  r = await cat(A.token, { scope: 'public', name: `Event ${tag}` });
  const r2 = await cat(A.token, { scope: 'mine', ownerId: B.id, name: `x ${tag}` });
  check('user cannot create public categories or categories for others (403 content_category.admin_only)', r.status === 403 && r.body.code === 'content_category.admin_only' && r2.status === 403);
  const [event, launch, old, spare] = await Promise.all(['Event', 'Launch', 'Old', 'Spare'].map(async (n) => (await cat(T, { scope: 'public', name: `${n} ${tag}` })).body.category));
  check('admin creates public categories', [event, launch, old, spare].every((p) => p?.ownerType === 'public' && p.ownerId === null));
  r = await cat(T, { scope: 'public', name: `event ${tag.toUpperCase()}` });
  check('public names unique case-insensitively → 409', r.status === 409 && r.body.code === 'content_category.exists');
  r = await cat(T, { scope: 'mine', ownerId: A.id, name: `Food ${tag}` });
  const aFood = r.body.category;
  check('admin creates a personal category for a user (ownerId)', r.status === 201 && aFood.ownerId === A.id);
  r = await cat(A.token, { scope: 'mine', name: 'p'.repeat(51) });
  const r3 = await cat(A.token, { scope: 'mine', name: `d ${tag}`, description: 'd'.repeat(201) });
  const r4 = await cat(A.token, { scope: 'mine', name: '   ' });
  check('validation: name > 50, description > 200, blank name → 400', r.status === 400 && r3.status === 400 && r4.status === 400);

  let l = await clist(A.token, 'scope=public');
  check('user lists public categories (read-only)', l.status === 200 && l.items.length === 4 && l.items.every((x) => x.writable === false));
  l = await clist(A.token, 'scope=mine');
  check('user lists only own personal categories', l.items.map((x) => x.id).sort().join() === [aVlog.id, aFood.id].sort().join() && l.items.every((x) => x.writable), l.items.map((x) => x.name).join());
  l = await clist(A.token, 'scope=all-users');
  check('user all-users view → 403', l.status === 403 && l.code === 'content_category.admin_only');
  l = await clist(T, 'scope=all-users');
  check('admin all-users view: every user\'s personal categories with owner names', l.items.length === 3 && l.items.find((x) => x.id === bVlog.id)?.ownerName === `ccb${tag}`);
  l = await clist(T, `scope=all-users&ownerId=${A.id}`);
  check('admin all-users view filtered by owner', l.items.length === 2 && l.items.every((x) => x.ownerId === A.id));

  r = await http('PATCH', `/api/content-categories/${bVlog.id}`, A.token, { name: 'hijack' });
  const dB = await http('DELETE', `/api/content-categories/${bVlog.id}`, A.token);
  const mB = await http('POST', `/api/content-categories/${bVlog.id}/merge`, A.token, { into: aVlog.id });
  check('other user\'s personal category: PATCH/DELETE/merge → 404 content_category.not_found', r.status === 404 && dB.status === 404 && mB.status === 404 && r.body.code === 'content_category.not_found');
  r = await http('PATCH', `/api/content-categories/${event.id}`, A.token, { name: 'x' });
  const dP = await http('DELETE', `/api/content-categories/${event.id}`, A.token);
  check('user cannot edit/delete public categories (403)', r.status === 403 && dP.status === 403 && r.body.code === 'content_category.admin_only');
  r = await http('PATCH', `/api/content-categories/${aVlog.id}`, A.token, { name: `Vlog ${tag} Pro`, description: 'Daily', sort: 7 });
  check('owner renames / describes / sorts', r.status === 200 && r.body.category.name === `Vlog ${tag} Pro` && r.body.category.description === 'Daily' && r.body.category.sort === 7);
  r = await http('PATCH', `/api/content-categories/${aVlog.id}`, A.token, { description: '' });
  check('description "" → null', r.status === 200 && r.body.category.description === null);
  r = await http('PATCH', `/api/content-categories/${aVlog.id}`, A.token, { name: `food ${tag}` });
  check('rename onto an existing name (case-insensitive) → 409', r.status === 409 && r.body.code === 'content_category.exists');
  r = await http('PATCH', `/api/content-categories/${aVlog.id}`, A.token, {});
  check('empty update → 400 common.nothing_to_update', r.status === 400 && r.body.code === 'common.nothing_to_update');
  r = await http('PATCH', `/api/content-categories/${bVlog.id}`, T, { description: 'by admin' });
  check('admin edits a user\'s personal category', r.status === 200 && r.body.category.description === 'by admin');

  // ================================================================ content category rules
  const content = async (token: string, body: Record<string, unknown>) => {
    const x = await http('POST', '/api/contents', token, { body: 'x', ...body });
    if (x.body?.content?.id) contentIds.push(x.body.content.id);
    return x;
  };
  r = await content(A.token, { title: `a-bad ${tag}`, categoryId: bVlog.id });
  const r5 = await content(A.token, { title: `a-bad2 ${tag}`, categoryId: '7d3c4a1e-0000-4000-8000-000000000000' });
  check('content + another user\'s / unknown category → 400 content_category.not_allowed', r.status === 400 && r.body.code === 'content_category.not_allowed' && r5.status === 400, `${r.status} ${r.body?.code}`);
  r = await content(T, { title: `t-bad ${tag}`, ownerId: A.id, categoryId: bVlog.id });
  check('admin creating content for A with B\'s category → 400', r.status === 400 && r.body.code === 'content_category.not_allowed');
  const A1 = (await content(A.token, { title: `a1 ${tag}`, categoryId: aVlog.id })).body.content;
  const A2 = (await content(A.token, { title: `a2 ${tag}`, categoryId: event.id })).body.content;
  const A3 = (await content(A.token, { title: `a3 ${tag}`, categoryId: aFood.id })).body.content;
  const A4 = (await content(A.token, { title: `a4 ${tag}` })).body.content;
  const B1 = (await content(B.token, { title: `b1 ${tag}`, categoryId: event.id })).body.content;
  const B2 = (await content(B.token, { title: `b2 ${tag}`, categoryId: bVlog.id })).body.content;
  const T1 = (await content(T, { title: `t1 ${tag}`, categoryId: old.id })).body.content;
  const T2 = (await content(T, { title: `t2 ${tag}`, categoryId: launch.id })).body.content;
  const T3 = (await content(T, { title: `t3 ${tag}`, ownerId: A.id, categoryId: aFood.id })).body.content;
  check('contents with allowed categories (public or own); category returned as {id,name,ownerType,ownerId}',
    A1?.category?.id === aVlog.id && A1.category.name === `Vlog ${tag} Pro` && A1.category.ownerType === 'user' && A2?.category?.id === event.id
      && B2?.category?.id === bVlog.id && A4?.category === null && T3?.category?.id === aFood.id && T3.userId === A.id && A1.categoryId === aVlog.id);
  r = await http('PUT', `/api/contents/${A4.id}`, A.token, { categoryId: bVlog.id });
  check('update content to another user\'s category → 400', r.status === 400 && r.body.code === 'content_category.not_allowed');
  r = await http('PUT', `/api/contents/${A4.id}`, T, { categoryId: aVlog.id });
  const r6 = await http('PUT', `/api/contents/${A4.id}`, T, { categoryId: bVlog.id });
  check('admin editing A\'s content: A\'s category ok, B\'s → 400', r.status === 200 && r.body.content.category?.id === aVlog.id && r6.status === 400);
  r = await http('PUT', `/api/contents/${A4.id}`, A.token, { categoryId: null });
  check('categoryId null clears', r.status === 200 && r.body.content.category === null && r.body.content.categoryId === null);
  r = await http('PUT', `/api/contents/${A4.id}`, A.token, { title: `a4 ${tag}` });
  check('update without categoryId keeps it unchanged', r.status === 200 && r.body.content.category === null);
  r = await http('GET', `/api/contents/${A1.id}`, A.token);
  check('GET /api/contents/:id carries the category', r.status === 200 && r.body.content.category?.id === aVlog.id);

  // ================================================================ counts, filters, facets
  const count = (xs: any[], id: string) => xs.find((x) => x.id === id)?.count;
  const pubA = (await clist(A.token, 'scope=public')).items;
  const pubT = (await clist(T, 'scope=public')).items;
  const mineA = (await clist(A.token, 'scope=mine')).items;
  const allT = (await clist(T, `scope=all-users&ownerId=${A.id}`)).items;
  check('counts per viewer are exact (Event: A sees a2 = 1, admin 2; Old 1 (admin) / 1 (A sees count of own only → 0); Spare 0; A Food 2)',
    count(pubA, event.id) === 1 && count(pubT, event.id) === 2 && count(pubA, old.id) === 0 && count(pubT, old.id) === 1 && count(pubA, spare.id) === 0
      && count(mineA, aFood.id) === 2 && count(mineA, aVlog.id) === 1 && count(allT, aFood.id) === 2,
    JSON.stringify([count(pubA, event.id), count(pubT, event.id), count(pubA, old.id), count(pubT, old.id), count(mineA, aFood.id), count(mineA, aVlog.id)]));
  const cl = async (token: string, q: string) => ((await http('GET', `/api/contents?pageSize=100&q=${tag}&${q}`, token)).body.items as any[]).map((x) => x.title).sort().join();
  check('filter categoryId (A sees a2 — not B\'s b1)', await cl(A.token, `categoryId=${event.id}`) === `a2 ${tag}`);
  check('filter categoryId as admin (a2, b1)', await cl(T, `categoryId=${event.id}`) === [`a2 ${tag}`, `b1 ${tag}`].sort().join());
  check('filter categoryId=none (A: a4)', await cl(A.token, 'categoryId=none') === `a4 ${tag}`);
  r = await http('GET', '/api/contents?categoryId=nope', A.token);
  check('invalid categoryId filter → 400', r.status === 400);
  r = await http('GET', '/api/contents/facets', A.token);
  check('facets return tags only', r.status === 200 && Array.isArray(r.body.tags) && !('categories' in r.body));

  // ================================================================ delete + merge
  r = await http('DELETE', `/api/content-categories/${old.id}`, T);
  const [t1row] = await db.select().from(C).where(eq(C.id, T1.id));
  check('delete public category → 204, its contents become 未分类', r.status === 204 && t1row?.categoryId === null);
  r = await http('POST', `/api/content-categories/${aFood.id}/merge`, A.token, { into: aFood.id });
  check('merge into itself → 400 content_category.merge_same', r.status === 400 && r.body.code === 'content_category.merge_same');
  r = await http('POST', `/api/content-categories/${aFood.id}/merge`, T, { into: bVlog.id });
  check('merge personal into another user\'s category → 400 content_category.merge_scope', r.status === 400 && r.body.code === 'content_category.merge_scope');
  r = await http('POST', `/api/content-categories/${launch.id}/merge`, T, { into: aVlog.id });
  check('merge public into personal → 400 content_category.merge_scope', r.status === 400 && r.body.code === 'content_category.merge_scope');
  r = await http('POST', `/api/content-categories/${launch.id}/merge`, A.token, { into: event.id });
  check('user cannot merge public categories (403)', r.status === 403);
  r = await http('POST', `/api/content-categories/${aFood.id}/merge`, A.token, { into: aVlog.id });
  const moved1 = await db.select().from(C).where(inArray(C.id, [A3.id, T3.id]));
  const goneFood = await db.select().from(CC).where(eq(CC.id, aFood.id));
  check('merge personal → personal (same owner): contents moved, source deleted', r.status === 200 && r.body.moved === 2 && moved1.every((x) => x.categoryId === aVlog.id) && goneFood.length === 0);
  r = await http('POST', `/api/content-categories/${aVlog.id}/merge`, A.token, { into: event.id });
  const moved2 = await db.select().from(C).where(inArray(C.id, [A1.id, A3.id, T3.id]));
  check('merge personal → public', r.status === 200 && r.body.moved === 3 && moved2.every((x) => x.categoryId === event.id));
  r = await http('POST', `/api/content-categories/${launch.id}/merge`, T, { into: event.id });
  const [t2row] = await db.select().from(C).where(eq(C.id, T2.id));
  check('admin merges public → public', r.status === 200 && r.body.moved === 1 && t2row?.categoryId === event.id);
  check('counts after merges (Event as admin: a1 a2 a3 t3 b1 t2 = 6)', count((await clist(T, 'scope=public')).items, event.id) === 6);
  r = await http('DELETE', `/api/content-categories/${bVlog.id}`, B.token);
  const [b2row] = await db.select().from(C).where(eq(C.id, B2.id));
  check('owner deletes own category → content becomes 未分类', r.status === 204 && b2row?.categoryId === null);
  check('B1 untouched by other deletes', (await db.select().from(C).where(eq(C.id, B1.id)))[0]?.categoryId === event.id);

  // ================================================================ audit
  await sleep(500);
  const acts = await sqlClient`select action, target, detail from audit_logs where at >= ${startedAt.toISOString()}::timestamptz and action like 'content_category.%'`;
  const have = new Set(acts.map((x) => x.action as string));
  check('audit actions content_category.create/update/delete/merge recorded', ['content_category.create', 'content_category.update', 'content_category.delete', 'content_category.merge'].every((x) => have.has(x)), [...have].join());
  check('audit: names only (target = category name, merge target name + count, no description text)',
    acts.some((x) => x.action === 'content_category.delete' && x.target === `Old ${tag}`)
      && acts.some((x) => x.action === 'content_category.merge' && x.target === `Launch ${tag}` && x.detail?.into === `Event ${tag}` && x.detail?.contents === 1)
      && !JSON.stringify(acts).includes('Weekly vlogs') && !JSON.stringify(acts).includes('Daily'));
  const cActs = await sqlClient`select detail from audit_logs where at >= ${startedAt.toISOString()}::timestamptz and action = 'content.create' and target = ${`a1 ${tag}`}`;
  check('audit: content create records the category name', cActs[0]?.detail?.category === `Vlog ${tag} Pro`, JSON.stringify(cActs[0]?.detail));

} catch (err) {
  check(`unexpected error: ${(err as Error).stack ?? (err as Error).message}`, false);
} finally {
  if (contentIds.length) await db.delete(C).where(inArray(C.id, contentIds));
  for (const id of userIds) await http('DELETE', `/api/users/${id}`, T);
  await db.delete(CC).where(ilike(CC.name, `%${tag}%`));
  const left = await db.select().from(CC).where(ilike(CC.name, `%${tag}%`));
  const leftC = await db.select().from(C).where(inArray(C.id, contentIds.length ? contentIds : ['00000000-0000-0000-0000-000000000000']));
  check('cleanup: test users, categories and contents removed', left.length === 0 && leftC.length === 0);
  await sqlClient.end();
  const failed = results.filter((x) => !x[1]).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}
