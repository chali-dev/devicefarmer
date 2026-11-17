import type { Sql } from 'postgres';

/**
 * Data migration: free-text `contents.category` → managed content categories (`content_categories`, `contents.category_id`).
 * Contents are private, so every text becomes a **personal** category of the content's owner (admins can merge them
 * into public ones later). Texts are trimmed and grouped per owner case-insensitively (the most used spelling wins, then
 * the alphabetically first). An existing personal category of that owner with the same name is reused.
 *
 * Idempotent: only contents with a legacy text and no `category_id` are touched. The legacy column stays for rollbacks
 * (expand/contract); the code no longer reads it and clears it whenever it changes a content's category (also on
 * category delete/merge), so a content whose category was cleared is never re-linked. Runs from src/db/migrate.ts.
 */
export async function migrateContentCategoryTexts(sql: Sql, log: (msg: string) => void = console.log): Promise<{ created: number; linked: number }> {
  return sql.begin(async (tx) => {
    const rows = await tx<{ id: string; userId: string; text: string }[]>`
      select id, user_id as "userId", btrim(category) as text from contents
      where category_id is null and category is not null and btrim(category) <> '' for update`;
    if (!rows.length) return { created: 0, linked: 0 };

    // owner → lower(name) → spelling → uses
    const groups = new Map<string, Map<string, Map<string, number>>>();
    for (const r of rows) {
      const g = groups.get(r.userId) ?? new Map<string, Map<string, number>>();
      groups.set(r.userId, g);
      const k = r.text.toLowerCase();
      const v = g.get(k) ?? new Map<string, number>();
      g.set(k, v);
      v.set(r.text, (v.get(r.text) ?? 0) + 1);
    }

    let created = 0;
    const ids = new Map<string, string>(); // `${owner}\n${lower}` → category id
    for (const [owner, byKey] of groups) {
      for (const [key, spellings] of byKey) {
        const name = [...spellings].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))[0]![0].slice(0, 50);
        const ins = await tx<{ id: string }[]>`
          insert into content_categories (owner_type, owner_id, name) values ('user', ${owner}, ${name})
          on conflict do nothing returning id`;
        if (ins.length) created++;
        const [c] = ins.length ? ins : await tx<{ id: string }[]>`
          select id from content_categories where owner_id = ${owner} and lower(name) = lower(${name})`;
        ids.set(`${owner}\n${key}`, c!.id);
      }
    }
    for (const r of rows) await tx`update contents set category_id = ${ids.get(`${r.userId}\n${r.text.toLowerCase()}`)!} where id = ${r.id}`;
    log(`content categories: created ${created} from legacy category texts, linked ${rows.length} contents`);
    return { created, linked: rows.length };
  });
}
