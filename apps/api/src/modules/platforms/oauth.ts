import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { config } from '../../config.js';
import { db, schema } from '../../db/index.js';
import { HttpError } from '../../lib/errors.js';
import { openSecret, sealSecret } from '../../lib/secret-box.js';
import type { AuthUser } from '../auth/rbac.js';
import { visibleAccount } from '../social/social.js';
import { storeConnection } from './connections.js';
import { platformApp } from './credentials.js';
import { platformError } from './http.js';
import { requireAdapter } from './index.js';
import type { PlatformConnection } from '../../db/schema.js';

/**
 * OAuth authorization-code flow.
 * - `state` is 32 random bytes; Redis keeps only its hash → { user, account, platform, sealed PKCE
 *   verifier, hash of a browser binding nonce } for STATE_TTL_SEC. The callback GETDELs it, so a
 *   state works once; forged or expired states find nothing.
 * - Binding: the connect response sets an HttpOnly SameSite=Lax cookie (path /api/platforms) with a
 *   random nonce. The callback (a top-level navigation coming back from the platform, so no bearer
 *   token) must present the same nonce: a state started by another user/browser is refused.
 * - PKCE S256 where the platform's web flow supports it (Google); others rely on client secret + state.
 */
export const STATE_TTL_SEC = 600;
const redis = new Redis(config.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 2 });
const b64url = (b: Buffer) => b.toString('base64url');
const sha = (s: string) => createHash('sha256').update(s).digest('base64url');
const stateKey = (state: string) => `oauth:state:${sha(state)}`;
export const bindingCookieName = (state: string) => `cp_oauth_${sha(state).slice(0, 16).replace(/[^A-Za-z0-9]/g, 'x')}`;

interface StoredState { userId: string; accountId: string; platform: string; verifierEnc: string | null; bindHash: string; at: number }

export interface ConnectStart { url: string; state: string; cookie: { name: string; value: string; maxAge: number } }

/** Starts a connect for `accountId` (owner or admin; 404 otherwise). */
export async function beginConnect(user: AuthUser, platform: string, accountId: string): Promise<ConnectStart> {
  const adapter = requireAdapter(platform);
  const account = await visibleAccount(user, accountId);
  if (account.platform !== platform) {
    throw platformError(400, 'account_platform_mismatch', `该账号不是 ${adapter.name} 账号`, { platform: adapter.name });
  }
  const app = await platformApp(platform, adapter.name);
  const state = b64url(randomBytes(32));
  const binding = b64url(randomBytes(24));
  const verifier = adapter.oauth.pkce ? b64url(randomBytes(48)) : null;
  const challenge = verifier ? createHash('sha256').update(verifier).digest('base64url') : null;
  const stored: StoredState = { userId: user.id, accountId: account.id, platform, verifierEnc: verifier ? sealSecret(verifier) : null, bindHash: sha(binding), at: Date.now() };
  await redis.set(stateKey(state), JSON.stringify(stored), 'EX', STATE_TTL_SEC);
  return { url: adapter.oauth.authorizeUrl(app, state, challenge), state, cookie: { name: bindingCookieName(state), value: binding, maxAge: STATE_TTL_SEC } };
}

export interface CallbackInput { platform: string; state?: string; code?: string; error?: string; errorDescription?: string; binding?: string }
export interface CallbackResult { user: AuthUser | null; accountId: string | null; connection: PlatformConnection | null; error: HttpError | null }

const invalidState = () => platformError(400, 'oauth_state_invalid', '授权请求无效、已使用或已过期，请重新发起授权');

function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a); const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Completes the flow. Never throws: the route turns the result into a redirect + audit entry. */
export async function completeConnect(input: CallbackInput): Promise<CallbackResult> {
  let user: AuthUser | null = null;
  let accountId: string | null = null;
  try {
    const adapter = requireAdapter(input.platform);
    if (!input.state || input.state.length > 200) throw invalidState();
    const raw = await redis.getdel(stateKey(input.state));
    if (!raw) throw invalidState();
    const st = JSON.parse(raw) as StoredState;
    if (st.platform !== input.platform) throw invalidState();
    const [u] = await db.select().from(schema.users).where(eq(schema.users.id, st.userId));
    if (u && !u.disabled) user = { id: u.id, username: u.username, role: u.role };
    accountId = st.accountId;
    if (!input.binding || !sameHash(sha(input.binding), st.bindHash)) {
      throw platformError(403, 'oauth_state_mismatch', '授权请求不属于当前浏览器会话，请在发起授权的浏览器中完成');
    }
    if (!user) throw platformError(403, 'oauth_state_invalid', '发起授权的用户已停用或删除');
    if (input.error) {
      const denied = input.error === 'access_denied' || input.error === 'user_denied';
      throw platformError(400, denied ? 'oauth_denied' : 'oauth_failed', denied ? '已在平台上取消授权' : `平台返回错误：${input.error}`,
        { platform: adapter.name, error: `${input.error}${input.errorDescription ? `: ${input.errorDescription}` : ''}`.slice(0, 200) });
    }
    if (!input.code || input.code.length > 2048) throw platformError(400, 'oauth_failed', '平台未返回授权码', { platform: adapter.name, error: 'missing code' });
    // The account must still exist and still be visible to the user who started the flow.
    const account = await visibleAccount(user, st.accountId);
    if (account.platform !== input.platform) throw invalidState();
    const app = await platformApp(input.platform, adapter.name);
    const tokens = await adapter.oauth.exchangeCode(app, input.code, st.verifierEnc ? openSecret(st.verifierEnc) : null);
    // Who is this token for? Also proves it works (and that e.g. the Google account has a channel).
    const probe: PlatformConnection = {
      id: `oauth-${account.id}`, socialAccountId: account.id, userId: account.userId, platform: input.platform,
      externalAccountId: tokens.externalAccountId ?? null, externalAccountName: null, scopes: tokens.scopes,
      accessTokenEnc: '', refreshTokenEnc: null, expiresAt: tokens.expiresAt ?? null, refreshExpiresAt: null, status: 'connected',
      lastError: null, lastErrorCode: null, connectedBy: user.id, connectedAt: new Date(), lastRefreshedAt: null, lastCheckedAt: null, updatedAt: new Date(),
    };
    let profile;
    try {
      profile = await adapter.fetchOwnProfile({ connection: probe, accessToken: tokens.accessToken, app });
    } catch (err) {
      // Don't keep a grant we won't store.
      await adapter.oauth.revoke?.(app, tokens.accessToken, tokens.refreshToken ?? null).catch(() => undefined);
      throw err;
    }
    if (input.platform === 'instagram' && profile.accountType && !['BUSINESS', 'MEDIA_CREATOR', 'CREATOR'].includes(profile.accountType)) {
      throw platformError(400, 'account_type', 'Instagram 官方接口只支持商业账号或创作者账号', { platform: adapter.name, type: profile.accountType });
    }
    const connection = await storeConnection(account, tokens, profile, user);
    return { user, accountId, connection, error: null };
  } catch (err) {
    const e = err instanceof HttpError ? err : platformError(500, 'oauth_failed', `授权失败：${(err as Error).message}`.slice(0, 300), { platform: input.platform, error: (err as Error).name });
    return { user, accountId, connection: null, error: e };
  }
}

/** Closes the state store (scripts / shutdown). */
export async function closeOauthStore(): Promise<void> { await redis.quit().catch(() => undefined); }
