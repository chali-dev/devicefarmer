import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { and, desc, eq, inArray, lt, notInArray, sql } from 'drizzle-orm';
import { config } from '../../config.js';
import { db, schema } from '../../db/index.js';
import type { DbBackup } from '../../db/schema.js';
import { conflict, notFound } from '../../lib/errors.js';
import { activeStorage, storageFor } from '../settings/storage.js';
import { createTask, registerTaskHandler, TaskError, type TaskContext } from '../tasks/core.js';
import { redactText } from './logs.js';
import { getSystemSettings } from './settings.js';

/**
 * Database backups (数据库备份, admin). The device-less task `db-backup` runs
 * `${PG_DUMP_CMD} --format=custom --compress=6` against DATABASE_URL into a temp file, checks the
 * custom-format magic (PGDMP), stores it through the active storage backend under `backups/` and keeps
 * the newest N successful backups. The password reaches the child only through PGPASSWORD (never argv,
 * task payload, logs or audit). 导入 (restore from one of them) is restore.ts.
 */

export const BACKUP_TYPE = 'db-backup';
export const MAGIC = Buffer.from('PGDMP');

/** Connection of DATABASE_URL as pg_* arguments; the password only in the env (PGPASSWORD). */
export function pgConnection() {
  const u = new URL(config.DATABASE_URL);
  const dbName = decodeURIComponent(u.pathname.slice(1));
  const password = decodeURIComponent(u.password);
  const env: NodeJS.ProcessEnv = { ...process.env, PGPASSWORD: password };
  const sslmode = u.searchParams.get('sslmode');
  if (sslmode) env.PGSSLMODE = sslmode;
  const args = ['--no-password', '--host', u.hostname, '--port', u.port || '5432', '--username', decodeURIComponent(u.username), '--dbname', dbName];
  return { args, env, dbName, password };
}

function dumpCommand() {
  const [cmd, ...pre] = config.PG_DUMP_CMD.trim().split(/\s+/);
  const c = pgConnection();
  return { cmd: cmd!, args: [...pre, '--format=custom', '--compress=6', ...c.args], env: c.env, dbName: c.dbName, password: c.password };
}

/** Error text from the child, with the password (should it ever appear) and secret-looking parts removed. */
export function scrub(s: string, password: string): string {
  return redactText(password ? s.split(password).join('***') : s).trim().slice(0, 1000);
}

async function runDump(file: string, signal: AbortSignal): Promise<void> {
  const { cmd, args, env, password } = dumpCommand();
  const out = fs.createWriteStream(file);
  const child = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const onAbort = () => child.kill('SIGTERM');
  signal.addEventListener('abort', onAbort);
  let stderr = '';
  child.stderr.on('data', (d: Buffer) => { if (stderr.length < 4000) stderr += d.toString('utf8'); });
  child.stdout.pipe(out);
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.on('error', reject);
      child.on('close', resolve);
    }).catch((err: NodeJS.ErrnoException) => {
      // ENOENT: the command in PG_DUMP_CMD is not installed / not on PATH (e.g. no pg_dump on the API host).
      throw new TaskError(err.code === 'ENOENT' ? 'system.backup_cmd_missing' : 'system.backup_cmd_failed', `cannot run ${cmd}: ${scrub(err.message, password)}`);
    });
    await new Promise<void>((resolve) => (out.writableFinished ? resolve() : out.on('finish', resolve)));
    if (signal.aborted) throw signal.reason;
    if (code !== 0) throw new TaskError('system.backup_cmd_failed', `pg_dump exited with ${code}: ${scrub(stderr, password) || 'no output'}`);
  } finally {
    signal.removeEventListener('abort', onAbort);
    out.destroy();
  }
  const fd = await fs.promises.open(file, 'r');
  try {
    const head = Buffer.alloc(MAGIC.length);
    await fd.read(head, 0, MAGIC.length, 0);
    if (!head.equals(MAGIC)) throw new TaskError('system.backup_invalid', 'pg_dump output is not a custom-format archive');
  } finally { await fd.close(); }
}

/** Keeps the newest `keep` successful backups; failed rows older than the oldest kept one go too. */
export async function applyBackupKeep(keep: number): Promise<number> {
  const B = schema.dbBackups;
  const ok = await db.select().from(B).where(eq(B.status, 'ok')).orderBy(desc(B.createdAt));
  const old = ok.slice(keep);
  for (const b of old) {
    await (await storageFor(b.storage)).delete(b.key);
    await db.delete(B).where(eq(B.id, b.id));
  }
  const oldestKept = ok[Math.min(keep, ok.length) - 1];
  if (oldestKept) await db.delete(B).where(and(eq(B.status, 'failed'), lt(B.createdAt, oldestKept.createdAt)));
  return old.length;
}

export type BackupTrigger = 'manual' | 'scheduled' | 'pre-restore';

/**
 * One backup into the active storage: a `db_backups` row (running → ok | failed) owned by the task that runs it.
 * `keep` false skips the retention: the safety backup before a restore must never delete the backup being restored.
 */
export async function takeBackup(ctx: TaskContext<unknown>, trigger: BackupTrigger, keep = true) {
  const storage = await activeStorage();
  const { dbName } = dumpCommand();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const key = `backups/${dbName.replace(/[^\w-]/g, '_')}-${stamp}.dump`;
  const [row] = await db.insert(schema.dbBackups).values({
    trigger, storage: storage.kind, key, taskId: ctx.task.id, createdBy: ctx.task.createdBy,
  }).returning();
  const tmp = path.join(os.tmpdir(), `cloudphone-backup-${randomUUID()}.dump`);
  try {
    await ctx.log('info', `pg_dump of ${dbName} started`, { backupId: row!.id });
    await runDump(tmp, ctx.signal);
    const { size } = await fs.promises.stat(tmp);
    await storage.put(key, tmp, size, 'application/octet-stream');
    await db.update(schema.dbBackups).set({ status: 'ok', size, finishedAt: new Date() }).where(eq(schema.dbBackups.id, row!.id));
    await ctx.log('info', `backup stored (${size} bytes)`, { backupId: row!.id, storage: storage.kind, key });
    const removed = keep ? await applyBackupKeep((await getSystemSettings()).backup.keep) : 0;
    if (removed) await ctx.log('info', `deleted ${removed} old backups`, { removed });
    return { backupId: row!.id, storage: storage.kind, key, size, removed };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await db.update(schema.dbBackups).set({ status: 'failed', error: msg.slice(0, 1000), finishedAt: new Date() }).where(eq(schema.dbBackups.id, row!.id));
    throw err;
  } finally {
    await fs.promises.unlink(tmp).catch(() => undefined);
  }
}

registerTaskHandler<{ trigger?: 'manual' | 'scheduled' }>(BACKUP_TYPE, {
  queue: 'system-ops',
  concurrency: 1,
  timeoutMs: 60 * 60_000,
  maxAttempts: 1,
  run: (ctx) => takeBackup(ctx, ctx.payload.trigger === 'scheduled' ? 'scheduled' : 'manual'),
});

export async function startBackup(userId: string) {
  return createTask({ type: BACKUP_TYPE, userId, payload: { trigger: 'manual' } });
}

const localDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/**
 * Daily schedule: from the configured local hour on, one `db-backup` task per local day (idempotency
 * key `daily:<date>`), so hourly calls, restarts and several API processes create it once.
 */
export async function scheduleBackup(now = new Date()) {
  const { backup } = await getSystemSettings();
  if (!backup.enabled || now.getHours() < backup.hour) return null;
  const { task, created } = await createTask({ type: BACKUP_TYPE, payload: { trigger: 'scheduled' }, idempotencyKey: `daily:${localDay(now)}` });
  return { taskId: task.id, created };
}

/** Rows left `running` by a crash (their task no longer runs) become failed. */
export async function failStaleBackups(): Promise<number> {
  const B = schema.dbBackups;
  const running = db.select({ id: schema.tasks.id }).from(schema.tasks).where(inArray(schema.tasks.status, ['pending', 'running']));
  const rows = await db.update(B).set({ status: 'failed', error: 'interrupted', finishedAt: new Date() })
    .where(and(eq(B.status, 'running'), sql`(${B.taskId} is null or ${notInArray(B.taskId, running)})`)).returning({ id: B.id });
  return rows.length;
}

/** Rows plus the failing task's `error_code` (so the UI can translate the reason; `error` stays the raw text). */
export async function listBackups(): Promise<(DbBackup & { errorCode: string | null })[]> {
  const B = schema.dbBackups;
  const rows = await db.select({ b: B, errorCode: schema.tasks.errorCode }).from(B)
    .leftJoin(schema.tasks, eq(schema.tasks.id, B.taskId)).orderBy(desc(B.createdAt)).limit(500);
  const code = (b: DbBackup, taskCode: string | null) => {
    if (b.status !== 'failed') return null;
    if (b.error === 'interrupted') return 'task.interrupted';
    // Rows from before backup_cmd_missing existed carry the spawn error only in the text.
    if (taskCode === 'system.backup_cmd_failed' && b.error?.startsWith('cannot run ') && b.error.includes('ENOENT')) return 'system.backup_cmd_missing';
    return taskCode;
  };
  return rows.map((r) => ({ ...r.b, errorCode: code(r.b, r.errorCode) }));
}

export async function getBackup(id: string): Promise<DbBackup> {
  const [b] = await db.select().from(schema.dbBackups).where(eq(schema.dbBackups.id, id));
  if (!b) throw notFound('backup not found', 'system.backup_not_found');
  return b;
}

export async function openBackup(id: string) {
  const b = await getBackup(id);
  if (b.status !== 'ok') throw conflict('backup is not complete', 'system.backup_not_ready');
  return { backup: b, stream: await (await storageFor(b.storage)).getStream(b.key) };
}

export async function deleteBackup(id: string): Promise<DbBackup> {
  const b = await getBackup(id);
  if (b.status === 'running') throw conflict('backup is still running', 'system.backup_running');
  await (await storageFor(b.storage)).delete(b.key);
  await db.delete(schema.dbBackups).where(eq(schema.dbBackups.id, id));
  return b;
}
