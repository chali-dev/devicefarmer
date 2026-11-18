import { and, count, desc, eq, gte, inArray, isNull, lt, sql, type Column, type SQL } from 'drizzle-orm';
import type { Instance } from '../../db/schema.js';
import { db, schema } from '../../db/index.js';
import { hostCapacity } from '../../health.js';
import { counterDeltas } from '../../lib/counter-deltas.js';
import { isAdmin } from '../auth/rbac.js';
import { EXCEPTION_SQL } from '../social/social.js';
import { NEWEST } from '../publish/routes.js';
import { visibleTasks } from '../tasks/routes.js';
import { registerDashboardWidget, type DashboardCtx } from './registry.js';

/**
 * Core dashboard widgets (仪表板). Every number is RBAC-scoped through `ctx.scope`:
 * admin = everything; user = own rows (accounts, content, publish runs, tracked accounts, private media),
 * granted devices, and tasks the task centre shows them (own + on granted devices).
 * All counts are single aggregate queries.
 */

const DAY = 86_400_000;
const BUSY_STATUSES: Instance['status'][] = ['creating', 'starting', 'stopping', 'restarting', 'deleting'];
const I = schema.instances;
const sa = schema.socialAccounts;
const pt = schema.publishTasks;
const T = schema.tasks;
const ma = schema.mediaAssets;
const n = (v: unknown) => Number(v ?? 0);
/** Timestamp parameter for raw SQL (postgres-js does not bind Date objects in sql fragments). */
const at = (d: Date) => sql`${d.toISOString()}::timestamptz`;
const tally = <K extends string>(rows: { k: K | null; n: number | string }[]) => {
  const out: Record<string, number> = {};
  for (const r of rows) if (r.k !== null) out[r.k] = (out[r.k] ?? 0) + n(r.n);
  return out;
};

/** Devices visible to the scope user. */
const deviceScope = (ctx: DashboardCtx): SQL | undefined => (ctx.admin ? undefined
  : inArray(I.id, db.select({ id: schema.instanceGrants.instanceId }).from(schema.instanceGrants).where(eq(schema.instanceGrants.userId, ctx.scope.id))));
/** Owner column filter for private rows. */
const own = (ctx: DashboardCtx, col: Column): SQL | undefined => (ctx.admin ? undefined : eq(col, ctx.scope.id));

// ---------------------------------------------------------------- devices
registerDashboardWidget('devices', async (ctx) => {
  const rows = await db.select({
    k: I.status, n: count(),
    online: sql<number>`count(*) filter (where ${I.adbState} = 'device')::int`,
  }).from(I).where(deviceScope(ctx)).groupBy(I.status);
  const byStatus = tally(rows);
  const busy = BUSY_STATUSES.reduce((s, st) => s + (byStatus[st] ?? 0), 0);
  // Host capacity is an admin concern (and needs a helper container, cached 60 s).
  const capacity = ctx.admin && isAdmin(ctx.viewer) ? await hostCapacity() : null;
  return {
    total: rows.reduce((s, r) => s + n(r.n), 0),
    running: byStatus.running ?? 0, stopped: byStatus.stopped ?? 0, error: byStatus.error ?? 0, busy,
    online: rows.reduce((s, r) => s + n(r.online), 0),
    byStatus, capacity,
  };
}, { order: 10 });

// ---------------------------------------------------------------- proxy pool (admin)
registerDashboardWidget('proxies', async (ctx) => {
  if (!ctx.admin) return null;
  const P = schema.proxies;
  const rows = await db.select({ status: P.status, bound: sql<boolean>`(${I.id} is not null)`, n: count() })
    .from(P).leftJoin(I, eq(I.proxyId, P.id)).groupBy(P.status, sql`(${I.id} is not null)`);
  const sum = (f: (r: typeof rows[number]) => boolean) => rows.filter(f).reduce((s, r) => s + n(r.n), 0);
  return {
    total: sum(() => true),
    bound: sum((r) => r.bound), free: sum((r) => !r.bound),
    /** Unbound and not failed: what auto-assignment can use. */
    freeUsable: sum((r) => !r.bound && r.status !== 'failed'),
    ok: sum((r) => r.status === 'ok'), failed: sum((r) => r.status === 'failed'), unchecked: sum((r) => r.status === 'unchecked'),
  };
}, { order: 20 });

// ---------------------------------------------------------------- social accounts
registerDashboardWidget('social', async (ctx) => {
  const rows = await db.select({ platform: sa.platform, login: sa.loginStatus, exc: sql<boolean>`${EXCEPTION_SQL}`, linked: sql<boolean>`(${sa.instanceId} is not null)`, n: count() })
    .from(sa).where(own(ctx, sa.userId)).groupBy(sa.platform, sa.loginStatus, sql`${EXCEPTION_SQL}`, sql`(${sa.instanceId} is not null)`);
  const byPlatform: Record<string, number> = {}; const byLogin: Record<string, number> = {};
  let total = 0; let exceptions = 0; let linked = 0;
  for (const r of rows) {
    const c = n(r.n);
    total += c;
    byPlatform[r.platform] = (byPlatform[r.platform] ?? 0) + c;
    byLogin[r.login] = (byLogin[r.login] ?? 0) + c;
    if (r.exc) exceptions += c;
    if (r.linked) linked += c;
  }
  return { total, exceptions, linked, byPlatform, byLogin };
}, { order: 30 });

// ---------------------------------------------------------------- tracked accounts
registerDashboardWidget('tracked', async (ctx) => {
  const ta = schema.trackedAccounts;
  const since = new Date(ctx.now.getTime() - 7 * DAY);
  const scope = ctx.admin ? sql`true` : sql`a.user_id = ${ctx.scope.id}`;
  const [rows, gains] = await Promise.all([
    db.select({ k: ta.status, n: count() }).from(ta).where(own(ctx, ta.userId)).groupBy(ta.status),
    // Gain over 7 days: latest follower count minus the baseline (last snapshot at or before the window start,
    // else the first one inside the window), see counterDeltas.
    db.execute<{ id: string; platform: string; handle: string; display_name: string | null; followers: string; gain: string }>(sql`
      with v as (select a.id, a.platform, a.handle, a.display_name from tracked_accounts a where ${scope}),
      d as ${counterDeltas({
        table: 'tracked_account_snapshots', key: 'tracked_account_id', at: 'captured_at', value: 'followers', tie: 'id',
        where: sql`tracked_account_id in (select id from v) and captured_at <= ${at(ctx.now)}`,
      })},
      g as (select d.id, sum(d.delta) filter (where d.at > ${at(since)}) as gain, (array_agg(d.value order by d.at desc))[1] as followers from d group by d.id)
      select v.id, v.platform, v.handle, v.display_name, g.followers, g.gain::float8 as gain
      from v join g on g.id = v.id where g.gain > 0
      order by g.gain desc, v.handle asc limit 5`),
  ]);
  const byStatus = tally(rows);
  return {
    total: rows.reduce((s, r) => s + n(r.n), 0), byStatus,
    topGainers: [...gains].map((g) => ({ id: g.id, platform: g.platform, handle: g.handle, displayName: g.display_name, followers: n(g.followers), gain: n(g.gain) })),
  };
}, { order: 40 });

// ---------------------------------------------------------------- content + publishing
registerDashboardWidget('publishing', async (ctx) => {
  const C = schema.contents;
  const weekAgo = new Date(ctx.now.getTime() - 7 * DAY);
  const inWeek = new Date(ctx.now.getTime() + 7 * DAY);
  const scope = ctx.admin ? sql`true` : sql`p.user_id = ${ctx.scope.id}`;
  const [contents, counts, next, trend] = await Promise.all([
    db.select({ k: C.status, n: count() }).from(C).where(own(ctx, C.userId)).groupBy(C.status),
    db.select({
      upcoming: sql<number>`count(*) filter (where ${pt.status} in ('pending', 'scheduled') and ${pt.scheduledAt} < ${at(inWeek)})::int`,
      published: sql<number>`count(*) filter (where ${pt.status} = 'published' and ${pt.publishedAt} >= ${at(weekAgo)})::int`,
      failed: sql<number>`count(*) filter (where ${pt.status} = 'failed' and ${pt.updatedAt} >= ${at(weekAgo)})::int`,
      awaitingOperator: sql<number>`count(*) filter (where ${pt.status} = 'awaiting_operator')::int`,
      running: sql<number>`count(*) filter (where ${pt.status} = 'running')::int`,
    }).from(pt).where(own(ctx, pt.userId)),
    db.select({ id: pt.id, scheduledAt: pt.scheduledAt, platform: pt.platform, status: pt.status, title: sql<string | null>`coalesce(${pt.title}, ${C.title})`, handle: sa.handle })
      .from(pt).leftJoin(C, eq(C.id, pt.contentId)).leftJoin(sa, eq(sa.id, pt.accountId))
      .where(and(own(ctx, pt.userId), inArray(pt.status, ['pending', 'scheduled']), lt(pt.scheduledAt, inWeek)))
      .orderBy(pt.scheduledAt, pt.id).limit(5),
    // Published (by published_at) and failed (by last update) per day in the viewer's time zone, 14 days.
    // updated_at >= published_at, so the updated_at prefilter is a superset for both series.
    db.execute<{ day: string; published: number; failed: number }>(sql`
      with days as (select generate_series(date_trunc('day', ${at(ctx.now)} at time zone ${ctx.tz}) - interval '13 days',
        date_trunc('day', ${at(ctx.now)} at time zone ${ctx.tz}), interval '1 day')::date as d),
      p as (select status, (coalesce(published_at, updated_at) at time zone ${ctx.tz})::date as pd, (updated_at at time zone ${ctx.tz})::date as ud
        from publish_tasks p where ${scope} and p.status in ('published', 'failed')
          and p.updated_at >= (date_trunc('day', ${at(ctx.now)} at time zone ${ctx.tz}) - interval '13 days') at time zone ${ctx.tz})
      select to_char(days.d, 'YYYY-MM-DD') as day,
        (select count(*) from p where p.status = 'published' and p.pd = days.d)::int as published,
        (select count(*) from p where p.status = 'failed' and p.ud = days.d)::int as failed
      from days order by days.d`),
  ]);
  const c = counts[0];
  return {
    contents: { total: contents.reduce((s, r) => s + n(r.n), 0), byStatus: tally(contents) },
    upcoming7d: n(c?.upcoming), published7d: n(c?.published), failed7d: n(c?.failed),
    awaitingOperator: n(c?.awaitingOperator), running: n(c?.running),
    next: next.map((x) => ({ ...x, scheduledAt: x.scheduledAt.toISOString() })),
    trend: [...trend].map((r) => ({ day: r.day, published: n(r.published), failed: n(r.failed) })),
  };
}, { order: 50 });

// ---------------------------------------------------------------- today's publishing per post type
// Same day rule as GET /api/publish/tasks?from&to: published_at when published, else scheduled_at, in the viewer's time zone;
// only the newest task per content + account (like the 今日 tab with group=content: a failed attempt edited and published again counts once).
registerDashboardWidget('publishToday', async (ctx) => {
  const day = sql`(date_trunc('day', ${at(ctx.now)} at time zone ${ctx.tz}) at time zone ${ctx.tz})`;
  const when = sql`coalesce(${pt.publishedAt}, ${pt.scheduledAt})`;
  const rows = await db.select({ t: pt.postType, s: pt.status, n: count() }).from(pt)
    .where(and(own(ctx, pt.userId), sql`${when} >= ${day}`, sql`${when} < ${day} + interval '1 day'`, sql`${pt.status} <> 'cancelled'`, NEWEST))
    .groupBy(pt.postType, pt.status);
  const byType = { feed: 0, reel: 0, story: 0 } as Record<string, number>;
  const published = { feed: 0, reel: 0, story: 0 } as Record<string, number>;
  const byStatus: Record<string, number> = {};
  for (const r of rows) {
    byType[r.t] = (byType[r.t] ?? 0) + n(r.n);
    byStatus[r.s] = (byStatus[r.s] ?? 0) + n(r.n);
    if (r.s === 'published') published[r.t] = (published[r.t] ?? 0) + n(r.n);
  }
  return { total: rows.reduce((s, r) => s + n(r.n), 0), byType, published, byStatus };
}, { order: 55 });

// ---------------------------------------------------------------- task centre
registerDashboardWidget('tasks', async (ctx) => {
  const since = new Date(ctx.now.getTime() - DAY);
  const vis = visibleTasks(ctx.scope);
  const [rows, failures] = await Promise.all([
    db.select({ k: T.status, n: count() }).from(T).where(and(vis, gte(T.createdAt, since))).groupBy(T.status),
    db.select({ id: T.id, type: T.type, label: T.instanceName, error: T.error, errorCode: T.errorCode, finishedAt: T.finishedAt, createdAt: T.createdAt })
      .from(T).where(and(vis, eq(T.status, 'failed'))).orderBy(desc(T.createdAt), desc(T.id)).limit(5),
  ]);
  const byStatus = tally(rows);
  return {
    last24h: {
      total: rows.reduce((s, r) => s + n(r.n), 0),
      pending: byStatus.pending ?? 0, scheduled: byStatus.scheduled ?? 0, running: byStatus.running ?? 0,
      success: byStatus.success ?? 0, failed: byStatus.failed ?? 0, cancelled: byStatus.cancelled ?? 0,
    },
    recentFailures: failures,
  };
}, { order: 60 });

// ---------------------------------------------------------------- media library
registerDashboardWidget('media', async (ctx) => {
  // Admin: all public + all users' private media. User: public media they can see (ready) + their own.
  const visible = ctx.admin ? undefined
    : sql`((${ma.ownerType} = 'public' and ${ma.status} = 'ready') or (${ma.ownerType} = 'user' and ${ma.ownerId} = ${ctx.scope.id}))`;
  const rows = await db.select({
    owner: ma.ownerType, n: count(), bytes: sql<string>`coalesce(sum(${ma.fileSize}), 0)::float8`,
    images: sql<number>`count(*) filter (where ${ma.fileType} = 'image')::int`,
    processing: sql<number>`count(*) filter (where ${ma.status} = 'processing')::int`,
    failed: sql<number>`count(*) filter (where ${ma.status} = 'failed')::int`,
  }).from(ma).where(and(isNull(ma.deletedAt), visible)).groupBy(ma.ownerType);
  const part = (o: 'public' | 'user') => {
    const r = rows.find((x) => x.owner === o);
    return { count: n(r?.n), bytes: n(r?.bytes), images: n(r?.images), videos: n(r?.n) - n(r?.images) };
  };
  return {
    public: part('public'), private: part('user'),
    processing: rows.reduce((s, r) => s + n(r.processing), 0), failed: rows.reduce((s, r) => s + n(r.failed), 0),
  };
}, { order: 70 });

// ---------------------------------------------------------------- per-user breakdown (admin overview)
registerDashboardWidget('perUser', async (ctx) => {
  if (!ctx.admin || !isAdmin(ctx.viewer) || ctx.scope.id !== ctx.viewer.id) return null;
  const weekAgo = new Date(ctx.now.getTime() - 7 * DAY);
  const ta = schema.trackedAccounts; const C = schema.contents; const g = schema.instanceGrants;
  const [users, acc, tracked, contents, pub, grants] = await Promise.all([
    db.select({ id: schema.users.id, username: schema.users.username, role: schema.users.role, disabled: schema.users.disabled }).from(schema.users).orderBy(schema.users.username),
    db.select({ k: sa.userId, n: count(), exc: sql<number>`count(*) filter (where ${EXCEPTION_SQL})::int` }).from(sa).groupBy(sa.userId),
    db.select({ k: ta.userId, n: count() }).from(ta).groupBy(ta.userId),
    db.select({ k: C.userId, n: count() }).from(C).groupBy(C.userId),
    db.select({
      k: pt.userId,
      published: sql<number>`count(*) filter (where ${pt.status} = 'published' and ${pt.publishedAt} >= ${at(weekAgo)})::int`,
      failed: sql<number>`count(*) filter (where ${pt.status} = 'failed' and ${pt.updatedAt} >= ${at(weekAgo)})::int`,
      awaiting: sql<number>`count(*) filter (where ${pt.status} = 'awaiting_operator')::int`,
    }).from(pt).groupBy(pt.userId),
    db.select({ k: g.userId, n: count() }).from(g).groupBy(g.userId),
  ]);
  const get = <R extends { k: string }>(rs: R[], id: string) => rs.find((r) => r.k === id);
  return {
    users: users.map((u) => ({
      id: u.id, username: u.username, role: u.role, disabled: u.disabled,
      devices: n(get(grants, u.id)?.n), socialAccounts: n(get(acc, u.id)?.n), exceptions: n(get(acc, u.id)?.exc),
      trackedAccounts: n(get(tracked, u.id)?.n), contents: n(get(contents, u.id)?.n),
      published7d: n(get(pub, u.id)?.published), failed7d: n(get(pub, u.id)?.failed), awaitingOperator: n(get(pub, u.id)?.awaiting),
    })),
  };
}, { order: 90 });
