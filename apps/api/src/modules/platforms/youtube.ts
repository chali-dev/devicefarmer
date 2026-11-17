import fs from 'node:fs';
import { config } from '../../config.js';
import type { HttpError } from '../../lib/errors.js';
import { withMediaFile } from '../media/media.js';
import { GOOGLE_QUOTA_REASONS, googleErrorReasons, type GoogleApiErrorBody } from '../tracked/youtube.js';
import { expiresIn, num, oauthTokenError, platformError, platformFetch, splitScopes, withOptionalScope } from './http.js';
import type { Authed, PlatformAdapter, PlatformComment, PublishInput, TokenSet } from './types.js';

/**
 * YouTube: Google OAuth 2.0 (authorization code + PKCE S256, offline access for a refresh token)
 * and the YouTube Data API v3.
 * - publish: resumable upload (videos.insert, 8 MiB chunks, resumes after 308 / transient errors).
 *   Quota: 1600 units per upload (default project quota 10 000/day). Projects that have not passed
 *   Google's API audit can only upload private videos.
 * - comments: commentThreads.list (allThreadsRelatedToChannelId) / comments.insert (reply).
 * - profile: channels.list mine=true.
 */
const NAME = 'YouTube';
const SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube.force-ssl',
  'https://www.googleapis.com/auth/youtube.readonly',
  // 账号分析: YouTube Analytics API per-day views/likes/shares/comments. Connections made without it still work.
  'https://www.googleapis.com/auth/yt-analytics.readonly',
];
const ANALYTICS_SCOPE = SCOPES[3]!;
const ANALYTICS_METRICS = ['views', 'likes', 'shares', 'comments'] as const;
const CHUNK = 8 * 1024 * 1024; // multiple of 256 KiB, as the resumable protocol requires

function apiError(res: Response, body: unknown, msg: (raw: string | undefined) => string): HttpError {
  const reasons = googleErrorReasons(body);
  const text = msg((body as GoogleApiErrorBody | null)?.error?.message);
  const p = { platform: NAME, error: text };
  if (res.status === 401 || reasons.includes('authError')) return platformError(401, 'auth_expired', `${NAME} 授权已失效，请重新授权`, p);
  if (reasons.some((r) => r === 'quotaExceeded' || r === 'dailyLimitExceeded')) return platformError(429, 'quota', `${NAME} API 配额已用尽`, p);
  if (res.status === 429 || reasons.some((r) => GOOGLE_QUOTA_REASONS.has(r)) || reasons.includes('uploadLimitExceeded')) {
    return platformError(429, 'rate_limited', `${NAME} 请求过于频繁或已达上传上限，请稍后再试`, p);
  }
  if (reasons.some((r) => r === 'insufficientPermissions' || r === 'forbidden' || r === 'ACCESS_TOKEN_SCOPE_INSUFFICIENT') || /insufficient.*scope/i.test(text)) {
    return platformError(403, 'permission_missing', `${NAME} 授权缺少所需权限：${text}`, p);
  }
  if (reasons.includes('youtubeSignupRequired') || reasons.includes('channelNotFound')) return platformError(400, 'no_channel', `该 Google 账号没有 YouTube 频道`, p);
  if (reasons.some((r) => /^invalid(Title|Description|Tags|Filename|VideoMetadata|CategoryId)$/.test(r) || r === 'mediaBodyRequired' || r === 'invalidVideoGameRating')) {
    return platformError(400, 'media_rejected', `${NAME} 拒绝了该内容：${text}`, p);
  }
  return platformError(502, 'error', `${NAME} 接口错误 ${res.status}：${text}`, { ...p, status: res.status });
}

const tokenOpts = (secrets: string[]) => ({ platform: NAME, secrets, mapError: (r: Response, b: unknown, m: (raw: string | undefined) => string) => oauthTokenError(NAME, r, b, m) });

function tokenSet(b: Record<string, unknown>, fallbackRefresh: string | null = null): TokenSet {
  return {
    accessToken: String(b.access_token ?? ''),
    refreshToken: typeof b.refresh_token === 'string' ? b.refresh_token : fallbackRefresh,
    expiresAt: expiresIn(b.expires_in),
    scopes: splitScopes(b.scope, /\s+/),
  };
}

async function api<T>(a: Authed, method: string, resource: string, params: Record<string, string>, body?: unknown): Promise<T> {
  const qs = new URLSearchParams(params);
  const { body: out } = await platformFetch(`${config.YOUTUBE_API_BASE}/${resource}?${qs}`, {
    method,
    headers: { authorization: `Bearer ${a.accessToken}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  }, { platform: NAME, secrets: [a.accessToken], signal: a.signal, limiterKey: a.connection.id, mapError: apiError });
  return out as T;
}

interface Channel { id: string; snippet?: { title?: string; customUrl?: string; thumbnails?: Record<string, { url?: string }> }; statistics?: { subscriberCount?: string; hiddenSubscriberCount?: boolean; videoCount?: string; viewCount?: string } }
interface ThreadList {
  nextPageToken?: string;
  items?: { id: string; snippet?: { videoId?: string; totalReplyCount?: number; topLevelComment?: { id: string; snippet?: CommentSnippet } }; replies?: { comments?: { id: string; snippet?: CommentSnippet }[] } }[];
}
interface CommentSnippet { textDisplay?: string; textOriginal?: string; authorDisplayName?: string; publishedAt?: string; likeCount?: number; parentId?: string; videoId?: string }

async function readChunk(fd: fs.promises.FileHandle, start: number, len: number): Promise<Uint8Array<ArrayBuffer>> {
  const buf = new Uint8Array(len);
  const { bytesRead } = await fd.read(buf, 0, len, start);
  return bytesRead === len ? buf : buf.slice(0, bytesRead);
}

export const youtubeAdapter: PlatformAdapter = {
  id: 'youtube',
  name: NAME,
  capabilities: () => ({
    publishVideo: true, publishImage: false, publishCarousel: false, draftOnly: false, needsPublicMediaUrl: false,
    commentsRead: true, commentsReply: true, profileStats: true, accountStats: true,
  }),

  oauth: {
    pkce: true,
    scopes: () => SCOPES,
    authorizeUrl(app, state, challenge) {
      const q = new URLSearchParams({
        client_id: app.clientId, redirect_uri: app.redirectUri, response_type: 'code', scope: SCOPES.join(' '),
        access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state,
        ...(challenge ? { code_challenge: challenge, code_challenge_method: 'S256' } : {}),
      });
      return `${config.GOOGLE_OAUTH_AUTH_URL}?${q}`;
    },
    async exchangeCode(app, code, verifier) {
      const form = new URLSearchParams({
        code, client_id: app.clientId, client_secret: app.clientSecret, redirect_uri: app.redirectUri, grant_type: 'authorization_code',
        ...(verifier ? { code_verifier: verifier } : {}),
      });
      const { body } = await platformFetch(config.GOOGLE_OAUTH_TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form },
        tokenOpts([app.clientSecret, code]));
      return tokenSet(body as Record<string, unknown>);
    },
    refreshWindowMs: 5 * 60_000,
    async refresh(app, refreshToken) {
      if (!refreshToken) throw platformError(401, 'auth_expired', `${NAME} 授权已失效，请重新授权`, { platform: NAME, error: 'no refresh token' });
      const form = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: app.clientId, client_secret: app.clientSecret });
      const { body } = await platformFetch(config.GOOGLE_OAUTH_TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form },
        tokenOpts([app.clientSecret, refreshToken]));
      return tokenSet(body as Record<string, unknown>, refreshToken);
    },
    async revoke(_app, accessToken, refreshToken) {
      // Revoking the refresh token also invalidates its access tokens.
      await platformFetch(config.GOOGLE_OAUTH_REVOKE_URL, {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: refreshToken ?? accessToken }),
      }, { ...tokenOpts([accessToken, refreshToken ?? '']), retries429: 0 });
    },
  },

  async fetchOwnProfile(a) {
    const r = await api<{ items?: Channel[] }>(a, 'GET', 'channels', { part: 'snippet,statistics', mine: 'true' });
    const ch = r.items?.[0];
    if (!ch) throw platformError(400, 'no_channel', '该 Google 账号没有 YouTube 频道', { platform: NAME });
    const th = ch.snippet?.thumbnails ?? {};
    const avatar = th.high?.url ?? th.medium?.url ?? th.default?.url ?? null;
    return {
      externalAccountId: ch.id,
      name: ch.snippet?.title ?? null,
      handle: ch.snippet?.customUrl?.replace(/^@/, '') ?? null,
      avatarUrl: avatar?.startsWith('https://') ? avatar : null,
      followers: ch.statistics?.hiddenSubscriberCount ? null : num(ch.statistics?.subscriberCount),
      posts: num(ch.statistics?.videoCount),
      views: num(ch.statistics?.viewCount),
    };
  },

  /**
   * Counters from channels.list (subscribers, videos, lifetime views); per-day activity from the
   * YouTube Analytics API (reports, ids=channel==MINE, dimensions=day). Google reports days in
   * Pacific time with a delay of ~2 days, so recent days may be absent (they are filled by later runs).
   */
  async fetchAccountStats(a, days) {
    const r = await api<{ items?: Channel[] }>(a, 'GET', 'channels', { part: 'statistics', mine: 'true' });
    const ch = r.items?.[0];
    if (!ch) throw platformError(400, 'no_channel', '该 Google 账号没有 YouTube 频道', { platform: NAME });
    const activity = days.length ? await withOptionalScope(a, ANALYTICS_SCOPE, async () => {
      const q = new URLSearchParams({
        ids: 'channel==MINE', startDate: days[0]!, endDate: days[days.length - 1]!, metrics: ANALYTICS_METRICS.join(','), dimensions: 'day', sort: 'day',
      });
      const { body } = await platformFetch(`${config.YOUTUBE_ANALYTICS_BASE}/reports?${q}`, {
        headers: { authorization: `Bearer ${a.accessToken}`, accept: 'application/json' },
      }, { platform: NAME, secrets: [a.accessToken], signal: a.signal, limiterKey: a.connection.id, mapError: apiError });
      const rep = body as { columnHeaders?: { name?: string }[]; rows?: unknown[][] };
      const col = (n: string) => (rep.columnHeaders ?? []).findIndex((h) => h.name === n);
      const at = { day: col('day'), views: col('views'), likes: col('likes'), shares: col('shares'), comments: col('comments') };
      const cell = (row: unknown[], i: number) => (i < 0 ? null : num(row[i]));
      return (rep.rows ?? []).filter((row) => typeof row[at.day] === 'string').map((row) => ({
        day: String(row[at.day]), views: cell(row, at.views), likes: cell(row, at.likes), shares: cell(row, at.shares), comments: cell(row, at.comments),
      }));
    }) : [];
    const s = ch.statistics;
    return {
      followers: s?.hiddenSubscriberCount ? null : num(s?.subscriberCount), following: null, posts: num(s?.videoCount),
      totalViews: num(s?.viewCount), totalLikes: null,
      days: activity ?? [], missing: activity ? [] : [...ANALYTICS_METRICS], missingScopes: activity ? [] : [ANALYTICS_SCOPE],
    };
  },

  async publishUnavailableReason(input: PublishInput) {
    if (input.media.length !== 1 || input.media[0]!.fileType !== 'video') {
      return { code: 'platform.media_unsupported', message: 'YouTube 只能发布单个视频' };
    }
    return null;
  },

  async publish(a, input) {
    const asset = input.media[0]!;
    const meta = {
      snippet: {
        title: (input.title?.trim() || asset.name).slice(0, 100),
        description: (input.caption ?? '').slice(0, 5000),
        ...(input.tags?.length ? { tags: input.tags.slice(0, 50) } : {}),
      },
      status: { privacyStatus: input.privacy ?? 'private' },
    };
    const opts = { platform: NAME, secrets: [a.accessToken], signal: a.signal, limiterKey: a.connection.id, mapError: apiError };
    const init = await platformFetch(`${config.YOUTUBE_UPLOAD_BASE}/videos?${new URLSearchParams({ uploadType: 'resumable', part: 'snippet,status' })}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${a.accessToken}`, 'content-type': 'application/json; charset=UTF-8',
        'x-upload-content-length': String(asset.fileSize), 'x-upload-content-type': asset.mimeType,
      },
      body: JSON.stringify(meta),
    }, opts);
    const session = init.res.headers.get('location');
    if (!session) throw platformError(502, 'error', `${NAME} 未返回上传地址`, { platform: NAME, status: init.res.status, error: 'no upload session' });
    await a.log?.('upload session created', { bytes: asset.fileSize });

    const video = await withMediaFile(asset, async (file) => {
      const fd = await fs.promises.open(file, 'r');
      try {
        const total = asset.fileSize;
        let offset = 0;
        let failures = 0;
        for (;;) {
          a.signal?.throwIfAborted();
          const len = Math.min(CHUNK, total - offset);
          const chunk = await readChunk(fd, offset, len);
          if (offset + len === total) await a.commit?.(); // the video exists once the last byte arrives
          let r: { res: Response; body: unknown };
          try {
            r = await platformFetch(session, {
              method: 'PUT', redirect: 'manual', // 308 = Resume Incomplete here, not a redirect
              headers: { authorization: `Bearer ${a.accessToken}`, 'content-length': String(chunk.length), 'content-range': `bytes ${offset}-${offset + chunk.length - 1}/${total}` },
              body: chunk,
            }, { ...opts, okStatuses: [308], timeoutMs: 5 * 60_000 });
          } catch (err) {
            const code = (err as HttpError).code;
            if (++failures > 3 || (code !== 'platform.unreachable' && code !== 'platform.error')) throw err;
            // Ask the session how much it has, then resume from there.
            r = await platformFetch(session, { method: 'PUT', redirect: 'manual', headers: { authorization: `Bearer ${a.accessToken}`, 'content-range': `bytes */${total}` } },
              { ...opts, okStatuses: [308] });
          }
          if (r.res.status !== 308) return r.body as { id?: string; status?: { uploadStatus?: string; rejectionReason?: string; failureReason?: string } };
          const range = r.res.headers.get('range'); // "bytes=0-N"
          offset = range ? Number(range.split('-')[1]) + 1 : 0;
          await a.log?.('upload progress', { uploaded: offset, total });
        }
      } finally { await fd.close(); }
    });
    if (!video.id) throw platformError(502, 'error', `${NAME} 上传完成但未返回视频 ID`, { platform: NAME, status: 200, error: 'no video id' });
    if (video.status?.uploadStatus === 'rejected' || video.status?.uploadStatus === 'failed') {
      const why = video.status.rejectionReason ?? video.status.failureReason ?? video.status.uploadStatus;
      throw platformError(400, 'media_rejected', `${NAME} 拒绝了该视频：${why}`, { platform: NAME, error: why });
    }
    return { externalId: video.id, url: `https://www.youtube.com/watch?v=${encodeURIComponent(video.id)}`, state: 'published' };
  },

  /** Cursor = page token (newest threads first); comment ids are stable, so callers dedupe by id. */
  async listComments(a, cursor) {
    const channelId = a.connection.externalAccountId;
    if (!channelId) throw platformError(400, 'no_channel', '该 Google 账号没有 YouTube 频道', { platform: NAME });
    const r = await api<ThreadList>(a, 'GET', 'commentThreads', {
      part: 'snippet,replies', allThreadsRelatedToChannelId: channelId, maxResults: '100', order: 'time', textFormat: 'plainText',
      ...(cursor ? { pageToken: cursor } : {}),
    });
    const out: PlatformComment[] = [];
    const conv = (id: string, s: CommentSnippet | undefined, parentId: string | null, videoId: string | null, replies: number | null): PlatformComment => ({
      id, parentId, postId: s?.videoId ?? videoId, authorName: s?.authorDisplayName ?? null, text: s?.textOriginal ?? s?.textDisplay ?? '',
      publishedAt: s?.publishedAt ?? null, likeCount: num(s?.likeCount), replyCount: replies,
    });
    for (const t of r.items ?? []) {
      const top = t.snippet?.topLevelComment;
      if (top) out.push(conv(top.id, top.snippet, null, t.snippet?.videoId ?? null, num(t.snippet?.totalReplyCount)));
      for (const c of t.replies?.comments ?? []) out.push(conv(c.id, c.snippet, c.snippet?.parentId ?? top?.id ?? null, t.snippet?.videoId ?? null, null));
    }
    return { comments: out, nextCursor: r.nextPageToken ?? null };
  },

  async replyToComment(a, commentId, text) {
    // Replies go to the thread's top-level comment (reply ids are "<parent>.<reply>").
    const parentId = commentId.split('.')[0]!;
    const r = await api<{ id?: string }>(a, 'POST', 'comments', { part: 'snippet' }, { snippet: { parentId, textOriginal: text } });
    if (!r.id) throw platformError(502, 'error', `${NAME} 未返回回复 ID`, { platform: NAME, status: 200, error: 'no comment id' });
    return { id: r.id };
  },
};
