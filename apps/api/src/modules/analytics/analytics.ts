import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { db, schema } from '../../db/index.js';
import { counterDeltas } from '../../lib/counter-deltas.js';
import { registerDashboardWidget } from '../dashboard/registry.js';
import { ACCOUNT_REF_TYPE } from '../platforms/check.js';
import { appOptions } from '../platforms/credentials.js';
import { connectionFor } from '../platforms/connections.js';
import { adapterById, enabledAdapters } from '../platforms/index.js';
import { apiAccountStats } from '../platforms/service.js';
import { createTask, registerTaskHandler, type TaskContext } from '../tasks/core.js';

/**
 * Account analytics (账号分析) of the operator's OWN social accounts: daily stats rows
 * (`social_account_stats`, one per account and UTC day) from the official APIs of connected accounts
 * (task `account-stats`, daily + "refresh now") or entered by hand. RBAC = social accounts: users see
 * their own accounts, admins all. A failed run is a failed task with a coded error (task centre);
 * the account's own status is never touched here.
 */
export const STATS_TASK = 'account-stats';
/** Days of day activity asked for on each run (YouTube Analytics reports with ~2 days delay). */
const ACTIVITY_DAYS = 5;
export const MAX_RANGE_DAYS = 90;
const DAY_MS = 86_400_000;
const st = schema.socialAccountStats;

export const utcDay = (d: Date) => d.toISOString().slice(0, 10);
/** `n` UTC days ending with `to`, oldest first. */
export function dayRange(to: string, n: number): string[] {
  const end = Date.parse(`${to}T00:00:00Z`);
  return Array.from({ length: n }, (_, i) => utcDay(new Date(end - (n - 1 - i) * DAY_MS)));
}

export const METRICS = ['followers', 'following', 'posts', 'totalViews', 'totalLikes', 'views', 'likes', 'shares', 'comments'] as const;
export type Metric = typeof METRICS[number];
export type StatValues = Partial<Record<Metric, number | null>>;
const COLUMN: Record<Metric, string> = {
  followers: 'followers', following: 'following', posts: 'posts', totalViews: 'total_views', totalLikes: 'total_likes',
  views: 'views', likes: 'likes', shares: 'shares', comments: 'comments',
};

/**
 * Writes one day of an account. `api`: values the platform did not return (null/undefined) keep what
 * the row had. `manual`: the given keys are set as entered (null clears). `missing` replaces the
 * row's list only when given. Idempotent: the same input twice leaves the same row.
 */
export async function upsertDay(
  exec: Pick<typeof db, 'insert'>, accountId: string, day: string, values: StatValues, source: 'api' | 'manual',
  opts: { missing?: string[]; createdBy?: string | null; capturedAt?: Date } = {},
) {
  const keys = METRICS.filter((k) => values[k] !== undefined);
  const set: Record<string, unknown> = { source, capturedAt: sql`excluded.captured_at` };
  for (const k of keys) {
    set[k] = source === 'api' ? sql.raw(`coalesce(excluded.${COLUMN[k]}, social_account_stats.${COLUMN[k]})`) : sql.raw(`excluded.${COLUMN[k]}`);
  }
  if (opts.missing) set.missing = sql`excluded.missing`;
  if (source === 'manual') set.createdBy = sql`excluded.created_by`;
  const [row] = await exec.insert(st).values({
    socialAccountId: accountId, day, source, capturedAt: opts.capturedAt ?? new Date(), createdBy: opts.createdBy ?? null,
    missing: opts.missing ?? [], ...Object.fromEntries(keys.map((k) => [k, values[k] ?? null])),
  }).onConflictDoUpdate({ target: [st.socialAccountId, st.day], set }).returning();
  return row!;
}

/** Enabled platforms whose adapter can fetch account stats. */
const statsPlatforms = () => enabledAdapters().filter((a) => a.capabilities({}).accountStats).map((a) => a.id);

// ---------------------------------------------------------------- refresh (task)
export async function refreshAccountStats(accountId: string, ctx: Pick<TaskContext, 'signal' | 'log'>): Promise<Record<string, unknown>> {
  const [account] = await db.select().from(schema.socialAccounts).where(eq(schema.socialAccounts.id, accountId));
  if (!account) { await ctx.log('warn', 'account no longer exists'); return { outcome: 'account_deleted' }; }
  const adapter = adapterById(account.platform);
  if (!adapter || !adapter.capabilities(await appOptions(account.platform)).accountStats) {
    await ctx.log('info', 'no official stats API for this platform: manual entry only');
    return { outcome: 'manual_only' };
  }
  if (!(await connectionFor(account.id))) {
    await ctx.log('info', 'no official API connection: manual entry only, nothing changed');
    return { outcome: 'manual_only' };
  }
  const now = new Date();
  const today = utcDay(now);
  const days = dayRange(today, ACTIVITY_DAYS);
  const s = await apiAccountStats(account, days, { signal: ctx.signal, log: (m, d) => ctx.log('info', m, d) });
  const byDay = new Map(s.days.map((d) => [d.day, d]));
  await db.transaction(async (tx) => {
    const t = byDay.get(today);
    await upsertDay(tx, account.id, today, {
      followers: s.followers, following: s.following, posts: s.posts, totalViews: s.totalViews, totalLikes: s.totalLikes,
      views: t?.views, likes: t?.likes, shares: t?.shares, comments: t?.comments,
    }, 'api', { missing: s.missing, capturedAt: now });
    for (const d of s.days) {
      if (d.day === today || d.day > today) continue;
      await upsertDay(tx, account.id, d.day, { views: d.views, likes: d.likes, shares: d.shares, comments: d.comments }, 'api', { capturedAt: now });
    }
  });
  await ctx.log('info', 'stats stored', { day: today, followers: s.followers, activityDays: s.days.length });
  if (s.missing.length) {
    await ctx.log('warn', 'scope missing: re-authorise the account to get these metrics', { missing: s.missing, scopes: s.missingScopes });
    return { outcome: 'partial', code: 'analytics.scope_missing', day: today, missing: s.missing, missingScopes: s.missingScopes };
  }
  return { outcome: 'refreshed', day: today, activityDays: s.days.length };
}

// Device-less, one attempt: the next daily run (or "refresh now") is the retry.
registerTaskHandler<{ socialAccountId: string }>(STATS_TASK, {
  queue: 'task-ops',
  timeoutMs: 3 * 60_000,
  maxAttempts: 1,
  run: (ctx) => refreshAccountStats(ctx.payload.socialAccountId ?? ctx.task.refId!, ctx),
});

/** Stats tasks of these accounts that have not finished yet. */
export async function pendingStats(ids: string[]): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const T = schema.tasks;
  const rows = await db.select({ refId: T.refId }).from(T).where(and(
    eq(T.type, STATS_TASK), eq(T.refType, ACCOUNT_REF_TYPE), inArray(T.refId, ids), inArray(T.status, ['pending', 'scheduled', 'running']),
  ));
  return new Set(rows.map((r) => r.refId!));
}

export const accountLabel = (a: { platform: string; handle: string }) => `${a.platform} @${a.handle}`;

/** Stable 0..1 per account, so each account keeps its time of day. */
const slot = (id: string) => parseInt(id.replace(/-/g, '').slice(0, 8), 16) / 0x1_0000_0000;

/**
 * Daily run for every connected account of a platform with a stats API: one task per account and UTC
 * day (idempotency key account-stats:<id>:<day>), spread over the day by account id; a slot already
 * passed runs within the hour. Called hourly (main.ts); accounts already scheduled today are skipped
 * in the query, so repeated calls create nothing. `spread: false` runs them now (tests).
 */
export async function scheduleDailyAccountStats(now = new Date(), opts: { spread?: boolean } = {}): Promise<{ created: number }> {
  const day = utcDay(now);
  const platforms = statsPlatforms();
  if (!platforms.length) return { created: 0 };
  const rows = await db.execute<{ id: string; user_id: string; platform: string; handle: string }>(sql`
    select sa.id, sa.user_id, sa.platform, sa.handle from social_accounts sa
    join platform_connections pc on pc.social_account_id = sa.id and pc.status = 'connected'
    where sa.platform in (${sql.join(platforms.map((p) => sql`${p}`), sql`, `)})
      and not exists (select 1 from tasks t where t.type = ${STATS_TASK} and t.idempotency_key = ${`${STATS_TASK}:`} || sa.id::text || ${`:${day}`})`);
  let created = 0;
  const dayStart = Date.parse(`${day}T00:00:00Z`);
  for (const a of rows) {
    let runAt: Date | null = null;
    if (opts.spread !== false) {
      const at = dayStart + Math.floor(slot(a.id) * DAY_MS);
      runAt = new Date(at > now.getTime() ? at : now.getTime() + Math.floor(slot(a.id) * 3600_000));
    }
    const r = await createTask({
      type: STATS_TASK, userId: a.user_id, label: accountLabel(a), refType: ACCOUNT_REF_TYPE, refId: a.id,
      payload: { socialAccountId: a.id }, idempotencyKey: `${STATS_TASK}:${a.id}:${day}`, runAt,
    });
    if (r.created) created++;
  }
  return { created };
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
  id: string; day: string; source: 'api' | 'manual';
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
    select s.social_account_id as id, to_char(s.day, 'YYYY-MM-DD') as day, s.source,
      s.followers, s.following, s.posts, s.total_views, s.total_likes, f.delta as followers_gained,
      coalesce(s.views::float8, tv.delta) as views, coalesce(s.likes::float8, tl.delta) as likes, s.shares, s.comments
    from social_account_stats s
    left join f on f.id = s.social_account_id and f.at = s.day
    left join tv on tv.id = s.social_account_id and tv.at = s.day
    left join tl on tl.id = s.social_account_id and tl.at = s.day
    where s.social_account_id in (select id from acc) and s.day between ${from}::date and ${to}::date
    order by s.day, s.social_account_id`);
  return [...rows].map((r) => ({
    id: String(r.id), day: String(r.day), source: r.source as DayRow['source'],
    followers: numOrNull(r.followers), following: numOrNull(r.following), posts: numOrNull(r.posts),
    totalViews: numOrNull(r.total_views), totalLikes: numOrNull(r.total_likes), followersGained: numOrNull(r.followers_gained),
    views: numOrNull(r.views), likes: numOrNull(r.likes), shares: numOrNull(r.shares), comments: numOrNull(r.comments),
  }));
}

export interface AccountRow {
  id: string; userId: string; ownerName: string | null; platform: string; handle: string; displayName: string | null;
  connection: string | null;
  latest: { day: string; followers: number | null; following: number | null; posts: number | null; capturedAt: string; source: string } | null;
  missing: string[];
  lastRun: { id: string; status: string; errorCode: string | null; error: string | null; createdAt: string; finishedAt: string | null } | null;
}

/** Accounts in scope with connection status, latest follower reading, missing metrics and the last stats task. */
export async function accountRows(scope: SQL): Promise<AccountRow[]> {
  const rows = await db.execute<Record<string, unknown>>(sql`
    select sa.id, sa.user_id, u.username as owner_name, sa.platform, sa.handle, sa.display_name, pc.status as connection,
      l.latest, coalesce(m.missing, '{}') as missing, r.last_run
    from social_accounts sa
    left join users u on u.id = sa.user_id
    left join platform_connections pc on pc.social_account_id = sa.id
    left join lateral (select json_build_object('day', to_char(x.day, 'YYYY-MM-DD'), 'followers', x.followers, 'following', x.following,
        'posts', x.posts, 'capturedAt', x.captured_at, 'source', x.source) as latest
      from social_account_stats x where x.social_account_id = sa.id and x.followers is not null order by x.day desc limit 1) l on true
    left join lateral (select x.missing from social_account_stats x where x.social_account_id = sa.id order by x.day desc limit 1) m on true
    left join lateral (select json_build_object('id', t.id, 'status', t.status, 'errorCode', t.error_code, 'error', t.error,
        'createdAt', t.created_at, 'finishedAt', t.finished_at) as last_run
      from tasks t where t.ref_type = ${ACCOUNT_REF_TYPE} and t.ref_id = sa.id and t.type = ${STATS_TASK} order by t.created_at desc limit 1) r on true
    where ${scope}
    order by sa.platform, lower(sa.handle)`);
  return [...rows].map((r) => {
    const latest = r.latest as AccountRow['latest'] & Record<string, unknown> | null;
    return {
      id: String(r.id), userId: String(r.user_id), ownerName: (r.owner_name as string | null) ?? null, platform: String(r.platform),
      handle: String(r.handle), displayName: (r.display_name as string | null) ?? null, connection: (r.connection as string | null) ?? null,
      latest: latest ? { ...latest, followers: numOrNull(latest.followers), following: numOrNull(latest.following), posts: numOrNull(latest.posts) } : null,
      missing: (r.missing as string[]) ?? [],
      lastRun: (r.last_run as AccountRow['lastRun']) ?? null,
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
    trend: s.days.map((d) => ({ day: d.day, followersGained: d.followersGained, views: d.views, shares: d.shares })),
    top: s.accounts.filter((a) => (a.range.followersGained ?? 0) > 0)
      .sort((a, b) => b.range.followersGained! - a.range.followersGained! || a.handle.localeCompare(b.handle)).slice(0, 5)
      .map((a) => ({ id: a.id, platform: a.platform, handle: a.handle, displayName: a.displayName, followers: a.latest?.followers ?? null, gain: a.range.followersGained })),
  };
}, { order: 45 });
