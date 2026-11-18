import type { Sql } from 'postgres';
import { normTags, TAG_MAX } from '../modules/tracked/tags.js';

/** The category as a tag: same rules as the API (`normTags`: trimmed, lowercase), cut to TAG_MAX (32) UTF-16 units. */
export function categoryTag(category: string): string | null {
  let t = category.trim().toLowerCase().slice(0, TAG_MAX);
  if (/[\uD800-\uDBFF]$/.test(t)) t = t.slice(0, -1); // don't leave half a surrogate pair at the cut
  return normTags([t])[0] ?? null;
}

/**
 * Data migration: tracked accounts' free-text category (分类, `tracked_accounts.category`) → tags.
 * For every row with a non-null category: the category becomes a tag by `categoryTag` (trim, lowercase, longer
 * than 32 characters is cut to 32 and re-trimmed; blank → no tag) and is appended unless the row already carries it
 * (tags stay deduplicated; the API's limit of 20 tags per request body is not applied, so no category is lost).
 * Then the category is set to null, which is what makes a rerun a no-op (and a later rollback-then-upgrade migrates
 * categories the old code wrote in between). The column and its index stay (expand/contract; drop later).
 * Runs from src/db/migrate.ts after the schema.
 */
export async function migrateTrackedCategories(sql: Sql, log: (msg: string) => void = console.log): Promise<{ accounts: number; tagged: number; cleared: number }> {
  return sql.begin(async (tx) => {
    const rows = await tx<{ id: string; category: string; tags: string[] }[]>`
      select id, category, tags from tracked_accounts where category is not null order by id for update`;
    const out = { accounts: rows.length, tagged: 0, cleared: 0 };
    for (const r of rows) {
      const tag = categoryTag(r.category);
      if (tag && !r.tags.includes(tag)) {
        await tx`update tracked_accounts set tags = array_append(tags, ${tag}::text), category = null, updated_at = now() where id = ${r.id}`;
        out.tagged++;
      } else {
        await tx`update tracked_accounts set category = null, updated_at = now() where id = ${r.id}`;
        out.cleared++;
      }
    }
    if (rows.length) log(`tracked accounts: ${out.accounts} categories migrated to tags (${out.tagged} tagged, ${out.cleared} already tagged or blank)`);
    return out;
  });
}
