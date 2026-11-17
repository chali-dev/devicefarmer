import { eq, inArray } from 'drizzle-orm';
import { db, schema } from '../../db/index.js';
import type { PlatformConnection, SocialAccount } from '../../db/schema.js';
import { HttpError } from '../../lib/errors.js';
import { openSecret, sealSecret } from '../../lib/secret-box.js';
import { isAdmin, type AuthUser } from '../auth/rbac.js';
import { connectionChanged } from '../notify/triggers.js';
import { visibleAccount, writeLogs, type LogEntry } from '../social/social.js';
import { platformApp } from './credentials.js';
import { platformError } from './http.js';
import { requireAdapter } from './index.js';
import type { Authed, OwnProfile, TokenSet } from './types.js';

/**
 * platform_connections: one OAuth authorisation per social account. Tokens are sealed at rest and
 * only opened inside `authed()` for an outgoing platform call. `publicConnection` is the only shape
 * that leaves this module (REST); there are no connection events.
 */
const pc = schema.platformConnections;

export interface PublicConnection {
  id: string;
  socialAccountId: string;
  userId: string;
  platform: string;
  externalAccountId: string | null;
  externalAccountName: string | null;
  scopes: string[];
  status: PlatformConnection['status'];
  expiresAt: Date | null;
  lastError: string | null;
  lastErrorCode: string | null;
  connectedAt: Date;
  lastRefreshedAt: Date | null;
  lastCheckedAt: Date | null;
}

export const publicConnection = (c: PlatformConnection): PublicConnection => ({
  id: c.id, socialAccountId: c.socialAccountId, userId: c.userId, platform: c.platform,
  externalAccountId: c.externalAccountId, externalAccountName: c.externalAccountName, scopes: c.scopes,
  status: c.status, expiresAt: c.expiresAt, lastError: c.lastError, lastErrorCode: c.lastErrorCode,
  connectedAt: c.connectedAt, lastRefreshedAt: c.lastRefreshedAt, lastCheckedAt: c.lastCheckedAt,
});

export async function connectionFor(socialAccountId: string): Promise<PlatformConnection | undefined> {
  const [row] = await db.select().from(pc).where(eq(pc.socialAccountId, socialAccountId));
  return row;
}

/** Connections of the given accounts that `user` may see (owner or admin). */
export async function visibleConnections(user: AuthUser, accountIds?: string[]): Promise<PublicConnection[]> {
  if (accountIds && !accountIds.length) return [];
  const rows = await db.select().from(pc).where(accountIds ? inArray(pc.socialAccountId, accountIds) : undefined);
  return rows.filter((r) => isAdmin(user) || r.userId === user.id).map(publicConnection);
}

/** Creates or replaces the account's connection after a successful OAuth callback. */
export async function storeConnection(account: SocialAccount, tokens: TokenSet, profile: OwnProfile, actor: AuthUser): Promise<PlatformConnection> {
  const row = await db.transaction(async (tx) => {
    const now = new Date();
    const values = {
      socialAccountId: account.id, userId: account.userId, platform: account.platform,
      externalAccountId: profile.externalAccountId, externalAccountName: profile.name ?? profile.handle,
      scopes: tokens.scopes, accessTokenEnc: sealSecret(tokens.accessToken),
      refreshTokenEnc: tokens.refreshToken ? sealSecret(tokens.refreshToken) : null,
      expiresAt: tokens.expiresAt ?? null, refreshExpiresAt: tokens.refreshExpiresAt ?? null,
      status: 'connected' as const, lastError: null, lastErrorCode: null,
      connectedBy: actor.id, connectedAt: now, lastRefreshedAt: null, lastCheckedAt: now,
    };
    const [row] = await tx.insert(pc).values(values).onConflictDoUpdate({ target: pc.socialAccountId, set: values }).returning();
    const logs: LogEntry[] = [{
      accountId: account.id, action: 'connect', field: 'platformConnection', fromValue: null,
      toValue: [profile.name ?? profile.handle, profile.externalAccountId].filter(Boolean).join(' · '), message: `scopes: ${tokens.scopes.join(' ')}`.slice(0, 300),
    }];
    if (!account.externalId) {
      await tx.update(schema.socialAccounts).set({ externalId: profile.externalAccountId }).where(eq(schema.socialAccounts.id, account.id));
      logs.push({ accountId: account.id, action: 'update', field: 'externalId', fromValue: null, toValue: profile.externalAccountId });
    }
    await writeLogs(tx, actor, logs);
    return row!;
  });
  await connectionChanged(row, 'connected');
  return row;
}

const HARD_REFRESH_FAILURES = new Set(['platform.auth_expired', 'platform.oauth_invalid_grant', 'platform.oauth_invalid_client']);
const codeOf = (err: unknown) => (err instanceof HttpError ? err.code ?? null : null);
const authExpired = (platform: string, cause?: string) =>
  platformError(401, 'auth_expired', `${platform} 授权已失效，请重新授权`, { platform, error: cause ?? '' });

/** The only place a connection becomes expired/error (alerts: connection.expired). */
async function setState(conn: PlatformConnection, status: PlatformConnection['status'], err: unknown): Promise<void> {
  await db.update(pc).set({ status, lastError: (err as Error).message.slice(0, 500), lastErrorCode: codeOf(err) }).where(eq(pc.id, conn.id));
  await connectionChanged(conn, status, codeOf(err));
}

/**
 * The connection with a usable access token. Tokens within the adapter's refresh window are
 * refreshed first, under a row lock (concurrent callers refresh once). Hard refresh failures
 * (revoked / invalid grant / bad app credentials) or any failure once the token has expired mark
 * the connection `expired` and throw platform.auth_expired; a transient failure with a still-valid
 * token keeps using it.
 */
export async function authed(conn: PlatformConnection, opts: Pick<Authed, 'signal' | 'log' | 'commit'> = {}): Promise<Authed> {
  const adapter = requireAdapter(conn.platform);
  if (conn.status === 'expired' || conn.status === 'revoked') throw authExpired(adapter.name, conn.lastError ?? undefined);
  const app = await platformApp(conn.platform, adapter.name);
  const due = (c: PlatformConnection) => c.expiresAt !== null && c.expiresAt.getTime() - Date.now() < adapter.oauth.refreshWindowMs;
  let row = conn;
  if (due(conn)) {
    let failure: unknown = null;
    row = await db.transaction(async (tx) => {
      const [cur] = await tx.select().from(pc).where(eq(pc.id, conn.id)).for('update');
      if (!cur) throw platformError(404, 'not_connected', '该账号未通过官方接口授权');
      if (!due(cur)) return cur; // refreshed by someone else meanwhile
      try {
        const t = await adapter.oauth.refresh(app, cur.refreshTokenEnc ? openSecret(cur.refreshTokenEnc) : null, openSecret(cur.accessTokenEnc));
        const [next] = await tx.update(pc).set({
          accessTokenEnc: sealSecret(t.accessToken),
          refreshTokenEnc: t.refreshToken ? sealSecret(t.refreshToken) : cur.refreshTokenEnc,
          expiresAt: t.expiresAt ?? null, refreshExpiresAt: t.refreshExpiresAt ?? cur.refreshExpiresAt,
          scopes: t.scopes.length ? t.scopes : cur.scopes,
          status: 'connected', lastError: null, lastErrorCode: null, lastRefreshedAt: new Date(),
        }).where(eq(pc.id, cur.id)).returning();
        return next!;
      } catch (err) {
        failure = err;
        return cur;
      }
    });
    if (failure) {
      const expired = row.expiresAt !== null && row.expiresAt.getTime() <= Date.now();
      if (HARD_REFRESH_FAILURES.has(codeOf(failure) ?? '') || expired) {
        await setState(row, 'expired', failure);
        throw authExpired(adapter.name, (failure as Error).message.slice(0, 200));
      }
      await opts.log?.('token refresh failed, the current token is still valid', { code: codeOf(failure) });
      await db.update(pc).set({ lastError: (failure as Error).message.slice(0, 500), lastErrorCode: codeOf(failure) }).where(eq(pc.id, row.id));
    } else {
      await opts.log?.('access token refreshed');
    }
  }
  return { connection: row, accessToken: openSecret(row.accessTokenEnc), app, ...opts };
}

/** Records the outcome of a platform call on the connection (auth failures → expired). */
async function recordCallError(conn: PlatformConnection, err: unknown): Promise<void> {
  const code = codeOf(err);
  if (code === 'platform.auth_expired') await setState(conn, 'expired', err);
  else if (code === 'platform.permission_missing') await setState(conn, 'error', err);
  else if (code?.startsWith('platform.')) await db.update(pc).set({ lastError: (err as Error).message.slice(0, 500), lastErrorCode: code }).where(eq(pc.id, conn.id));
}

/** Runs `fn` with the account's authed connection; records failures on the connection. */
export async function withConnection<T>(socialAccountId: string, fn: (a: Authed) => Promise<T>, opts: Pick<Authed, 'signal' | 'log' | 'commit'> = {}): Promise<T> {
  const conn = await connectionFor(socialAccountId);
  if (!conn) throw platformError(409, 'not_connected', '该账号未通过官方接口授权');
  const a = await authed(conn, opts);
  try {
    const out = await fn(a);
    const [fresh] = await db.select({ status: pc.status, lastError: pc.lastError }).from(pc).where(eq(pc.id, conn.id));
    if (fresh && (fresh.status !== 'connected' || fresh.lastError)) {
      await db.update(pc).set({ status: 'connected', lastError: null, lastErrorCode: null }).where(eq(pc.id, conn.id));
      if (fresh.status !== 'connected') await connectionChanged(conn, 'connected');
    }
    return out;
  } catch (err) {
    await recordCallError(a.connection, err).catch(() => undefined);
    throw err;
  }
}

/**
 * Disconnect: best-effort revocation at the platform (where an endpoint exists), then the row (and
 * so the tokens) is deleted and the account log records it. Owner or admin; others get 404.
 */
export async function disconnect(user: AuthUser, socialAccountId: string): Promise<{ revoked: boolean | null }> {
  const account = await visibleAccount(user, socialAccountId);
  const conn = await connectionFor(account.id);
  if (!conn) throw platformError(404, 'not_connected', '该账号未通过官方接口授权');
  const adapter = requireAdapter(conn.platform);
  let revoked: boolean | null = null;
  if (adapter.oauth.revoke) {
    try {
      const app = await platformApp(conn.platform, adapter.name);
      await adapter.oauth.revoke(app, openSecret(conn.accessTokenEnc), conn.refreshTokenEnc ? openSecret(conn.refreshTokenEnc) : null);
      revoked = true;
    } catch { revoked = false; }
  }
  await db.transaction(async (tx) => {
    await tx.delete(pc).where(eq(pc.id, conn.id));
    await writeLogs(tx, user, [{
      accountId: account.id, action: 'disconnect', field: 'platformConnection', fromValue: conn.externalAccountName ?? conn.externalAccountId, toValue: null,
      message: revoked === null ? 'no revoke endpoint; tokens deleted' : revoked ? 'revoked at the platform; tokens deleted' : 'platform revoke failed; tokens deleted',
    }]);
  });
  return { revoked };
}
