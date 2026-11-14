import { eq } from 'drizzle-orm';
import { config } from '../../config.js';
import { db, schema } from '../../db/index.js';
import { openSecret, sealSecret } from '../../lib/secret-box.js';
import { platformError } from './http.js';
import type { PlatformApp, PlatformAppOptions } from './types.js';

/**
 * Platform app credentials (admin): client id + client secret (+ options) per platform, in the
 * `settings` row `platform.apps`. The secret is sealed with secret-box and write-only: the API only
 * says whether it is set. The client id is not a secret (it appears in every authorization URL).
 */
const KEY = 'platform.apps';
interface StoredApp { clientId?: string; clientSecretEnc?: string; options?: PlatformAppOptions; updatedAt?: string }
type Stored = Record<string, StoredApp>;

export interface PublicPlatformApp {
  platform: string;
  clientId: string | null;
  clientSecretSet: boolean;
  configured: boolean;
  /** Register this exact URI with the platform. */
  redirectUri: string;
  options: PlatformAppOptions;
  updatedAt: string | null;
}

export const redirectUri = (platform: string) =>
  `${(config.PUBLIC_BASE_URL ?? config.WEB_ORIGIN).replace(/\/+$/, '')}/api/platforms/${platform}/callback`;

async function load(): Promise<Stored> {
  const [row] = await db.select().from(schema.settings).where(eq(schema.settings.key, KEY));
  return (row?.value as Stored | undefined) ?? {};
}

const view = (platform: string, s: StoredApp | undefined): PublicPlatformApp => ({
  platform,
  clientId: s?.clientId ?? null,
  clientSecretSet: Boolean(s?.clientSecretEnc),
  configured: Boolean(s?.clientId && s?.clientSecretEnc),
  redirectUri: redirectUri(platform),
  options: s?.options ?? {},
  updatedAt: s?.updatedAt ?? null,
});

export async function getPlatformApps(platforms: readonly string[]): Promise<PublicPlatformApp[]> {
  const s = await load();
  return platforms.map((p) => view(p, s[p]));
}

export async function isConfigured(platform: string): Promise<boolean> {
  const s = (await load())[platform];
  return Boolean(s?.clientId && s?.clientSecretEnc);
}

export async function appOptions(platform: string): Promise<PlatformAppOptions> {
  return (await load())[platform]?.options ?? {};
}

/**
 * Saves one platform's credentials. `clientSecret`: string = set, null = clear, undefined = keep.
 * `clientId: null` clears the whole entry.
 */
export async function savePlatformApp(platform: string, input: { clientId?: string | null; clientSecret?: string | null; options?: PlatformAppOptions }): Promise<PublicPlatformApp> {
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(schema.settings).where(eq(schema.settings.key, KEY)).for('update');
    const all: Stored = { ...((row?.value as Stored | undefined) ?? {}) };
    if (input.clientId === null) {
      delete all[platform];
    } else {
      const cur: StoredApp = { ...(all[platform] ?? {}) };
      if (input.clientId !== undefined) cur.clientId = input.clientId;
      if (input.clientSecret === null) delete cur.clientSecretEnc;
      else if (input.clientSecret !== undefined) cur.clientSecretEnc = sealSecret(input.clientSecret);
      if (input.options !== undefined) cur.options = { ...(cur.options ?? {}), ...input.options };
      cur.updatedAt = new Date().toISOString();
      all[platform] = cur;
    }
    await tx.insert(schema.settings).values({ key: KEY, value: all })
      .onConflictDoUpdate({ target: schema.settings.key, set: { value: all, updatedAt: new Date() } });
    return view(platform, all[platform]);
  });
}

/** Decrypted credentials for server-side use, or platform.not_configured. */
export async function platformApp(platform: string, name: string): Promise<PlatformApp> {
  const s = (await load())[platform];
  if (!s?.clientId || !s.clientSecretEnc) {
    throw platformError(400, 'not_configured', `未配置 ${name} 平台接入（管理员可在“平台接入”页设置）`, { platform: name });
  }
  return { clientId: s.clientId, clientSecret: openSecret(s.clientSecretEnc), redirectUri: redirectUri(platform), options: s.options ?? {} };
}
