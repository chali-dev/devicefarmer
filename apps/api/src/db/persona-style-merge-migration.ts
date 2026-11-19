import type { Sql } from 'postgres';

/**
 * Data migration (owner 2026-11-19, 「发文风格和评论风格；建议整成一个吧」 + 固定开头/结尾 removed): every persona style
 * (`personas.brief`) in the split shape of 2026-11-18 becomes the single flat shape = its `post` part on top of the
 * shared fields (topics, banned words); the `comment` part is dropped; the removed `opening` / `closing` are dropped too.
 * Idempotent: rows without `post` / `comment` / `opening` / `closing` are untouched, so a second run changes nothing.
 * Runs from src/db/run-migrations.ts. `onlyIds` (tests only) restricts it to some rows.
 */
export async function migratePersonaStyles(sql: Sql, opts: { onlyIds?: string[] } = {}): Promise<number> {
  const rows = await sql`
    update personas
    set brief = ((brief - 'post' - 'comment')
      || coalesce(case when jsonb_typeof(brief->'post') = 'object' then brief->'post' end, '{}'::jsonb)) - 'opening' - 'closing'
    where brief ?| array['post', 'comment', 'opening', 'closing']
    ${opts.onlyIds ? sql`and id = any(${opts.onlyIds}::uuid[])` : sql``}
    returning id`;
  return rows.length;
}
