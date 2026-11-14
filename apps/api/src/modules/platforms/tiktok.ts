import fs from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { config } from '../../config.js';
import type { HttpError } from '../../lib/errors.js';
import { withMediaFile } from '../media/media.js';
import { expiresIn, oauthTokenError, platformError, platformFetch, scrub, splitScopes } from './http.js';
import type { Authed, PlatformAdapter, PlatformAppOptions, PublishInput, TokenSet } from './types.js';

/**
 * TikTok: Login Kit for Web (authorization code; confidential client + state, no PKCE in the web
 * flow) and the Content Posting API.
 * - Default (app not audited for direct post): scope video.upload, `post/publish/inbox/video/init`
 *   → the video lands in the creator's TikTok inbox and they finish posting in the app
 *   (publish state awaiting_operator, capability draftOnly).
 * - Admin option directPost (app passed TikTok's audit): scope video.publish, creator_info/query
 *   then `post/publish/video/init`. Unaudited clients can only post SELF_ONLY (private).
 * Media is sent with FILE_UPLOAD (chunks) so it works with any storage backend; PULL_FROM_URL would
 * need a domain verified with TikTok. Photo posts need PULL_FROM_URL → not offered.
 * Comments: no official API for managing comments on one's own videos → manual only.
 * Tokens: access 24 h, refresh 365 days; revoke endpoint exists.
 */
const NAME = 'TikTok';
const POLL_MS = 5000;
const POLL_MAX_MS = 15 * 60_000;
const MIN_CHUNK = 5 * 1024 * 1024;
const MAX_SINGLE = 64 * 1024 * 1024;
const CHUNK = 10 * 1024 * 1024;

const scopes = (o: PlatformAppOptions) => ['user.info.basic', 'video.upload', ...(o.directPost ? ['video.publish'] : [])];

interface TtError { error?: { code?: string; message?: string; log_id?: string } }

function apiError(res: Response, body: unknown, msg: (raw: string | undefined) => string): HttpError {
  const e = (body as TtError | null)?.error ?? {};
  const code = e.code ?? '';
  const text = msg(e.message || code);
  const p = { platform: NAME, error: text };
  if (code === 'access_token_invalid' || res.status === 401) return platformError(401, 'auth_expired', `${NAME} 授权已失效，请重新授权`, p);
  if (code === 'scope_not_authorized' || code === 'scope_permission_missed' || code.startsWith('unaudited_client')) {
    return platformError(403, 'permission_missing', `${NAME} 授权缺少所需权限或应用未通过审核：${text}`, p);
  }
  if (code === 'rate_limit_exceeded' || code.startsWith('spam_risk') || code === 'reached_active_user_cap' || res.status === 429) {
    return platformError(429, 'rate_limited', `${NAME} 请求过于频繁或已达发布上限，请稍后再试`, p);
  }
  if (/file|video|duration|picture|frame_rate|resolution/i.test(code)) return platformError(400, 'media_rejected', `${NAME} 拒绝了该素材：${text}`, p);
  return platformError(502, 'error', `${NAME} 接口错误 ${res.status}：${text}`, { ...p, status: res.status });
}

/** TikTok may answer 200 with error.code != "ok". */
function checkOk(res: Response, body: unknown, secrets: string[]): void {
  const code = (body as TtError | null)?.error?.code;
  if (code && code !== 'ok') throw apiError(res, body, (raw) => scrub(raw ?? '', secrets));
}

async function api<T>(a: Authed, path: string, body?: unknown, method: 'GET' | 'POST' = 'POST'): Promise<T> {
  const { res, body: out } = await platformFetch(`${config.TIKTOK_API_BASE}${path}`, {
    method,
    headers: { authorization: `Bearer ${a.accessToken}`, ...(method === 'POST' ? { 'content-type': 'application/json; charset=UTF-8' } : {}) },
    body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
  }, { platform: NAME, secrets: [a.accessToken], signal: a.signal, limiterKey: a.connection.id, mapError: apiError });
  checkOk(res, out, [a.accessToken]);
  return (out as { data?: T }).data ?? ({} as T);
}

async function tokenCall(form: URLSearchParams, secrets: string[]): Promise<Record<string, unknown>> {
  const { res, body } = await platformFetch(`${config.TIKTOK_API_BASE}/v2/oauth/token/`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form,
  }, { platform: NAME, secrets, mapError: (r, b, m) => oauthTokenError(NAME, r, b, m) });
  const b = body as Record<string, unknown>;
  // Errors may come back as HTTP 200 with an `error` field.
  if (typeof b.error === 'string' && b.error) throw oauthTokenError(NAME, res, b, (raw) => scrub(raw ?? '', secrets));
  return b;
}

const tokenSet = (b: Record<string, unknown>): TokenSet => ({
  accessToken: String(b.access_token ?? ''),
  refreshToken: typeof b.refresh_token === 'string' ? b.refresh_token : null,
  expiresAt: expiresIn(b.expires_in),
  refreshExpiresAt: expiresIn(b.refresh_expires_in),
  scopes: splitScopes(b.scope),
  externalAccountId: typeof b.open_id === 'string' ? b.open_id : null,
});

/** FILE_UPLOAD chunking rules: ≤64 MB in one chunk; otherwise 10 MB chunks, the last one takes the remainder. */
function chunking(size: number): { chunkSize: number; count: number } {
  if (size <= MAX_SINGLE) return { chunkSize: size, count: 1 };
  const chunkSize = Math.max(MIN_CHUNK, CHUNK);
  return { chunkSize, count: Math.floor(size / chunkSize) };
}

const PRIVACY: Record<string, string> = { public: 'PUBLIC_TO_EVERYONE', unlisted: 'MUTUAL_FOLLOW_FRIENDS', private: 'SELF_ONLY' };

export const tiktokAdapter: PlatformAdapter = {
  id: 'tiktok',
  name: NAME,
  capabilities: (o) => ({
    publishVideo: true, publishImage: false, publishCarousel: false, draftOnly: !o.directPost, needsPublicMediaUrl: false,
    commentsRead: false, commentsReply: false, profileStats: false,
  }),

  oauth: {
    pkce: false,
    scopes,
    authorizeUrl(app, state) {
      const q = new URLSearchParams({ client_key: app.clientId, scope: scopes(app.options).join(','), response_type: 'code', redirect_uri: app.redirectUri, state });
      return `${config.TIKTOK_AUTH_URL}?${q}`;
    },
    async exchangeCode(app, code) {
      return tokenSet(await tokenCall(new URLSearchParams({
        client_key: app.clientId, client_secret: app.clientSecret, code, grant_type: 'authorization_code', redirect_uri: app.redirectUri,
      }), [app.clientSecret, code]));
    },
    refreshWindowMs: 10 * 60_000,
    async refresh(app, refreshToken) {
      if (!refreshToken) throw platformError(401, 'auth_expired', `${NAME} 授权已失效，请重新授权`, { platform: NAME, error: 'no refresh token' });
      return tokenSet(await tokenCall(new URLSearchParams({
        client_key: app.clientId, client_secret: app.clientSecret, grant_type: 'refresh_token', refresh_token: refreshToken,
      }), [app.clientSecret, refreshToken]));
    },
    async revoke(app, accessToken) {
      await platformFetch(`${config.TIKTOK_API_BASE}/v2/oauth/revoke/`, {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_key: app.clientId, client_secret: app.clientSecret, token: accessToken }),
      }, { platform: NAME, secrets: [app.clientSecret, accessToken], retries429: 0, mapError: (r, b, m) => oauthTokenError(NAME, r, b, m) });
    },
  },

  async fetchOwnProfile(a) {
    const d = await api<{ user?: { open_id?: string; display_name?: string; avatar_url?: string } }>(
      a, `/v2/user/info/?${new URLSearchParams({ fields: 'open_id,union_id,avatar_url,display_name' })}`, undefined, 'GET',
    );
    const u = d.user ?? {};
    if (!u.open_id) throw platformError(502, 'error', `${NAME} 未返回账号 ID`, { platform: NAME, status: 200, error: 'no open_id' });
    return {
      externalAccountId: u.open_id, name: u.display_name ?? null, handle: null,
      avatarUrl: u.avatar_url?.startsWith('https://') ? u.avatar_url : null, followers: null, posts: null, views: null,
    };
  },

  async publishUnavailableReason(input: PublishInput) {
    if (input.media.length !== 1 || input.media[0]!.fileType !== 'video') return { code: 'platform.media_unsupported', message: 'TikTok 只能通过 API 发布单个视频' };
    const mime = input.media[0]!.mimeType;
    if (!['video/mp4', 'video/quicktime', 'video/webm'].includes(mime)) return { code: 'platform.media_unsupported', message: 'TikTok 只接受 MP4 / MOV / WebM 视频' };
    return null;
  },

  async publish(a, input) {
    const asset = input.media[0]!;
    const direct = Boolean(a.app.options.directPost);
    const { chunkSize, count } = chunking(asset.fileSize);
    const source = { source: 'FILE_UPLOAD', video_size: asset.fileSize, chunk_size: chunkSize, total_chunk_count: count };
    let init: { publish_id?: string; upload_url?: string };
    if (direct) {
      const info = await api<{ privacy_level_options?: string[] }>(a, '/v2/post/publish/creator_info/query/');
      const want = PRIVACY[input.privacy ?? 'private']!;
      if (!info.privacy_level_options?.includes(want)) {
        throw platformError(400, 'privacy_unavailable', `${NAME} 账号不允许该可见范围：${want}`, { platform: NAME, privacy: want, options: (info.privacy_level_options ?? []).join(', ') });
      }
      init = await api(a, '/v2/post/publish/video/init/', {
        post_info: { title: (input.caption ?? input.title ?? '').slice(0, 2200), privacy_level: want }, source_info: source,
      });
    } else {
      init = await api(a, '/v2/post/publish/inbox/video/init/', { source_info: source });
    }
    if (!init.publish_id || !init.upload_url) throw platformError(502, 'error', `${NAME} 未返回上传地址`, { platform: NAME, status: 200, error: 'no upload url' });
    const uploadUrl = init.upload_url;
    await a.log?.('upload initialised', { mode: direct ? 'direct' : 'inbox', chunks: count });

    await withMediaFile(asset, async (file) => {
      const fd = await fs.promises.open(file, 'r');
      try {
        for (let i = 0; i < count; i++) {
          a.signal?.throwIfAborted();
          const start = i * chunkSize;
          const end = i === count - 1 ? asset.fileSize - 1 : start + chunkSize - 1;
          const buf = Buffer.alloc(end - start + 1);
          await fd.read(buf, 0, buf.length, start);
          await platformFetch(uploadUrl, {
            method: 'PUT',
            headers: { 'content-type': asset.mimeType, 'content-length': String(buf.length), 'content-range': `bytes ${start}-${end}/${asset.fileSize}` },
            body: buf,
          }, { platform: NAME, secrets: [a.accessToken], signal: a.signal, timeoutMs: 5 * 60_000, mapError: apiError });
        }
      } finally { await fd.close(); }
    });

    const until = Date.now() + POLL_MAX_MS;
    for (;;) {
      const s = await api<{ status?: string; fail_reason?: string; publicaly_available_post_id?: (string | number)[] }>(
        a, '/v2/post/publish/status/fetch/', { publish_id: init.publish_id },
      );
      if (s.status === 'FAILED') throw platformError(400, 'publish_failed', `${NAME} 发布失败：${s.fail_reason ?? 'FAILED'}`, { platform: NAME, error: s.fail_reason ?? 'FAILED' });
      if (s.status === 'SEND_TO_USER_INBOX' && !direct) return { externalId: init.publish_id, state: 'awaiting_operator' };
      if (s.status === 'PUBLISH_COMPLETE') {
        const postId = s.publicaly_available_post_id?.[0];
        return { externalId: postId !== undefined ? String(postId) : init.publish_id, state: direct ? 'published' : 'awaiting_operator' };
      }
      if (Date.now() > until) throw platformError(504, 'publish_timeout', `${NAME} 处理视频超时`, { platform: NAME });
      await sleep(POLL_MS, undefined, a.signal ? { signal: a.signal } : undefined);
    }
  },

  async listComments() {
    throw platformError(400, 'capability_unsupported', `${NAME} 官方 API 不支持读取评论，请人工处理`, { platform: NAME });
  },
  async replyToComment() {
    throw platformError(400, 'capability_unsupported', `${NAME} 官方 API 不支持回复评论，请人工处理`, { platform: NAME });
  },
};
