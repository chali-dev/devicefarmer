/**
 * 追踪号 + 素材 without a 标签 UI (owner decision 2026-11-18, 「都去掉」): the web no longer sends `tags`, so the API must
 * keep the stored tags when a body omits them. Real API + DB, no mocks, no devices.
 * - Tracked: created with tags (an older page) → stored; PATCH with exactly the edit form's body (displayName, avatarUrl,
 *   bio, notes) and the star toggle (favorite) keep them; a POST from the add form (no tags) stores none; `?tag=` and
 *   /facets still answer (API unchanged for older pages); an older page's PATCH with tags still replaces them.
 * - Media: an upload with a `tags` field (older page) stores them; PUT with exactly the 编辑素材 body (name, categoryId)
 *   keeps them; an upload with the editor's fields only (name, no tags) works (ready, no tags); an older page's PUT with
 *   tags still replaces them.
 * Usage (from apps/api, API running with ENABLED_PLATFORMS=all):
 *   E2E_API=http://127.0.0.1:3145 ENABLED_PLATFORMS=all npx tsx --env-file=../../.env scripts/tags-ui-check.ts
 */
import { randomBytes } from 'node:crypto';
import sharp from 'sharp';
import { sqlClient } from '../src/db/index.js';
import { withCaptcha } from './lib/login.js';

const API = process.env.E2E_API ?? 'http://127.0.0.1:3000';
const results: [string, boolean][] = [];
const check = (name: string, ok: boolean, detail = '') => { results.push([name, ok]); console.log(`${ok ? '✓' : '✗'} ${name}${detail && !ok ? ` — ${detail}` : ''}`); };

async function http<T = any>(method: string, p: string, token: string, body?: unknown) {
  const form = body instanceof FormData;
  const res = await fetch(API + p, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body !== undefined && !form ? { 'content-type': 'application/json' } : {}) },
    body: form ? body : body !== undefined ? JSON.stringify(body) : undefined,
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
async function upload(token: string, name: string, data: Buffer, fields: Record<string, string>) {
  const fd = new FormData();
  fd.append('scope', 'mine');
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  fd.append('file', new Blob([new Uint8Array(data)], { type: 'image/png' }), name);
  return http('POST', '/api/media/upload', token, fd);
}
async function waitReady(token: string, id: string) {
  const until = Date.now() + 60_000;
  for (;;) {
    const r = await http('GET', `/api/media/${id}`, token);
    if (r.status !== 200 || r.body.item.status !== 'processing' || Date.now() > until) return r.body?.item;
    await new Promise((res) => setTimeout(res, 300));
  }
}

const T = await login(process.env.ADMIN_USERNAME!, process.env.ADMIN_PASSWORD!);
const tag = randomBytes(3).toString('hex');
const pw = randomBytes(12).toString('hex');
let userId: string | null = null;
const sorted = (a: string[]) => [...a].sort();
const same = (a: string[] | undefined, b: string[]) => JSON.stringify(sorted(a ?? [])) === JSON.stringify(sorted(b));

try {
  const u = await http('POST', '/api/users', T, { username: `tagsui-${tag}`, password: pw, role: 'user' });
  userId = u.body.user?.id ?? u.body.id;
  const U = await login(`tagsui-${tag}`, pw);
  const t1 = `t1-${tag}`, t2 = `t2-${tag}`;

  // ---------------------------------------------------------------- tracked accounts
  const c1 = await http('POST', '/api/tracked-accounts', U, { input: `https://www.tiktok.com/@tagsui${tag}`, tags: [t1, t2] });
  check('tracked: create with tags (older page) → 201', c1.status === 201, c1.text);
  const a1 = c1.body.account?.id as string;
  check('tracked: tags stored', same(c1.body.account?.tags, [t1, t2]), JSON.stringify(c1.body.account?.tags));

  const e1 = await http('PATCH', `/api/tracked-accounts/${a1}`, U, { displayName: 'Tags UI', avatarUrl: null, bio: 'bio', notes: 'note' });
  check('tracked: PATCH with the edit form body (no tags) → 200', e1.status === 200, e1.text);
  check('tracked: … tags kept', same(e1.body.account?.tags, [t1, t2]), JSON.stringify(e1.body.account?.tags));
  check('tracked: … fields saved', e1.body.account?.displayName === 'Tags UI' && e1.body.account?.notes === 'note');
  const f1 = await http('PATCH', `/api/tracked-accounts/${a1}`, U, { favorite: true });
  check('tracked: favorite toggle keeps tags', f1.status === 200 && same(f1.body.account?.tags, [t1, t2]), f1.text);
  const g1 = await http('GET', `/api/tracked-accounts/${a1}`, U);
  check('tracked: GET shows the kept tags', same(g1.body.account?.tags, [t1, t2]), g1.text);

  const c2 = await http('POST', '/api/tracked-accounts', U, { input: `https://www.tiktok.com/@tagsui${tag}b`, displayName: 'B', favorite: false });
  check('tracked: create from the add form (no tags) → 201, no tags', c2.status === 201 && same(c2.body.account?.tags, []), c2.text);

  const l = await http('GET', `/api/tracked-accounts?tag=${t1}`, U);
  check('tracked: ?tag= filter still works (API unchanged)', l.status === 200 && l.body.items.length === 1 && l.body.items[0].id === a1, l.text);
  const fc = await http('GET', '/api/tracked-accounts/facets', U);
  check('tracked: /facets still lists the tags', fc.status === 200 && same(fc.body.tags, [t1, t2]), fc.text);
  const o1 = await http('PATCH', `/api/tracked-accounts/${a1}`, U, { tags: [t2] });
  check('tracked: an older page\'s PATCH with tags still replaces them', o1.status === 200 && same(o1.body.account?.tags, [t2]), o1.text);

  // ---------------------------------------------------------------- media
  const png = await sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 10, g: 140, b: 90 } } }).png().toBuffer();
  const m1 = await upload(U, `tagsui-${tag}-a.png`, png, { name: `tagsui ${tag} a`, tags: JSON.stringify([t1, t2]) });
  check('media: upload with tags (older page) → 201', m1.status === 201, m1.text);
  const id1 = m1.body.item?.id as string;
  const r1 = await waitReady(U, id1);
  check('media: ready with the tags', r1?.status === 'ready' && same(r1?.tags, [t1, t2]), JSON.stringify(r1));

  const p1 = await http('PUT', `/api/media/${id1}`, U, { name: `tagsui ${tag} renamed`, categoryId: null });
  check('media: PUT with the 编辑素材 body (no tags) → 200', p1.status === 200, p1.text);
  check('media: … tags kept', same(p1.body.item?.tags, [t1, t2]), JSON.stringify(p1.body.item?.tags));
  check('media: … name saved', p1.body.item?.name === `tagsui ${tag} renamed`);
  const g2 = await http('GET', `/api/media/${id1}`, U);
  check('media: GET shows the kept tags', same(g2.body.item?.tags, [t1, t2]), g2.text);

  const m2 = await upload(U, `tagsui-${tag}-b.png`, png, { name: `tagsui ${tag} b` });
  check('media: upload with the editor fields (no tags) → 201', m2.status === 201, m2.text);
  const r2 = await waitReady(U, m2.body.item?.id);
  check('media: … ready, name kept, no tags', r2?.status === 'ready' && r2?.name === `tagsui ${tag} b` && same(r2?.tags, []), JSON.stringify(r2));

  const o2 = await http('PUT', `/api/media/${id1}`, U, { tags: [t2] });
  check('media: an older page\'s PUT with tags still replaces them', o2.status === 200 && same(o2.body.item?.tags, [t2]), o2.text);

  for (const id of [id1, m2.body.item?.id]) if (id) await http('DELETE', `/api/media/${id}`, U);
  for (const id of [a1, c2.body.account?.id]) if (id) await http('DELETE', `/api/tracked-accounts/${id}`, U);
} finally {
  // deleting the user cascades the tracked accounts and purges the private media
  if (userId) await http('DELETE', `/api/users/${userId}`, T);
  await sqlClient.end();
}

const failed = results.filter(([, ok]) => !ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
