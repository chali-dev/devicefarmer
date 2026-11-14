import type { Sql } from 'postgres';
import { sealSecret } from '../lib/secret-box.js';

/**
 * One-off data migration: inline per-device proxies (`instances.proxy` jsonb, plaintext password)
 * → proxy pool rows (`proxies`, password encrypted) + `instances.proxy_id`.
 *
 * It has to straddle the schema migrations: the encryption key lives in the app config (not SQL),
 * the `proxies` table only exists after migration 0008, and `instances.proxy` is dropped by 0009.
 * So it runs in two phases around the drizzle migrator (src/db/migrate.ts):
 *  1. `stashInlineProxies` (before): while `instances.proxy` still exists, copy each inline proxy into a
 *     staging table with the password already encrypted. Plaintext never leaves the old column.
 *  2. `finishInlineProxies` (after): create/reuse a pool row per endpoint, bind it to the device and
 *     drop the staging table.
 * Both phases are idempotent and keyed on what exists in the database, not on migration names,
 * so a crash between them (or regenerated migrations) is safe: re-running `db:migrate` completes it.
 */
const STAGING = '_proxy_pool_migration';

async function columnExists(sql: Sql, table: string, column: string): Promise<boolean> {
  const r = await sql`select 1 from information_schema.columns where table_schema = 'public' and table_name = ${table} and column_name = ${column}`;
  return r.length > 0;
}
async function tableExists(sql: Sql, table: string): Promise<boolean> {
  const r = await sql`select to_regclass(${`public.${table}`}) as t`;
  return r[0]?.t != null;
}

interface Inline { type?: string; host?: string; port?: number; username?: string; password?: string }

export async function stashInlineProxies(sql: Sql): Promise<number> {
  if (!(await tableExists(sql, 'instances')) || !(await columnExists(sql, 'instances', 'proxy'))) return 0;
  const rows = await sql<{ id: string; proxy: Inline }[]>`select id, proxy from instances where proxy is not null`;
  if (!rows.length) return 0;
  await sql.unsafe(`create table if not exists ${STAGING} (
    instance_id uuid primary key, type text not null, host text not null, port integer not null,
    username text, password_enc text)`);
  let n = 0;
  for (const { id, proxy: p } of rows) {
    if ((p.type !== 'socks5' && p.type !== 'http') || !p.host || !p.port) continue;
    const enc = p.password ? sealSecret(p.password) : null;
    const r = await sql`insert into ${sql(STAGING)} (instance_id, type, host, port, username, password_enc)
      values (${id}, ${p.type}, ${p.host}, ${p.port}, ${p.username || null}, ${enc}) on conflict (instance_id) do nothing`;
    n += r.count;
  }
  return n;
}

export async function finishInlineProxies(sql: Sql, log: (msg: string) => void = console.log): Promise<{ bound: number; skipped: string[] }> {
  const skipped: string[] = [];
  if (!(await tableExists(sql, STAGING))) return { bound: 0, skipped };
  let bound = 0;
  await sql.begin(async (tx) => {
    const staged = await tx<{ instance_id: string; type: string; host: string; port: number; username: string | null; password_enc: string | null }[]>`
      select * from ${tx(STAGING)} order by instance_id`;
    for (const s of staged) {
      const [inst] = await tx<{ name: string; proxy_id: string | null }[]>`select name, proxy_id from instances where id = ${s.instance_id}`;
      if (!inst || inst.proxy_id) continue; // device gone, or already migrated
      // Same endpoint (type, host case-insensitive, port, user) → same pool row (unique index).
      await tx`insert into proxies (type, host, port, username, password_enc, label, notes)
        values (${s.type}, ${s.host}, ${s.port}, ${s.username}, ${s.password_enc}, ${`${inst.name} (migrated)`}, ${'migrated from per-device proxy'})
        on conflict do nothing`;
      const [p] = await tx<{ id: string }[]>`select id from proxies where type = ${s.type} and lower(host) = lower(${s.host})
        and port = ${s.port} and coalesce(username, '') = ${s.username ?? ''}`;
      const [holder] = await tx<{ name: string }[]>`select name from instances where proxy_id = ${p!.id}`;
      if (holder) {
        // Was shared with allowShared: a pool proxy binds to one device only.
        skipped.push(`${inst.name} (shares ${s.type}://${s.host}:${s.port} with ${holder.name})`);
        continue;
      }
      await tx`update instances set proxy_id = ${p!.id} where id = ${s.instance_id}`;
      bound++;
    }
    await tx.unsafe(`drop table ${STAGING}`);
  });
  if (bound) log(`proxy pool: migrated ${bound} per-device proxies into the pool (passwords encrypted)`);
  for (const s of skipped) log(`proxy pool: WARNING device ${s}: not bound, assign a pool proxy to it in 代理管理/device detail`);
  return { bound, skipped };
}
