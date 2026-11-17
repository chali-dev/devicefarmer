import { and, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { db, schema } from '../../db/index.js';
import type { TrackedAccount } from '../../db/schema.js';
import { HttpError, notFound } from '../../lib/errors.js';
import { isAdmin, type AuthUser } from '../auth/rbac.js';
import { PLATFORMS, platformDef, registerSource, type PostData } from './platforms.js';
import { youtubeSource } from './youtube.js';
import { registerTaskHandler } from '../tasks/core.js';

/**
 * Tracked accounts (追踪账号): service layer. Rows are private to their owner (`user_id`);
 * admins see all. Others get 404 so the existence of a row is not leaked.
 */
registerSource('youtube', youtubeSource);

const ta = schema.trackedAccounts;
const ts = schema.trackedAccountSnapshots;
const tp = schema.trackedPosts;

export const REF_TYPE = 'tracked_account';
/** Recent posts requested per API refresh. */
const RECENT_POSTS = 20;

/** Readable label (task centre, audit). */
export const display = (a: Pick<TrackedAccount, 'platform' | 'handle'>) => `${platformDef(a.platform).label} ${/^UC[A-Za-z0-9_-]{22}$/.test(a.handle) ? a.handle : `@${a.handle}`}`;

export async function getVisibleAccount(user: AuthUser, id: string): Promise<TrackedAccount> {
  const [row] = await db.select().from(ta).where(eq(ta.id, id));
  if (!row || (row.userId !== user.id && !isAdmin(user))) throw notFound('追踪账号不存在', 'tracked.not_found');
  return row;
}

/** How data reaches this account: an official API (configured or not), or manual entry only. */
export type DataMode = 'api' | 'api_unconfigured' | 'manual_only';
export async function dataModes(): Promise<Map<string, DataMode>> {
  const out = new Map<string, DataMode>();
  for (const { id } of PLATFORMS) {
    const src = platformDef(id).source;
    out.set(id, !src ? 'manual_only' : (await src.isConfigured()) ? 'api' : 'api_unconfigured');
  }
  return out;
}

export interface LatestStats {
  capturedAt: string; source: 'api' | 'manual';
  followers: number | null; following: number | null; posts: number | null; views: number | null;
}

/** Shapes rows for clients: owner name, latest snapshot, follower delta vs. the previous snapshot, last refresh task. */
export async function toPublicAccounts(rows: TrackedAccount[]) {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const [latestRows, followerRows, taskRows, owners, modes] = await Promise.all([
    db.selectDistinctOn([ts.trackedAccountId]).from(ts).where(inArray(ts.trackedAccountId, ids)).orderBy(ts.trackedAccountId, desc(ts.capturedAt), desc(ts.id)),
    db.execute<{ id: string; followers: number; captured_at: string; rn: number }>(sql`
      select tracked_account_id as id, followers::float8 as followers, captured_at, rn from (
        select tracked_account_id, followers, captured_at,
          row_number() over (partition by tracked_account_id order by captured_at desc, id desc) as rn
        from tracked_account_snapshots
        where tracked_account_id in (${sql.join(ids.map((i) => sql`${i}::uuid`), sql`, `)}) and followers is not null
      ) x where rn <= 2`),
    db.selectDistinctOn([schema.tasks.refId], {
      refId: schema.tasks.refId, id: schema.tasks.id, status: schema.tasks.status, error: schema.tasks.error,
      createdAt: schema.tasks.createdAt, finishedAt: schema.tasks.finishedAt,
    }).from(schema.tasks).where(and(eq(schema.tasks.refType, REF_TYPE), inArray(schema.tasks.refId, ids)))
      .orderBy(schema.tasks.refId, desc(schema.tasks.createdAt)),
    db.select({ id: schema.users.id, username: schema.users.username }).from(schema.users)
      .where(inArray(schema.users.id, [...new Set(rows.map((r) => r.userId))])),
    dataModes(),
  ]);
  const latest = new Map(latestRows.map((s) => [s.trackedAccountId, s]));
  const fol = new Map<string, { cur?: number; prev?: number; prevAt?: string }>();
  for (const f of followerRows) {
    const e = fol.get(f.id) ?? {};
    if (Number(f.rn) === 1) e.cur = Number(f.followers);
    else { e.prev = Number(f.followers); e.prevAt = new Date(f.captured_at).toISOString(); }
    fol.set(f.id, e);
  }
  const tasks = new Map(taskRows.map((t) => [t.refId, t]));
  return rows.map((r) => {
    const s = latest.get(r.id);
    const f = fol.get(r.id);
    const { refId: _r, ...task } = tasks.get(r.id) ?? { refId: null };
    return {
      ...r,
      ownerName: owners.find((o) => o.id === r.userId)?.username ?? null,
      dataMode: modes.get(r.platform) ?? 'manual_only',
      latest: s ? {
        capturedAt: s.capturedAt.toISOString(), source: s.source,
        followers: s.followers, following: s.following, posts: s.posts, views: s.views,
      } satisfies LatestStats : null,
      followers: f?.cur ?? null,
      followersDelta: f?.cur !== undefined && f.prev !== undefined ? f.cur - f.prev : null,
      followersPrevAt: f?.prevAt ?? null,
      lastRefresh: 'id' in task ? task : null,
    };
  });
}

/**
 * Inserts or updates posts by (account, external id). Known values are kept when the new data
 * lacks them; first_seen_at stays, last_seen_at moves. Returns how many were new.
 */
export async function upsertPosts(
  exec: Pick<typeof db, 'insert'>, accountId: string, posts: PostData[], source: 'api' | 'manual', seenAt = new Date(),
): Promise<{ inserted: number; updated: number; ids: string[] }> {
  if (!posts.length) return { inserted: 0, updated: 0, ids: [] };
  const keep = (name: string) => sql.raw(`coalesce(excluded.${name}, tracked_posts.${name})`);
  const rows = await exec.insert(tp).values(posts.map((p) => ({
    trackedAccountId: accountId, externalId: p.externalId, url: p.url, title: p.title, publishedAt: p.publishedAt,
    views: p.views, likes: p.likes, comments: p.comments, source, firstSeenAt: seenAt, lastSeenAt: seenAt,
  }))).onConflictDoUpdate({
    target: [tp.trackedAccountId, tp.externalId],
    set: {
      url: keep('url'), title: keep('title'), publishedAt: keep('published_at'),
      views: keep('views'), likes: keep('likes'), comments: keep('comments'),
      source: sql.raw('excluded.source'), lastSeenAt: sql.raw('excluded.last_seen_at'),
    },
  }).returning({ id: tp.id, inserted: sql<boolean>`(xmax = 0)` });
  const inserted = rows.filter((r) => r.inserted).length;
  return { inserted, updated: rows.length - inserted, ids: rows.map((r) => r.id) };
}

export type RefreshOutcome =
  | { outcome: 'refreshed'; newPosts: number; posts: number }
  | { outcome: 'manual_only' }
  | { outcome: 'gone' };

/**
 * Refreshes one tracked account from its platform's official API: profile, a snapshot of the
 * counters and recent posts. Platforms without an API source are "manual only" (no change, no
 * error). On failure the account is marked `error` (paused stays paused) with a coded message,
 * and the error is rethrown so the task fails. Kept self-contained so a scheduler can call it.
 */
export async function refreshTrackedAccount(id: string): Promise<RefreshOutcome> {
  const [acc] = await db.select().from(ta).where(eq(ta.id, id));
  if (!acc) return { outcome: 'gone' };
  const source = platformDef(acc.platform).source;
  if (!source) return { outcome: 'manual_only' };
  const now = new Date();
  try {
    const profile = await source.fetchProfile(acc);
    const posts = source.capabilities.recentPosts ? await source.fetchRecentPosts(acc, profile, RECENT_POSTS) : [];
    let newPosts = 0;
    await db.transaction(async (tx) => {
      await tx.update(ta).set({
        externalId: profile.externalId,
        displayName: profile.displayName ?? acc.displayName,
        avatarUrl: profile.avatarUrl ?? acc.avatarUrl,
        bio: profile.bio ?? acc.bio,
        status: acc.status === 'error' ? 'active' : acc.status,
        lastCheckedAt: now, lastSource: 'api', lastError: null, lastErrorCode: null,
      }).where(eq(ta.id, acc.id));
      await tx.insert(ts).values({
        trackedAccountId: acc.id, capturedAt: now, source: 'api',
        followers: profile.followers, following: profile.following, posts: profile.posts, views: profile.views,
      });
      newPosts = (await upsertPosts(tx, acc.id, posts, 'api', now)).inserted;
    });
    return { outcome: 'refreshed', newPosts, posts: posts.length };
  } catch (err) {
    const e = err as Error & { code?: string };
    await db.update(ta).set({
      status: acc.status === 'paused' ? 'paused' : 'error',
      lastError: e.message.slice(0, 500), lastErrorCode: err instanceof HttpError ? e.code ?? null : null, lastCheckedAt: now,
    }).where(eq(ta.id, acc.id)).catch(() => undefined);
    throw err;
  }
}

/** Refresh tasks of these accounts that have not finished yet. */
export async function pendingRefreshes(ids: string[]): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const rows = await db.select({ refId: schema.tasks.refId }).from(schema.tasks).where(and(
    eq(schema.tasks.refType, REF_TYPE), inArray(schema.tasks.refId, ids), inArray(schema.tasks.status, ['pending', 'scheduled', 'running']), isNotNull(schema.tasks.refId),
  ));
  return new Set(rows.map((r) => r.refId!));
}

/**
 * Why an account can't be refreshed now, as an error code; null = OK. Manual-only accounts are fine here
 * (a manual refresh is a no-op task); the scheduler skips them separately. Shared by manual refresh and the scheduler.
 */
export async function refreshRefusal(acc: TrackedAccount, busy: Set<string>): Promise<{ code: string; message: string; status: number } | null> {
  if (acc.status === 'paused') return { code: 'tracked.paused', message: '账号已暂停追踪', status: 409 };
  if (busy.has(acc.id)) return { code: 'tracked.refresh_in_progress', message: '该账号正在刷新', status: 409 };
  const src = platformDef(acc.platform).source;
  if (src) {
    try { await src.requireConfigured(); } catch (err) {
      const e = err as Error & { code?: string; statusCode?: number };
      return { code: e.code ?? 'tracked.api_not_configured', message: e.message, status: e.statusCode ?? 400 };
    }
  }
  return null;
}

// Device-less job on the unified task core. One attempt: a failed official-API call (quota, bad key)
// is not helped by an automatic retry; the user can retry from the task centre.
// A scheduled run (payload.scheduled) re-checks the account when it starts: paused, schedule switched off or
// the API unconfigured since it was queued → a skipped no-op instead of an API call.
registerTaskHandler<{ trackedAccountId: string; scheduled?: boolean }>('tracked-refresh', {
  queue: 'task-ops',
  timeoutMs: 5 * 60_000,
  maxAttempts: 1,
  async run(ctx) {
    const id = ctx.payload.trackedAccountId ?? ctx.task.refId!;
    if (ctx.payload.scheduled) {
      const [acc] = await db.select().from(ta).where(eq(ta.id, id));
      const code = !acc ? null : acc.refreshIntervalHours === null ? 'tracked.schedule_off' : (await refreshRefusal(acc, new Set()))?.code;
      if (code) {
        await ctx.log('info', `scheduled refresh skipped: ${code}`, { code });
        return { outcome: 'skipped', code };
      }
    }
    return refreshTrackedAccount(id);
  },
});
