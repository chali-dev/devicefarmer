import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';

export type StorageKind = 'local' | 's3';

export interface StorageTestResult { ok: boolean; latencyMs: number; error: string | null }

/** Object storage for the asset library. Keys are relative ("assets/2026/11/<uuid>"), backends add their own root/prefix. */
export interface ObjectStorage {
  readonly kind: StorageKind;
  /** `source` is a local file path or a stream of exactly `size` bytes. */
  put(key: string, source: string | Readable, size: number, contentType: string): Promise<void>;
  /** Rejects if the object does not exist or cannot be read. */
  getStream(key: string): Promise<Readable>;
  /** Idempotent: deleting a missing object succeeds. */
  delete(key: string): Promise<void>;
  /** Real round trip: put a probe object, read it back, compare, delete it. */
  test(): Promise<StorageTestResult>;
}

export const KEY_RE = /^[a-zA-Z0-9][a-zA-Z0-9._\/-]{0,250}$/;
export function assertKey(key: string): void {
  if (!KEY_RE.test(key) || key.split('/').some((p) => p === '..' || p === '.' || p === '')) throw new Error(`invalid storage key: ${key}`);
}

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c as Uint8Array));
  return Buffer.concat(chunks);
}

/** Shared probe used by every backend's test(). */
export async function probeStorage(storage: ObjectStorage): Promise<StorageTestResult> {
  const started = Date.now();
  const key = `cloudphone-probe/${Date.now()}-${randomBytes(6).toString('hex')}`;
  const payload = randomBytes(64);
  let written = false;
  try {
    await storage.put(key, Readable.from([payload]), payload.length, 'application/octet-stream');
    written = true;
    const back = await readAll(await storage.getStream(key));
    if (!back.equals(payload)) throw new Error('probe object read back differs from what was written');
    await storage.delete(key);
    written = false;
    return { ok: true, latencyMs: Date.now() - started, error: null };
  } catch (err) {
    if (written) await storage.delete(key).catch(() => undefined);
    return { ok: false, latencyMs: Date.now() - started, error: describeError(err) };
  }
}

export function describeError(err: unknown): string {
  const e = err as { name?: string; message?: string; Code?: string; $metadata?: { httpStatusCode?: number } };
  const status = e.$metadata?.httpStatusCode;
  const parts = [e.Code ?? e.name, e.message].filter((x, i, a) => x && a.indexOf(x) === i && x !== 'Error' && x !== 'UnknownError');
  return `${parts.join(': ') || String(err)}${status ? ` (HTTP ${status})` : ''}`;
}
