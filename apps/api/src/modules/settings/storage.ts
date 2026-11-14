import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { config } from '../../config.js';
import { db, schema } from '../../db/index.js';
import { LocalStorage, S3Storage, type ObjectStorage, type S3Options, type StorageKind } from '../../adapters/storage/index.js';
import { openSecret, sealSecret } from '../../lib/secret-box.js';
import { badRequest } from '../../lib/errors.js';

/**
 * Storage backend for the asset library, stored under settings key "storage".
 * The S3 secret is encrypted at rest and write-only (never returned by the API).
 *
 * Every asset row records the backend it was written to. Local assets stay readable after
 * switching to s3; s3 assets are always read with the CURRENT s3 config, so pointing it at
 * another bucket/endpoint orphans existing s3 assets (their content returns 502).
 */
const KEY = 'storage';

interface StoredS3 { endpoint?: string; region: string; bucket: string; accessKeyId: string; secretEnc: string; forcePathStyle: boolean; prefix?: string }
interface StoredStorage { type: StorageKind; s3?: StoredS3 }

export const S3Input = z.object({
  endpoint: z.string().trim().max(300).url().or(z.literal('')).optional(),
  region: z.string().trim().min(1).max(64).default('us-east-1'),
  bucket: z.string().trim().min(3).max(63).regex(/^[a-z0-9][a-z0-9.-]+[a-z0-9]$/, 'invalid bucket name'),
  accessKeyId: z.string().trim().min(1).max(256),
  /** Omit/empty to keep the stored secret (only when endpoint, bucket and access key are unchanged). */
  secretAccessKey: z.string().max(512).optional(),
  forcePathStyle: z.boolean().default(false),
  prefix: z.string().trim().max(200).regex(/^[a-zA-Z0-9._\/-]*$/, 'prefix may contain letters, digits, . _ - /').optional(),
});
export const StorageInput = z.object({ type: z.enum(['local', 's3']), s3: S3Input.optional() });
export type StorageInputT = z.infer<typeof StorageInput>;

export interface PublicStorageSettings {
  type: StorageKind;
  s3: (Omit<StoredS3, 'secretEnc'> & { hasSecret: boolean }) | null;
}

async function load(): Promise<StoredStorage> {
  const [row] = await db.select().from(schema.settings).where(eq(schema.settings.key, KEY));
  return (row?.value as StoredStorage | undefined) ?? { type: 'local' };
}

export async function getStorageSettings(): Promise<PublicStorageSettings> {
  const s = await load();
  if (!s.s3) return { type: s.type, s3: null };
  const { secretEnc, ...rest } = s.s3;
  return { type: s.type, s3: { ...rest, hasSecret: Boolean(secretEnc) } };
}

/** Resolves submitted S3 fields into a full config, falling back to the stored secret when allowed. */
async function resolveS3(input: z.infer<typeof S3Input>, stored: StoredStorage): Promise<S3Options> {
  let secret = input.secretAccessKey || '';
  if (!secret) {
    const prev = stored.s3;
    const same = prev && (prev.endpoint ?? '') === (input.endpoint ?? '') && prev.bucket === input.bucket && prev.accessKeyId === input.accessKeyId;
    if (!same || !prev.secretEnc) throw badRequest('Secret Access Key is required (endpoint, bucket or access key changed)');
    secret = openSecret(prev.secretEnc);
  }
  return {
    endpoint: input.endpoint || undefined, region: input.region, bucket: input.bucket, accessKeyId: input.accessKeyId,
    secretAccessKey: secret, forcePathStyle: input.forcePathStyle, prefix: input.prefix || undefined,
  };
}

function s3FromStored(s: StoredS3): S3Options {
  return { endpoint: s.endpoint, region: s.region, bucket: s.bucket, accessKeyId: s.accessKeyId, secretAccessKey: openSecret(s.secretEnc), forcePathStyle: s.forcePathStyle, prefix: s.prefix };
}

const local = new LocalStorage(config.ASSET_DIR);
let s3Cache: S3Storage | null = null;
let s3CacheLoaded = false;

/** Backend by name (for reading/deleting existing assets). Throws if s3 is not configured. */
export async function storageFor(kind: StorageKind): Promise<ObjectStorage> {
  if (kind === 'local') return local;
  if (!s3CacheLoaded) {
    const s = await load();
    s3Cache = s.s3 ? new S3Storage(s3FromStored(s.s3)) : null;
    s3CacheLoaded = true;
  }
  if (!s3Cache) throw new Error('S3 storage is not configured');
  return s3Cache;
}

/** Backend new uploads go to. */
export async function activeStorage(): Promise<ObjectStorage> {
  return storageFor((await load()).type);
}

/** Tests the submitted config, or the stored active one when `input` is undefined. Does not save anything. */
export async function testStorage(input?: StorageInputT) {
  const stored = await load();
  if (!input) return (await storageFor(stored.type).catch((err: Error) => ({ test: async () => ({ ok: false, latencyMs: 0, error: err.message }) }))).test();
  if (input.type === 'local') return local.test();
  if (!input.s3) throw badRequest('s3 settings are required');
  const s3 = new S3Storage(await resolveS3(input.s3, stored));
  try { return await s3.test(); } finally { s3.close(); }
}

/**
 * Saves the storage settings. An s3 config is tested first and refused if the test fails.
 * Switching to local keeps the stored s3 config so existing s3 assets stay readable.
 */
export async function saveStorageSettings(input: StorageInputT) {
  const stored = await load();
  let next: StoredStorage;
  if (input.type === 'local') {
    next = { type: 'local', s3: stored.s3 };
  } else {
    if (!input.s3) throw badRequest('s3 settings are required');
    const opts = await resolveS3(input.s3, stored);
    const probe = new S3Storage(opts);
    let result;
    try { result = await probe.test(); } finally { probe.close(); }
    if (!result.ok) return { saved: false as const, test: result };
    next = {
      type: 's3',
      s3: {
        endpoint: opts.endpoint, region: opts.region, bucket: opts.bucket, accessKeyId: opts.accessKeyId,
        secretEnc: sealSecret(opts.secretAccessKey), forcePathStyle: opts.forcePathStyle, prefix: opts.prefix,
      },
    };
  }
  await db.insert(schema.settings).values({ key: KEY, value: next })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value: next, updatedAt: new Date() } });
  s3Cache?.close();
  s3Cache = null;
  s3CacheLoaded = false;
  return { saved: true as const, settings: await getStorageSettings() };
}
