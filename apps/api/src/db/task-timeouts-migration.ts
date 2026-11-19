import type { Sql } from 'postgres';

/**
 * 系统配置 → 任务超时 (2026-11-19; idempotent): the former 发布任务 setting `publish.timeout` {timeoutSec} becomes the
 * `publish` row of `tasks.timeouts` (ms, whole minutes 1–60; an existing `publish` value wins), then `publish.timeout`
 * and the legacy `publish.retry` row are deleted.
 */
export async function migrateTaskTimeouts(sql: Sql): Promise<boolean> {
  const [old] = await sql<{ value: { timeoutSec?: unknown } | null }[]>`select value from settings where key = 'publish.timeout'`;
  const sec = old?.value?.timeoutSec;
  if (typeof sec === 'number' && Number.isFinite(sec)) {
    const ms = Math.min(60, Math.max(1, Math.round(sec / 60))) * 60_000;
    const v = JSON.stringify({ publish: ms });
    await sql`insert into settings (key, value) values ('tasks.timeouts', ${v}::jsonb)
      on conflict (key) do update set value = ${v}::jsonb || settings.value, updated_at = now()`;
  }
  const del = await sql`delete from settings where key in ('publish.timeout', 'publish.retry')`;
  return del.count > 0;
}
