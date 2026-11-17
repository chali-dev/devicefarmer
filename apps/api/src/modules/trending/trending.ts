import { and, desc, eq, lt, sql } from 'drizzle-orm';
import { db, schema } from '../../db/index.js';
import { HttpError } from '../../lib/errors.js';
import { registerDashboardWidget } from '../dashboard/registry.js';
import { createTask, registerTaskHandler } from '../tasks/core.js';
import { call as youtubeGet, youtubeSource } from '../tracked/youtube.js';

/**
 * 趋势热点 (trending topics). MVP source: YouTube Data API v3 `videos.list?chart=mostPopular` per region
 * (optional category), with the same write-only API key as tracked accounts (settings key `youtube`).
 * Official API only; metadata and links are stored, never media. Quota: 1 unit per region per refresh.
 *
 * Settings (key `trending`, admin): regions, category, interval (slot width), max results, retention.
 * One device-less `trending-refresh` task per region and slot (idempotency key `<region>:<category>:<slot>`),
 * created by the hourly collection tick; a manual refresh replaces the snapshot of the current slot.
 */
const KEY = 'trending';
export const TRENDING_TYPE = 'trending-refresh';
export const REF_TYPE = 'trending';
const HOUR = 3600_000;

export interface TrendingSettings {
  /** ISO 3166-1 alpha-2, uppercase. Empty = nothing is collected. */
  regions: string[];
  /** YouTube video category id; null = all. */
  categoryId: string | null;
  intervalHours: number;
  maxResults: number;
  retentionDays: number;
}
export const TRENDING_DEFAULTS: TrendingSettings = { regions: [], categoryId: null, intervalHours: 24, maxResults: 50, retentionDays: 30 };

export async function getTrendingSettings(): Promise<TrendingSettings & { updatedAt: string | null }> {
  const [row] = await db.select().from(schema.settings).where(eq(schema.settings.key, KEY));
  return { ...TRENDING_DEFAULTS, ...(row?.value as Partial<TrendingSettings> | undefined), updatedAt: row?.updatedAt.toISOString() ?? null };
}

export async function saveTrendingSettings(v: TrendingSettings) {
  const value = { ...v, regions: [...new Set(v.regions.map((r) => r.toUpperCase()))] };
  await db.insert(schema.settings).values({ key: KEY, value })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value, updatedAt: new Date() } });
  return getTrendingSettings();
}

/** Start of the slot containing `at` (UTC, `hours` wide). */
export const slotOf = (at: Date, hours: number) => new Date(Math.floor(at.getTime() / (hours * HOUR)) * hours * HOUR);

const num = (v: unknown): number | null => (v === undefined || v === null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));

interface Video {
  id: string;
  snippet?: { title?: string; channelId?: string; channelTitle?: string; categoryId?: string; publishedAt?: string; tags?: string[] };
  statistics?: { viewCount?: string; likeCount?: string; commentCount?: string };
}

/** Fetches the chart and stores it as the snapshot of `slot` (replacing an existing one of the same slot). */
export async function refreshTrending(region: string, categoryId: string | null, slot: Date, taskId: string | null) {
  const r = await youtubeGet<{ items?: Video[] }>('videos', {
    part: 'snippet,statistics', chart: 'mostPopular', regionCode: region,
    maxResults: String((await getTrendingSettings()).maxResults), ...(categoryId ? { videoCategoryId: categoryId } : {}),
  });
  const items = (r.items ?? []).filter((v) => v.id);
  const S = schema.trendingSnapshots;
  const cat = categoryId ?? '';
  return db.transaction(async (tx) => {
    await tx.delete(S).where(and(eq(S.source, 'youtube'), eq(S.region, region), eq(S.categoryId, cat), eq(S.slotAt, slot)));
    const [snap] = await tx.insert(S).values({ source: 'youtube', region, categoryId: cat, slotAt: slot, itemCount: items.length, taskId }).returning();
    if (items.length) {
      await tx.insert(schema.trendingItems).values(items.map((v, i) => ({
        snapshotId: snap!.id, rank: i + 1, videoId: v.id,
        title: v.snippet?.title?.slice(0, 500) ?? null, channelId: v.snippet?.channelId ?? null, channelTitle: v.snippet?.channelTitle?.slice(0, 200) ?? null,
        categoryId: v.snippet?.categoryId ?? null, views: num(v.statistics?.viewCount), likes: num(v.statistics?.likeCount), comments: num(v.statistics?.commentCount),
        publishedAt: v.snippet?.publishedAt ? new Date(v.snippet.publishedAt) : null,
        tags: (v.snippet?.tags ?? []).slice(0, 30).map((x) => x.slice(0, 100)),
      })));
    }
    return { snapshotId: snap!.id, region, categoryId, slot: slot.toISOString(), items: items.length };
  });
}

registerTaskHandler<{ region: string; categoryId: string | null; slot?: string }>(TRENDING_TYPE, {
  queue: 'task-ops',
  timeoutMs: 2 * 60_000,
  // Like tracked refresh: a failed official-API call (quota, bad key) is not helped by an automatic retry.
  maxAttempts: 1,
  async run(ctx) {
    const { region, categoryId } = ctx.payload;
    const slot = ctx.payload.slot ? new Date(ctx.payload.slot) : slotOf(new Date(), (await getTrendingSettings()).intervalHours);
    const r = await refreshTrending(region, categoryId ?? null, slot, ctx.task.id);
    await ctx.log('info', `stored ${r.items} trending videos for ${region}`, r);
    return r;
  },
});

const label = (region: string, categoryId: string | null) => `YouTube ${region}${categoryId ? ` #${categoryId}` : ''}`;

/** Scheduled: one task per region per slot (idempotent). Skips with a code when nothing is configured. */
export async function scheduleTrending(now = new Date()): Promise<{ queued: number; duplicate: number; skipped?: string }> {
  const s = await getTrendingSettings();
  if (!s.regions.length) return { queued: 0, duplicate: 0, skipped: 'trending.no_regions' };
  if (!(await youtubeSource.isConfigured())) return { queued: 0, duplicate: 0, skipped: 'tracked.youtube_no_api_key' };
  const slot = slotOf(now, s.intervalHours);
  let queued = 0; let duplicate = 0;
  for (const region of s.regions) {
    const { created } = await createTask({
      type: TRENDING_TYPE, label: label(region, s.categoryId), refType: REF_TYPE,
      payload: { region, categoryId: s.categoryId, slot: slot.toISOString() },
      idempotencyKey: `${region}:${s.categoryId ?? ''}:${slot.toISOString()}`,
    });
    if (created) queued++; else duplicate++;
  }
  return { queued, duplicate };
}

/** Admin "refresh now": refreshes the current slot of every configured region. */
export async function refreshTrendingNow(userId: string): Promise<string[]> {
  const s = await getTrendingSettings();
  if (!s.regions.length) throw new HttpError(400, '未配置趋势热点地区', 'trending.no_regions');
  await youtubeSource.requireConfigured();
  const ids: string[] = [];
  for (const region of s.regions) {
    const { task } = await createTask({ type: TRENDING_TYPE, userId, label: label(region, s.categoryId), refType: REF_TYPE, payload: { region, categoryId: s.categoryId } });
    ids.push(task.id);
  }
  return ids;
}

/** Retention: deletes snapshots (items cascade) captured more than `retentionDays` ago. */
export async function purgeTrending(now = new Date()): Promise<number> {
  const { retentionDays } = await getTrendingSettings();
  const cutoff = new Date(now.getTime() - retentionDays * 24 * HOUR);
  const del = await db.delete(schema.trendingSnapshots).where(lt(schema.trendingSnapshots.capturedAt, cutoff)).returning({ id: schema.trendingSnapshots.id });
  return del.length;
}

/** Latest snapshot per (region, category) with its capture time (overview + dashboard). */
export async function latestSnapshots() {
  const S = schema.trendingSnapshots;
  return db.selectDistinctOn([S.region, S.categoryId]).from(S).orderBy(S.region, S.categoryId, desc(S.slotAt), desc(S.capturedAt));
}

/**
 * Items of one snapshot with the rank change vs. the previous snapshot of the same region/category:
 * `rankChange` > 0 = moved up, null + `isNew` = not in the previous chart (isNew false when there is no previous one).
 */
export async function snapshotItems(snap: typeof schema.trendingSnapshots.$inferSelect, q?: string) {
  const S = schema.trendingSnapshots; const I = schema.trendingItems;
  const [prev] = await db.select().from(S)
    .where(and(eq(S.source, snap.source), eq(S.region, snap.region), eq(S.categoryId, snap.categoryId), lt(S.slotAt, snap.slotAt)))
    .orderBy(desc(S.slotAt)).limit(1);
  const like = q ? `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
  const [items, prevItems] = await Promise.all([
    db.select().from(I).where(and(eq(I.snapshotId, snap.id), like
      ? sql`(${I.title} ilike ${like} or ${I.channelTitle} ilike ${like} or exists (select 1 from unnest(${I.tags}) t where t ilike ${like}))` : undefined))
      .orderBy(I.rank),
    prev ? db.select({ videoId: I.videoId, rank: I.rank }).from(I).where(eq(I.snapshotId, prev.id)) : [],
  ]);
  const prevRanks = new Map(prevItems.map((p) => [p.videoId, p.rank]));
  return {
    previous: prev ? { id: prev.id, capturedAt: prev.capturedAt.toISOString(), slotAt: prev.slotAt.toISOString() } : null,
    items: items.map((item) => ({
      ...item,
      url: `https://www.youtube.com/watch?v=${encodeURIComponent(item.videoId)}`,
      channelUrl: item.channelId ? `https://www.youtube.com/channel/${encodeURIComponent(item.channelId)}` : null,
      prevRank: prevRanks.get(item.videoId) ?? null,
      rankChange: prevRanks.has(item.videoId) ? prevRanks.get(item.videoId)! - item.rank : null,
      isNew: Boolean(prev) && !prevRanks.has(item.videoId),
    })),
  };
}

/** Public chart data, same for every user: regions collected, latest capture and the top 5 of the newest one. */
registerDashboardWidget('trending', async () => {
  const latest = (await latestSnapshots()).sort((a, b) => b.capturedAt.getTime() - a.capturedAt.getTime());
  if (!latest.length) return null;
  const top = await db.select({ rank: schema.trendingItems.rank, title: schema.trendingItems.title, videoId: schema.trendingItems.videoId, views: schema.trendingItems.views })
    .from(schema.trendingItems).where(eq(schema.trendingItems.snapshotId, latest[0]!.id)).orderBy(schema.trendingItems.rank).limit(5);
  return {
    regions: [...new Set(latest.map((s) => s.region))].sort(),
    region: latest[0]!.region,
    capturedAt: latest[0]!.capturedAt.toISOString(),
    top: top.map((t) => ({ ...t, url: `https://www.youtube.com/watch?v=${encodeURIComponent(t.videoId)}` })),
  };
}, { order: 75 });
