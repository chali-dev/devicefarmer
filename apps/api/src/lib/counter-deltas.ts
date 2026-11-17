import { sql, type SQL } from 'drizzle-orm';

/**
 * Gains of a counter (followers, lifetime views, …) from readings over time, shared by tracked
 * accounts (追踪账号, snapshots) and account analytics (账号分析, daily stats).
 *
 * Returns a subquery with one row per non-null reading: `id` (the key), `at`, `value` and `delta` =
 * value minus the previous non-null reading of the same key (null for the first one). Summing
 * `delta` over the readings in (since, until] therefore gives "latest minus the baseline", where
 * the baseline is the last reading at or before `since`, or the first reading inside the window when
 * there is none before it; a key with a single reading has no gain (null).
 *
 * `table`, `key`, `at`, `value` and `tie` are trusted identifiers from the caller (never user input);
 * `where` filters the readings (scope + `at <= until`).
 */
export function counterDeltas(o: { table: string; key: string; at: string; value: string; tie?: string; where: SQL }): SQL {
  const t = sql.raw(o.table); const k = sql.raw(o.key); const a = sql.raw(o.at); const v = sql.raw(o.value);
  const order = sql.raw(o.tie ? `${o.at}, ${o.tie}` : o.at);
  return sql`(select ${k} as id, ${a} as at, ${v}::float8 as value,
    (${v} - lag(${v}) over (partition by ${k} order by ${order}))::float8 as delta
    from ${t} where ${v} is not null and (${o.where}))`;
}
