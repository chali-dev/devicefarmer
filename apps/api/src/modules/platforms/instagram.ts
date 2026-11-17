import { setTimeout as sleep } from 'node:timers/promises';
import { config } from '../../config.js';
import type { HttpError } from '../../lib/errors.js';
import { mediaUrlProblem, publicMediaUrl } from './media-url.js';
import { dayStartSec, expiresIn, num, oauthTokenError, platformError, platformFetch, splitScopes, withOptionalScope } from './http.js';
import type { Authed, PlatformAdapter, PlatformComment, PublishInput, TokenSet } from './types.js';

/**
 * Instagram: "Instagram API with Instagram Login" (business login for Instagram, 2024+). Chosen over
 * the Facebook Login variant because it needs no linked Facebook Page and is Meta's current path for
 * professional accounts. Works only for Business and Creator accounts (personal accounts are refused
 * by Meta). Permissions (need Meta App Review for other people's accounts):
 *   instagram_business_basic, instagram_business_content_publish, instagram_business_manage_comments,
 *   instagram_business_manage_insights (账号分析; optional for existing connections).
 * Tokens: code → short-lived token (1 h) → long-lived token (60 days), refreshed with
 * ig_refresh_token (the token refreshes itself; there is no separate refresh token and no revoke
 * endpoint, so disconnect only deletes it here). No PKCE in this flow (confidential client + state).
 * Publishing: Meta fetches media by URL → a presigned public HTTPS URL is needed (S3 storage only).
 * Images must be JPEG. Limit: 100 API-published posts per 24 h per account.
 */
const NAME = 'Instagram';
/** Account insights (账号分析: views/likes/comments/shares per day). Connections made without it still work (scope missing). */
const INSIGHTS_SCOPE = 'instagram_business_manage_insights';
const SCOPES = ['instagram_business_basic', 'instagram_business_content_publish', 'instagram_business_manage_comments', INSIGHTS_SCOPE];
const INSIGHT_METRICS = ['views', 'likes', 'comments', 'shares'] as const;
const POLL_MS = 5000;
const POLL_MAX_MS = 10 * 60_000;

interface GraphErrorBody { error?: { message?: string; type?: string; code?: number; error_subcode?: number; error_user_msg?: string } }

function graphError(res: Response, body: unknown, msg: (raw: string | undefined) => string): HttpError {
  const e = (body as GraphErrorBody | null)?.error ?? {};
  const text = msg(e.error_user_msg ?? e.message);
  const code = e.code ?? 0;
  const sub = e.error_subcode ?? 0;
  const p = { platform: NAME, error: text };
  if (code === 190 || code === 102 || res.status === 401) return platformError(401, 'auth_expired', `${NAME} 授权已失效，请重新授权`, p);
  if (code === 10 || (code >= 200 && code <= 299)) return platformError(403, 'permission_missing', `${NAME} 授权缺少所需权限：${text}`, p);
  if ([4, 17, 32, 613, 80002].includes(code) || sub === 2207042 || res.status === 429) {
    return platformError(429, 'rate_limited', `${NAME} 请求过于频繁或已达发布上限，请稍后再试`, p);
  }
  if (code === 9004 || code === 36003 || code === 352 || (sub >= 2207000 && sub < 2208000)) {
    return platformError(400, 'media_rejected', `${NAME} 拒绝了该素材：${text}`, p);
  }
  return platformError(502, 'error', `${NAME} 接口错误 ${res.status}：${text}`, { ...p, status: res.status });
}

async function graph<T>(a: Authed, method: 'GET' | 'POST', path: string, params: Record<string, string> = {}): Promise<T> {
  const qs = new URLSearchParams(params);
  const url = `${config.INSTAGRAM_GRAPH_BASE}/${path}${method === 'GET' && qs.size ? `?${qs}` : ''}`;
  const { body } = await platformFetch(url, {
    method,
    headers: { authorization: `Bearer ${a.accessToken}`, accept: 'application/json', ...(method === 'POST' ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
    body: method === 'POST' ? qs : undefined,
  }, { platform: NAME, secrets: [a.accessToken], signal: a.signal, limiterKey: a.connection.id, mapError: graphError });
  return body as T;
}

const igUser = (a: Authed) => a.connection.externalAccountId ?? 'me';

/** Waits until a media container is FINISHED (ERROR / EXPIRED → coded error). */
async function waitContainer(a: Authed, id: string): Promise<void> {
  const until = Date.now() + POLL_MAX_MS;
  for (;;) {
    const s = await graph<{ status_code?: string; status?: string }>(a, 'GET', id, { fields: 'status_code,status' });
    if (s.status_code === 'FINISHED' || s.status_code === 'PUBLISHED') return;
    if (s.status_code === 'ERROR') throw platformError(400, 'media_rejected', `${NAME} 处理素材失败：${s.status ?? 'ERROR'}`, { platform: NAME, error: s.status ?? 'ERROR' });
    if (s.status_code === 'EXPIRED') throw platformError(502, 'publish_failed', `${NAME} 素材容器已过期`, { platform: NAME, error: 'EXPIRED' });
    if (Date.now() > until) throw platformError(504, 'publish_timeout', `${NAME} 处理素材超时`, { platform: NAME });
    await sleep(POLL_MS, undefined, a.signal ? { signal: a.signal } : undefined);
  }
}

const isJpeg = (mime: string) => mime === 'image/jpeg';
const isIgVideo = (mime: string) => mime === 'video/mp4' || mime === 'video/quicktime';

const tokenOpts = (secrets: string[]) => ({ platform: NAME, secrets, mapError: (r: Response, b: unknown, m: (raw: string | undefined) => string) => oauthTokenError(NAME, r, b, m) });

async function exchangeLongLived(app: { clientSecret: string }, shortToken: string): Promise<{ accessToken: string; expiresAt: Date | null }> {
  const q = new URLSearchParams({ grant_type: 'ig_exchange_token', client_secret: app.clientSecret, access_token: shortToken });
  const { body } = await platformFetch(`${config.INSTAGRAM_GRAPH_BASE}/access_token?${q}`, { method: 'GET' }, tokenOpts([app.clientSecret, shortToken]));
  const b = body as { access_token?: string; expires_in?: number };
  if (!b.access_token) throw platformError(502, 'oauth_failed', `${NAME} 未返回长期令牌`, { platform: NAME, error: 'no long-lived token' });
  return { accessToken: b.access_token, expiresAt: expiresIn(b.expires_in) };
}

export const instagramAdapter: PlatformAdapter = {
  id: 'instagram',
  name: NAME,
  capabilities: () => ({
    publishVideo: true, publishImage: true, publishCarousel: true, draftOnly: false, needsPublicMediaUrl: true,
    commentsRead: true, commentsReply: true, profileStats: true, accountStats: true,
  }),

  oauth: {
    pkce: false,
    scopes: () => SCOPES,
    authorizeUrl(app, state) {
      const q = new URLSearchParams({ client_id: app.clientId, redirect_uri: app.redirectUri, response_type: 'code', scope: SCOPES.join(','), state });
      return `${config.INSTAGRAM_AUTH_URL}?${q}`;
    },
    async exchangeCode(app, code) {
      const form = new URLSearchParams({ client_id: app.clientId, client_secret: app.clientSecret, grant_type: 'authorization_code', redirect_uri: app.redirectUri, code });
      const { body } = await platformFetch(config.INSTAGRAM_TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form },
        tokenOpts([app.clientSecret, code]));
      // Documented as either a flat object or { data: [ … ] }.
      const raw = body as { access_token?: string; user_id?: string | number; permissions?: string | string[]; data?: { access_token?: string; user_id?: string | number; permissions?: string }[] };
      const b = raw.data?.[0] ?? raw;
      if (!b.access_token) throw platformError(502, 'oauth_failed', `${NAME} 未返回访问令牌`, { platform: NAME, error: 'no access token' });
      const long = await exchangeLongLived(app, b.access_token);
      return {
        accessToken: long.accessToken, refreshToken: null, expiresAt: long.expiresAt,
        scopes: Array.isArray(b.permissions) ? b.permissions : splitScopes(b.permissions),
        externalAccountId: b.user_id !== undefined ? String(b.user_id) : null,
      } satisfies TokenSet;
    },
    // Long-lived tokens last 60 days and can be refreshed once they are 24 h old.
    refreshWindowMs: 7 * 86400_000,
    async refresh(_app, _refreshToken, accessToken) {
      const q = new URLSearchParams({ grant_type: 'ig_refresh_token', access_token: accessToken });
      const { body } = await platformFetch(`${config.INSTAGRAM_GRAPH_BASE}/refresh_access_token?${q}`, { method: 'GET' }, {
        platform: NAME, secrets: [accessToken], mapError: graphError,
      });
      const b = body as { access_token?: string; expires_in?: number; permissions?: string };
      if (!b.access_token) throw platformError(401, 'auth_expired', `${NAME} 授权已失效，请重新授权`, { platform: NAME, error: 'refresh returned no token' });
      return { accessToken: b.access_token, refreshToken: null, expiresAt: expiresIn(b.expires_in), scopes: splitScopes(b.permissions) };
    },
  },

  async fetchOwnProfile(a) {
    const me = await graph<{ id?: string; user_id?: string; username?: string; name?: string; account_type?: string; profile_picture_url?: string; followers_count?: number; media_count?: number }>(
      a, 'GET', 'me', { fields: 'user_id,username,name,account_type,profile_picture_url,followers_count,media_count' },
    );
    const id = me.user_id ?? me.id;
    if (!id) throw platformError(502, 'error', `${NAME} 未返回账号 ID`, { platform: NAME, status: 200, error: 'no id' });
    return {
      externalAccountId: String(id), name: me.name ?? me.username ?? null, handle: me.username ?? null,
      avatarUrl: me.profile_picture_url?.startsWith('https://') ? me.profile_picture_url : null,
      followers: num(me.followers_count), posts: num(me.media_count), views: null, accountType: me.account_type ?? null,
    };
  },

  /**
   * Counters from the profile (basic scope); per-day views/likes/comments/shares from account insights
   * (`metric_type=total_value` over one UTC day each; needs instagram_business_manage_insights).
   */
  async fetchAccountStats(a, days) {
    const me = await graph<{ followers_count?: number; follows_count?: number; media_count?: number }>(a, 'GET', 'me', { fields: 'followers_count,follows_count,media_count' });
    const now = Math.floor(Date.now() / 1000);
    type Insights = { data?: { name?: string; total_value?: { value?: number } }[] };
    const activity = await withOptionalScope(a, INSIGHTS_SCOPE, async () => {
      const out = [];
      for (const day of days) {
        const since = dayStartSec(day);
        if (since > now) continue;
        const r = await graph<Insights>(a, 'GET', `${igUser(a)}/insights`, {
          metric: INSIGHT_METRICS.join(','), period: 'day', metric_type: 'total_value', since: String(since), until: String(Math.min(since + 86400, now)),
        });
        const v = (m: string) => num(r.data?.find((x) => x.name === m)?.total_value?.value);
        out.push({ day, views: v('views'), likes: v('likes'), shares: v('shares'), comments: v('comments') });
      }
      return out;
    });
    return {
      followers: num(me.followers_count), following: num(me.follows_count), posts: num(me.media_count), totalViews: null, totalLikes: null,
      days: activity ?? [], missing: activity ? [] : [...INSIGHT_METRICS], missingScopes: activity ? [] : [INSIGHTS_SCOPE],
    };
  },

  async publishUnavailableReason(input: PublishInput) {
    const m = input.media;
    if (!m.length || m.length > 10) return { code: 'platform.media_unsupported', message: 'Instagram 每条帖子需要 1–10 个素材' };
    for (const x of m) {
      if (x.fileType === 'image' && !isJpeg(x.mimeType)) return { code: 'platform.media_unsupported', message: 'Instagram 只接受 JPEG 图片' };
      if (x.fileType === 'video' && !isIgVideo(x.mimeType)) return { code: 'platform.media_unsupported', message: 'Instagram 只接受 MP4 / MOV 视频' };
    }
    for (const x of m) {
      const problem = await mediaUrlProblem(x);
      if (problem) return { code: problem.code, message: problem.message };
    }
    return null;
  },

  async publish(a, input) {
    const user = igUser(a);
    const caption = (input.caption ?? '').slice(0, 2200);
    let creationId: string;
    if (input.media.length === 1) {
      const x = input.media[0]!;
      const url = await publicMediaUrl(x);
      const params: Record<string, string> = x.fileType === 'video'
        ? { media_type: 'REELS', video_url: url, caption, share_to_feed: 'true' }
        : { image_url: url, caption };
      creationId = (await graph<{ id: string }>(a, 'POST', `${user}/media`, params)).id;
      await a.log?.('media container created', { kind: x.fileType });
      await waitContainer(a, creationId);
    } else {
      const children: string[] = [];
      for (const x of input.media) {
        const url = await publicMediaUrl(x);
        const params: Record<string, string> = x.fileType === 'video'
          ? { media_type: 'VIDEO', video_url: url, is_carousel_item: 'true' }
          : { image_url: url, is_carousel_item: 'true' };
        const id = (await graph<{ id: string }>(a, 'POST', `${user}/media`, params)).id;
        await waitContainer(a, id);
        children.push(id);
      }
      creationId = (await graph<{ id: string }>(a, 'POST', `${user}/media`, { media_type: 'CAROUSEL', children: children.join(','), caption })).id;
      await a.log?.('carousel container created', { items: children.length });
      await waitContainer(a, creationId);
    }
    await a.commit?.();
    const published = await graph<{ id: string }>(a, 'POST', `${user}/media_publish`, { creation_id: creationId });
    const info = await graph<{ permalink?: string }>(a, 'GET', published.id, { fields: 'permalink' }).catch(() => ({ permalink: undefined }));
    return { externalId: published.id, url: info.permalink, state: 'published' };
  },

  /**
   * Cursor = ISO time of the newest comment already seen: returns newer comments (top-level and
   * replies) on the 25 most recent posts; nextCursor = the newest time returned (or the old cursor).
   */
  async listComments(a, cursor) {
    const since = cursor ? Date.parse(cursor) : 0;
    const media = await graph<{ data?: { id: string; comments_count?: number }[] }>(a, 'GET', `${igUser(a)}/media`, { fields: 'id,comments_count', limit: '25' });
    type C = { id: string; text?: string; timestamp?: string; username?: string; like_count?: number };
    const out: PlatformComment[] = [];
    let newest = since;
    for (const m of media.data ?? []) {
      if (!m.comments_count) continue;
      const r = await graph<{ data?: (C & { replies?: { data?: C[] } })[] }>(a, 'GET', `${m.id}/comments`, {
        fields: 'id,text,timestamp,username,like_count,replies{id,text,timestamp,username,like_count}', limit: '50',
      });
      const push = (c: C, parentId: string | null, replies: number | null) => {
        const t = c.timestamp ? Date.parse(c.timestamp) : 0;
        if (t <= since) return;
        newest = Math.max(newest, t);
        out.push({ id: c.id, parentId, postId: m.id, authorName: c.username ?? null, text: c.text ?? '', publishedAt: c.timestamp ?? null, likeCount: num(c.like_count), replyCount: replies });
      };
      for (const c of r.data ?? []) {
        push(c, null, c.replies?.data?.length ?? 0);
        for (const rep of c.replies?.data ?? []) push(rep, c.id, null);
      }
    }
    return { comments: out, nextCursor: newest > 0 ? new Date(newest).toISOString() : cursor };
  },

  async replyToComment(a, commentId, text) {
    const r = await graph<{ id?: string }>(a, 'POST', `${commentId}/replies`, { message: text });
    if (!r.id) throw platformError(502, 'error', `${NAME} 未返回回复 ID`, { platform: NAME, status: 200, error: 'no reply id' });
    return { id: r.id };
  },
};
