/**
 * Data migration check for src/db/tracked-category-data-migration.ts (tracked accounts' category → tags), against the
 * real DB of the running environment (no API needed). Inserts tracked accounts with legacy categories directly (the
 * column is kept for rollbacks) for a temporary user:
 * - " Competitor " without tags → tag "competitor" (trimmed, lowercase);
 * - "COMPETITOR" with tags [travel] → appended: [travel, competitor] (case variant of the first row's category);
 * - "Travel" with the tag "travel" already → tags unchanged (deduplicated);
 * - a 60-char category → cut to 32 chars; one whose cut ends in a space → re-trimmed (31 chars);
 *   one whose 32nd UTF-16 unit is the first half of an emoji → that half is dropped (31 chars);
 * - "   " and "" → no tag, category cleared;
 * - 20 tags already + a category → 21 tags (the API's per-request limit of 20 is not applied; nothing is lost);
 * - a row without category → untouched (updated_at unchanged).
 * Runs the migration twice: the second run finds none of these rows and changes nothing. Cleans up everything it created.
 * Usage (from apps/api): npx tsx --env-file=../../.env scripts/tracked-category-migration-check.ts
 */
import { randomBytes } from 'node:crypto';
import { sqlClient as sql } from '../src/db/index.js';
import { categoryTag, migrateTrackedCategories } from '../src/db/tracked-category-data-migration.js';

let failed = 0;
let passed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? '✓' : '✗'} ${name}${ok || detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`);
  if (ok) passed++; else failed++;
};
const tag = randomBytes(3).toString('hex');
const long = `Long Category ${tag} ${'y'.repeat(60)}`.slice(0, 60);
const spaceCut = `${'s'.repeat(31)} tail`; // the 32nd char is a space
const emojiCut = `${'e'.repeat(31)}😀 x`; // the 32nd UTF-16 unit is a high surrogate
const twenty = Array.from({ length: 20 }, (_, i) => `t${i}`);

const uid = (await sql<{ id: string }[]>`insert into users (username, password_hash, role) values (${`tcm${tag}`}, 'x', 'user') returning id`)[0]!.id;
let n = 0;
const account = async (category: string | null, tags: string[] = []) => (await sql<{ id: string }[]>`
  insert into tracked_accounts (user_id, platform, handle, profile_url, category, tags, updated_at)
  values (${uid}, 'instagram', ${`tcm_${tag}_${++n}`}, ${`https://www.instagram.com/tcm_${tag}_${n}/`}, ${category}, ${tags}::text[], now() - interval '1 day')
  returning id`)[0]!.id;
const state = async (id: string) => (await sql<{ category: string | null; tags: string[]; updatedAt: string }[]>`
  select category, tags, (extract(epoch from updated_at) * 1000000)::bigint::text as "updatedAt" from tracked_accounts where id = ${id}`)[0]!;

try {
  const rows = {
    trim: await account(' Competitor '),
    upper: await account('COMPETITOR', ['travel']),
    dup: await account('Travel', ['travel']),
    long: await account(long),
    space: await account(spaceCut),
    emoji: await account(emojiCut),
    blank: await account('   '),
    empty: await account(''),
    full: await account('Extra', twenty),
    none: await account(null, ['keep']),
  };
  const ids = Object.values(rows);
  const before = await state(rows.none);

  const run1 = await migrateTrackedCategories(sql, () => {});
  check('run 1 found every test row with a category (9)', run1.accounts >= 9 && run1.tagged >= 6 && run1.cleared >= 3, run1);
  const s = Object.fromEntries(await Promise.all(Object.entries(rows).map(async ([k, id]) => [k, await state(id)] as const)));
  check('every category cleared', Object.values(s).every((x) => x.category === null));
  check('" Competitor " → tag "competitor" (trim + lowercase)', JSON.stringify(s.trim!.tags) === '["competitor"]', s.trim!.tags);
  check('"COMPETITOR" (case variant) appended after existing tags', JSON.stringify(s.upper!.tags) === '["travel","competitor"]', s.upper!.tags);
  check('"Travel" with tag "travel" already → tags unchanged', JSON.stringify(s.dup!.tags) === '["travel"]', s.dup!.tags);
  check('60-char category → tag cut to 32 chars', s.long!.tags.length === 1 && s.long!.tags[0] === long.toLowerCase().slice(0, 32) && s.long!.tags[0]!.length === 32, s.long!.tags);
  check('cut ending in a space → re-trimmed (31 chars)', JSON.stringify(s.space!.tags) === JSON.stringify(['s'.repeat(31)]), s.space!.tags);
  check('cut through an emoji → half surrogate dropped (31 chars)', JSON.stringify(s.emoji!.tags) === JSON.stringify(['e'.repeat(31)]), s.emoji!.tags);
  check('blank / empty category → no tag, category cleared', s.blank!.tags.length === 0 && s.empty!.tags.length === 0);
  check('20 tags + category → 21 tags (nothing lost)', s.full!.tags.length === 21 && s.full!.tags.at(-1) === 'extra', s.full!.tags.length);
  check('row without category untouched (tags, updated_at)', JSON.stringify(s.none!.tags) === '["keep"]' && s.none!.updatedAt === before.updatedAt);
  check('migrated rows got updated_at bumped', BigInt(s.trim!.updatedAt) > BigInt(before.updatedAt));
  check('categoryTag matches the API tag rules (normTags + 32 max)', categoryTag(' A B ') === 'a b' && categoryTag(' ') === null && categoryTag('x'.repeat(40))!.length === 32);
  check('index tracked_accounts_user_category_idx and the column are kept (expand/contract)',
    (await sql`select 1 from pg_indexes where indexname = 'tracked_accounts_user_category_idx'`).length === 1
    && (await sql`select 1 from information_schema.columns where table_name = 'tracked_accounts' and column_name = 'category'`).length === 1);

  const snap = JSON.stringify(await Promise.all(ids.map(state)));
  const run2 = await migrateTrackedCategories(sql, () => {});
  const left = (await sql<{ n: number }[]>`select count(*)::int as n from tracked_accounts where id in ${sql(ids)} and category is not null`)[0]!.n;
  check('run 2: no test row left to migrate, nothing changed (tags, updated_at)', left === 0 && JSON.stringify(await Promise.all(ids.map(state))) === snap, run2);
  check('run 2 is a no-op overall (0 rows with a category in this DB)', run2.accounts === 0, run2);
} catch (e) {
  check(`unexpected error: ${(e as Error).stack}`, false);
} finally {
  await sql`delete from users where id = ${uid}`; // cascades the tracked accounts
  console.log(`\n${passed}/${passed + failed} checks passed`);
  await sql.end();
  if (failed) process.exitCode = 1;
}
