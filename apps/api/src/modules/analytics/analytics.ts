import { sql, type SQL } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { counterDeltas } from '../../lib/counter-deltas.js';
import { registerDashboardWidget } from '../dashboard/registry.js';

/**
 * Account analytics (账号分析) of the operator's OWN social accounts: daily stats rows
 * (`social_account_stats`, one per account and UTC day) and own posts (`social_account_posts`).
 * Read only here. The writer is the automatic account check on the account's cloud phone (social/check.ts:
 * followers/following/posts of today's row, source `device`, `approx` = abbreviated by the app); the
 * official-API task `account-stats` and manual entry were removed on 2026-11-18, their rows stay readable.
 * RBAC = social accounts: users see their own accounts, admins all.
 */
export const MAX_RANGE_DAYS = 90;
const DAY_MS = 86_400_000;

export const utcDay = (d: Date) => d.toISOString().slice(0, 10);
/** `n` UTC days ending with `to`, oldest first. */
export function dayRange(to: string, n: number): string[] {
  const end = Date.parse(`${to}T00:00:00Z`);
  return Array.from({ length: n }, (_, i) => utcDay(new Date(end - (n - 1 - i) * DAY_MS)));
}


export const POST_SORTS = ['published', 'likes', 'comments'] as const;
/**
 * Stored own posts of one account (newest first, or by likes/comments), with the publish task that
 * published it when one matches (same account + external id, status published).
 */
export async function accountPosts(accountId: string, o: { limit: number; offset: number; sort: typeof POST_SORTS[number] }) {
  const order = o.sort === 'likes' ? sql`p.likes desc nulls last, p.published_at desc nulls last`
    : o.sort === 'comments' ? sql`p.comments desc nulls last, p.published_at desc nulls last` : sql`p.published_at desc nulls last, p.first_seen_at desc`;
  const [rows, [agg]] = await Promise.all([
    db.execute<Record<string, unknown>>(sql`
      select p.id, p.external_id, p.media_type, p.product_type, p.caption, p.permalink, p.published_at, p.likes, p.comments,
        p.first_seen_at, p.fetched_at, pt.id as publish_task_id, pt.content_id, pt.title as publish_title
      from social_account_posts p
      left join lateral (select x.id, x.content_id, x.title from publish_tasks x
        where x.account_id = p.social_account_id and x.external_id = p.external_id and x.status = 'published'
        order by x.published_at desc nulls last limit 1) pt on true
      where p.social_account_id = ${accountId}
      order by ${order}
      limit ${o.limit} offset ${o.offset}`),
    db.execute<{ total: number; likes: number | null; comments: number | null; last: Date | null }>(sql`
      select count(*)::int as total, sum(likes)::float8 as likes, sum(comments)::float8 as comments, max(fetched_at) as last
      from social_account_posts where social_account_id = ${accountId}`),
  ]);
  const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);
  return {
    total: agg?.total ?? 0, likes: numOrNull(agg?.likes), comments: numOrNull(agg?.comments), lastFetchedAt: iso(agg?.last),
    posts: [...rows].map((r) => ({
      id: String(r.id), externalId: String(r.external_id), mediaType: (r.media_type as string | null) ?? null, productType: (r.product_type as string | null) ?? null,
      caption: (r.caption as string | null) ?? null, permalink: (r.permalink as string | null) ?? null, publishedAt: iso(r.published_at),
      likes: numOrNull(r.likes), comments: numOrNull(r.comments), firstSeenAt: iso(r.first_seen_at)!, fetchedAt: iso(r.fetched_at)!,
      publish: r.publish_task_id ? { taskId: String(r.publish_task_id), contentId: String(r.content_id), title: (r.publish_title as string | null) ?? null } : null,
    })),
  };
}
// ---------------------------------------------------------------- queries
/** Accounts in scope (alias `sa`): admin = all (optional owner), user = own. */
export function accountScope(o: { admin: boolean; userId: string; ownerId?: string; platform?: string; accountId?: string }): SQL {
  const parts: SQL[] = [];
  if (!o.admin) parts.push(sql`sa.user_id = ${o.userId}`);
  else if (o.ownerId) parts.push(sql`sa.user_id = ${o.ownerId}`);
  if (o.platform) parts.push(sql`sa.platform = ${o.platform}`);
  if (o.accountId) parts.push(sql`sa.id = ${o.accountId}`);
  return parts.length ? sql.join(parts, sql` and `) : sql`true`;
}

export interface DayRow {
  id: string; day: string; source: 'api' | 'manual' | 'device';
  /** Metrics the app abbreviated (device source). */
  approx: string[];
  followers: number | null; following: number | null; posts: number | null; totalViews: number | null; totalLikes: number | null;
  followersGained: number | null; views: number | null; likes: number | null; shares: number | null; comments: number | null;
}

const numOrNull = (v: unknown) => (v === null || v === undefined ? null : Number(v));

/**
 * One row per account and day in [from, to] that has a stats row. followersGained = difference to the
 * previous follower reading (counterDeltas); views/likes per day = the platform's day value, else the
 * difference of the lifetime totals.
 */
export async function dailyRows(scope: SQL, from: string, to: string): Promise<DayRow[]> {
  const deltas = (value: string) => counterDeltas({
    table: 'social_account_stats', key: 'social_account_id', at: 'day', value,
    where: sql`social_account_id in (select id from acc) and day <= ${to}::date`,
  });
  const rows = await db.execute<Record<string, unknown>>(sql`
    with acc as (select sa.id from social_accounts sa where ${scope}),
    f as ${deltas('followers')}, tv as ${deltas('total_views')}, tl as ${deltas('total_likes')}
    select s.social_account_id as id, to_char(s.day, 'YYYY-MM-DD') as day, s.source, coalesce(s.approx, '{}') as approx,
      s.followers, s.following, s.posts, s.total_views, s.total_likes, f.delta as followers_gained,
      coalesce(s.views::float8, tv.delta) as views, coalesce(s.likes::float8, tl.delta) as likes, s.shares, s.comments
    from social_account_stats s
    left join f on f.id = s.social_account_id and f.at = s.day
    left join tv on tv.id = s.social_account_id and tv.at = s.day
    left join tl on tl.id = s.social_account_id and tl.at = s.day
    where s.social_account_id in (select id from acc) and s.day between ${from}::date and ${to}::date
    order by s.day, s.social_account_id`);
  return [...rows].map((r) => ({
    id: String(r.id), day: String(r.day), source: r.source as DayRow['source'], approx: (r.approx as string[] | null) ?? [],
    followers: numOrNull(r.followers), following: numOrNull(r.following), posts: numOrNull(r.posts),
    totalViews: numOrNull(r.total_views), totalLikes: numOrNull(r.total_likes), followersGained: numOrNull(r.followers_gained),
    views: numOrNull(r.views), likes: numOrNull(r.likes), shares: numOrNull(r.shares), comments: numOrNull(r.comments),
  }));
}

export interface AccountRow {
  id: string; userId: string; ownerName: string | null; platform: string; handle: string; displayName: string | null;
  latest: { day: string; followers: number | null; following: number | null; posts: number | null; capturedAt: string; source: string; approx: string[] } | null;
  /** Metrics the last stored day lacked (historical API rows). */
  missing: string[];
}

/** Accounts in scope with their latest follower reading and the metrics missing on the last stored day. */
export async function accountRows(scope: SQL): Promise<AccountRow[]> {
  const rows = await db.execute<Record<string, unknown>>(sql`
    select sa.id, sa.user_id, u.username as owner_name, sa.platform, sa.handle, sa.display_name,
      l.latest, coalesce(m.missing, '{}') as missing
    from social_accounts sa
    left join users u on u.id = sa.user_id
    left join lateral (select json_build_object('day', to_char(x.day, 'YYYY-MM-DD'), 'followers', x.followers, 'following', x.following,
        'posts', x.posts, 'capturedAt', x.captured_at, 'source', x.source, 'approx', coalesce(x.approx, '{}')) as latest
      from social_account_stats x where x.social_account_id = sa.id and x.followers is not null order by x.day desc limit 1) l on true
    left join lateral (select x.missing from social_account_stats x where x.social_account_id = sa.id order by x.day desc limit 1) m on true
    where ${scope}
    order by sa.platform, lower(sa.handle)`);
  return [...rows].map((r) => {
    const latest = r.latest as AccountRow['latest'] & Record<string, unknown> | null;
    return {
      id: String(r.id), userId: String(r.user_id), ownerName: (r.owner_name as string | null) ?? null, platform: String(r.platform),
      handle: String(r.handle), displayName: (r.display_name as string | null) ?? null,
      latest: latest ? { ...latest, followers: numOrNull(latest.followers), following: numOrNull(latest.following), posts: numOrNull(latest.posts) } : null,
      missing: (r.missing as string[]) ?? [],
    };
  });
}

type Sums = { followersGained: number | null; views: number | null; likes: number | null; shares: number | null; comments: number | null };
const SUM_KEYS = ['followersGained', 'views', 'likes', 'shares', 'comments'] as const;
const emptySums = (): Sums => ({ followersGained: null, views: null, likes: null, shares: null, comments: null });
/** Adds a row's values; a sum stays null until some row reports the metric. */
function add(s: Sums, r: DayRow) {
  for (const k of SUM_KEYS) if (r[k] !== null) s[k] = (s[k] ?? 0) + r[k]!;
}

/** Totals, per-day sums and per-account sums for the last `days` UTC days (today included). */
export async function summary(scope: SQL, days: number, now = new Date()) {
  const to = utcDay(now);
  const range = dayRange(to, days);
  const [accounts, rows] = await Promise.all([accountRows(scope), dailyRows(scope, range[0]!, to)]);
  const perDay = new Map(range.map((d) => [d, emptySums()]));
  const perAccount = new Map(accounts.map((a) => [a.id, emptySums()]));
  const totals = emptySums();
  for (const r of rows) {
    add(perDay.get(r.day)!, r);
    const pa = perAccount.get(r.id);
    if (pa) add(pa, r);
    add(totals, r);
  }
  return {
    from: range[0]!, to, days: range.map((day) => ({ day, ...perDay.get(day)! })),
    totals: {
      accounts: accounts.length,
      withData: accounts.filter((a) => a.latest || rows.some((r) => r.id === a.id)).length,
      followers: accounts.reduce((s, a) => s + (a.latest?.followers ?? 0), 0),
      ...totals,
    },
    accounts: accounts.map((a) => ({ ...a, range: perAccount.get(a.id)! })),
  };
}

// ---------------------------------------------------------------- dashboard
registerDashboardWidget('analytics', async (ctx) => {
  const s = await summary(accountScope({ admin: ctx.admin, userId: ctx.scope.id }), 7, ctx.now);
  if (!s.totals.accounts) return null;
  return {
    accounts: s.totals.accounts, withData: s.totals.withData, followers: s.totals.followers,
    followersGained7d: s.totals.followersGained, views7d: s.totals.views, shares7d: s.totals.shares,
    likes7d: s.totals.likes, comments7d: s.totals.comments,
    trend: s.days.map((d) => ({ day: d.day, followersGained: d.followersGained, views: d.views, shares: d.shares, likes: d.likes, comments: d.comments })),
    top: s.accounts.filter((a) => (a.range.followersGained ?? 0) > 0)
      .sort((a, b) => b.range.followersGained! - a.range.followersGained! || a.handle.localeCompare(b.handle)).slice(0, 5)
      .map((a) => ({ id: a.id, platform: a.platform, handle: a.handle, displayName: a.displayName, followers: a.latest?.followers ?? null, gain: a.range.followersGained })),
  };
}, { order: 45 });
