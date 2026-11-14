import { eq } from 'drizzle-orm';
import { config } from '../../config.js';
import { db, schema } from '../../db/index.js';
import { HttpError } from '../../lib/errors.js';
import { openSecret, sealSecret } from '../../lib/secret-box.js';
import type { PostData, ProfileData, TrackedSource } from './platforms.js';

/**
 * YouTube Data API v3 client (official API, API key auth) for tracked accounts.
 * Quota cost per refresh: channels.list 1 + playlistItems.list 1 + videos.list 1 unit.
 *
 * The API key is stored encrypted (secret-box) under settings key "youtube" and is write-only:
 * the API only ever reports whether it is set. It is sent to Google as the `key` query parameter
 * and never logged or included in error messages.
 */
const KEY = 'youtube';
interface StoredYoutube { apiKeyEnc?: string }

async function load(): Promise<StoredYoutube> {
  const [row] = await db.select().from(schema.settings).where(eq(schema.settings.key, KEY));
  return (row?.value as StoredYoutube | undefined) ?? {};
}

export async function getYoutubeSettings(): Promise<{ apiKeySet: boolean; updatedAt: Date | null }> {
  const [row] = await db.select().from(schema.settings).where(eq(schema.settings.key, KEY));
  return { apiKeySet: Boolean((row?.value as StoredYoutube | undefined)?.apiKeyEnc), updatedAt: row?.updatedAt ?? null };
}

/** `null` clears the key. */
export async function saveYoutubeApiKey(apiKey: string | null) {
  const value: StoredYoutube = apiKey ? { apiKeyEnc: sealSecret(apiKey) } : {};
  await db.insert(schema.settings).values({ key: KEY, value })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value, updatedAt: new Date() } });
  return getYoutubeSettings();
}

async function apiKey(): Promise<string> {
  const s = await load();
  if (!s.apiKeyEnc) throw new HttpError(400, '未配置 YouTube Data API 密钥（管理员可在追踪账号页设置）', 'tracked.youtube_no_api_key');
  return openSecret(s.apiKeyEnc);
}

/** Google API error body (shared with the OAuth YouTube adapter in modules/platforms). */
export interface GoogleApiErrorBody { error?: { code?: number; message?: string; status?: string; errors?: { reason?: string }[] } }
export const googleErrorReasons = (body: unknown): string[] => ((body as GoogleApiErrorBody | null)?.error?.errors ?? []).map((e) => e.reason ?? '');
export const GOOGLE_QUOTA_REASONS = new Set(['quotaExceeded', 'dailyLimitExceeded', 'rateLimitExceeded', 'userRateLimitExceeded']);

/** GET {base}/{resource}?…&key=… with coded errors. The key never appears in thrown messages. */
async function call<T>(resource: string, params: Record<string, string>): Promise<T> {
  const key = await apiKey();
  const qs = new URLSearchParams({ ...params, key });
  let res: Response;
  try {
    res = await fetch(`${config.YOUTUBE_API_BASE}/${resource}?${qs}`, { signal: AbortSignal.timeout(15_000), headers: { accept: 'application/json' } });
  } catch (err) {
    throw new HttpError(502, `YouTube API 无法访问：${(err as Error).name}`, 'tracked.youtube_unreachable', { error: (err as Error).name });
  }
  const body = await res.json().catch(() => ({})) as T & GoogleApiErrorBody;
  if (res.ok) return body;
  const reasons = googleErrorReasons(body);
  const msg = (body.error?.message ?? res.statusText).replace(key, '***').slice(0, 200);
  if (reasons.some((r) => GOOGLE_QUOTA_REASONS.has(r))) {
    throw new HttpError(429, 'YouTube API 配额已用尽，请稍后再试', 'tracked.youtube_quota');
  }
  if (reasons.includes('keyInvalid') || /API key not valid/i.test(msg)) throw new HttpError(400, 'YouTube API 密钥无效', 'tracked.youtube_key_invalid');
  if (res.status === 403) throw new HttpError(403, `YouTube API 拒绝访问：${msg}`, 'tracked.youtube_forbidden', { error: msg });
  if (res.status === 404) throw new HttpError(404, 'YouTube 频道不存在', 'tracked.youtube_not_found');
  throw new HttpError(502, `YouTube API 错误 ${res.status}：${msg}`, 'tracked.youtube_error', { status: res.status, error: msg });
}

const num = (v: unknown): number | null => (v === undefined || v === null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));

interface Channel {
  id: string;
  snippet?: { title?: string; description?: string; customUrl?: string; thumbnails?: Record<string, { url?: string }> };
  statistics?: { subscriberCount?: string; hiddenSubscriberCount?: boolean; videoCount?: string; viewCount?: string };
  contentDetails?: { relatedPlaylists?: { uploads?: string } };
}

export const youtubeSource: TrackedSource = {
  capabilities: { profile: true, recentPosts: true, metrics: ['followers', 'posts', 'views'] },
  isConfigured: async () => Boolean((await load()).apiKeyEnc),
  requireConfigured: async () => { await apiKey(); },

  async fetchProfile(account) {
    const by: Record<string, string> = account.externalId ? { id: account.externalId } : { forHandle: `@${account.handle}` };
    const r = await call<{ items?: Channel[] }>('channels', { part: 'snippet,statistics,contentDetails', ...by, maxResults: '1' });
    const ch = r.items?.[0];
    if (!ch) throw new HttpError(404, 'YouTube 频道不存在', 'tracked.youtube_not_found');
    const uploads = ch.contentDetails?.relatedPlaylists?.uploads;
    const th = ch.snippet?.thumbnails ?? {};
    const avatar = th.high?.url ?? th.medium?.url ?? th.default?.url ?? null;
    return {
      externalId: ch.id,
      displayName: ch.snippet?.title ?? null,
      avatarUrl: avatar && avatar.startsWith('https://') ? avatar : null,
      bio: ch.snippet?.description ? ch.snippet.description.slice(0, 2000) : null,
      followers: ch.statistics?.hiddenSubscriberCount ? null : num(ch.statistics?.subscriberCount),
      following: null,
      posts: num(ch.statistics?.videoCount),
      views: num(ch.statistics?.viewCount),
      meta: uploads ? { uploads } : undefined,
    } satisfies ProfileData;
  },

  async fetchRecentPosts(_account, profile, limit) {
    // The uploads playlist id is "UU" + the channel id suffix; prefer what the API returned.
    const playlistId = profile.meta?.uploads ?? profile.externalId.replace(/^UC/, 'UU');
    const items = await call<{ items?: { contentDetails?: { videoId?: string; videoPublishedAt?: string }; snippet?: { title?: string } }[] }>(
      'playlistItems', { part: 'snippet,contentDetails', playlistId, maxResults: String(Math.min(limit, 50)) },
    ).catch((err: HttpError) => {
      // A channel without uploads has no uploads playlist (404): no posts, not an error.
      if (err.code === 'tracked.youtube_not_found') return { items: [] };
      throw err;
    });
    const ids = (items.items ?? []).map((i) => i.contentDetails?.videoId).filter((v): v is string => Boolean(v));
    if (!ids.length) return [];
    const videos = await call<{ items?: { id: string; snippet?: { title?: string; publishedAt?: string }; statistics?: { viewCount?: string; likeCount?: string; commentCount?: string } }[] }>(
      'videos', { part: 'snippet,statistics', id: ids.join(','), maxResults: String(ids.length) },
    );
    const byId = new Map((videos.items ?? []).map((v) => [v.id, v]));
    return ids.map((id): PostData => {
      const v = byId.get(id);
      const pl = items.items!.find((i) => i.contentDetails?.videoId === id);
      const published = v?.snippet?.publishedAt ?? pl?.contentDetails?.videoPublishedAt;
      return {
        externalId: id,
        url: `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`,
        title: (v?.snippet?.title ?? pl?.snippet?.title ?? null)?.slice(0, 500) ?? null,
        publishedAt: published ? new Date(published) : null,
        views: num(v?.statistics?.viewCount),
        likes: num(v?.statistics?.likeCount),
        comments: num(v?.statistics?.commentCount),
      };
    });
  },
};
