/**
 * Seeding helpers for check/demo scripts: the API has no way to write 账号分析 data any more (official APIs
 * removed 2026-11-18, manual entry before), so scripts that need historical rows insert them here directly,
 * in the shape the removed writers stored (social_account_stats per account + UTC day, social_account_posts).
 */
import { sql } from 'drizzle-orm';
import { db, schema } from '../../src/db/index.js';

export type StatValues = Partial<Record<'followers' | 'following' | 'posts' | 'totalViews' | 'totalLikes' | 'views' | 'likes' | 'shares' | 'comments', number | null>>;

/** Sets the given values of one account-day (other columns keep what the row had). Idempotent. */
export async function seedStatsDay(accountId: string, day: string, values: StatValues, source: 'api' | 'manual' = 'manual', opts: { missing?: string[] } = {}) {
  const st = schema.socialAccountStats;
  const set: Record<string, unknown> = { source, capturedAt: sql`excluded.captured_at`, ...values };
  if (opts.missing) set.missing = opts.missing;
  const [row] = await db.insert(st).values({ socialAccountId: accountId, day, source, capturedAt: new Date(), missing: opts.missing ?? [], ...values })
    .onConflictDoUpdate({ target: [st.socialAccountId, st.day], set }).returning();
  return row!;
}

export interface SeedPost {
  id: string; mediaType?: string | null; productType?: string | null; caption?: string | null; permalink?: string | null;
  publishedAt?: string | null; likes?: number | null; comments?: number | null;
}

/** Inserts / updates own posts of an account (unique account + external id). Returns how many were new. */
export async function seedOwnPosts(accountId: string, platform: string, posts: SeedPost[], now = new Date()): Promise<{ inserted: number; updated: number }> {
  const sp = schema.socialAccountPosts;
  let inserted = 0; let updated = 0;
  for (const p of posts) {
    const v = {
      mediaType: p.mediaType ?? null, productType: p.productType ?? null, caption: p.caption ?? null, permalink: p.permalink ?? null,
      publishedAt: p.publishedAt ? new Date(p.publishedAt) : null, likes: p.likes ?? null, comments: p.comments ?? null, fetchedAt: now,
    };
    const [row] = await db.insert(sp).values({ socialAccountId: accountId, platform, externalId: p.id, firstSeenAt: now, ...v })
      .onConflictDoUpdate({ target: [sp.socialAccountId, sp.externalId], set: v }).returning({ inserted: sql<boolean>`xmax = 0` });
    if (row?.inserted) inserted++; else updated++;
  }
  return { inserted, updated };
}
