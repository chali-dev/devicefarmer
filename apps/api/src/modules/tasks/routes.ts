import { and, asc, count, desc, eq, getTableColumns, gte, ilike, inArray, lte, or, sql, type SQL } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { db, schema } from '../../db/index.js';
import { TASK_STATUSES, type Task } from '../../db/schema.js';
import { notFound } from '../../lib/errors.js';
import { assertInstanceAccess, isAdmin, type AuthUser } from '../auth/rbac.js';
import { cancelTask, isFinal, registeredTaskTypes, retryTask, taskHandler } from './core.js';

const { payload: _payload, result: _result, ...listColumns } = getTableColumns(schema.tasks);
const T = schema.tasks;

/** Admins see every task; users their own tasks plus tasks on devices granted to them. */
export function visibleTasks(user: AuthUser): SQL | undefined {
  if (isAdmin(user)) return undefined;
  const granted = db.select({ id: schema.instanceGrants.instanceId }).from(schema.instanceGrants).where(eq(schema.instanceGrants.userId, user.id));
  return or(eq(T.createdBy, user.id), inArray(T.instanceId, granted));
}

const csv = <E extends z.ZodType<string, string>>(item: E) => z.string().max(500).transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean))
  .pipe(z.array(item).max(20));

const Filters = z.object({
  status: csv(z.enum(TASK_STATUSES)).optional(),
  type: csv(z.string().max(64)).optional(),
  refType: z.string().max(64).optional(),
  refId: z.string().uuid().optional(),
  instanceId: z.string().uuid().optional(),
  /** Owner (tasks.created_by). */
  userId: z.string().uuid().optional(),
  /** created_at range (ISO). */
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  /** Search in label (device / media name), type, error and id. */
  q: z.string().trim().max(100).optional(),
});
type FilterQuery = z.infer<typeof Filters>;

function where(user: AuthUser, f: FilterQuery, withStatus = true): SQL | undefined {
  const like = f.q ? `%${f.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
  return and(
    visibleTasks(user),
    withStatus && f.status?.length ? inArray(T.status, f.status) : undefined,
    f.type?.length ? inArray(T.type, f.type) : undefined,
    f.refType ? eq(T.refType, f.refType) : undefined,
    f.refId ? eq(T.refId, f.refId) : undefined,
    f.instanceId ? eq(T.instanceId, f.instanceId) : undefined,
    f.userId ? eq(T.createdBy, f.userId) : undefined,
    f.from ? gte(T.createdAt, f.from) : undefined,
    f.to ? lte(T.createdAt, f.to) : undefined,
    like ? or(ilike(T.instanceName, like), ilike(T.type, like), ilike(T.error, like), ilike(sql`${T.id}::text`, like)) : undefined,
  );
}

/** 404 unless the user may see the task (no existence leak). */
async function visibleTask(user: AuthUser, id: string): Promise<Task> {
  const [row] = await db.select().from(T).where(and(eq(T.id, id), visibleTasks(user)));
  if (!row) throw notFound('task not found', 'tasks.not_found');
  return row;
}

const withActions = (t: Task) => {
  const h = taskHandler(t.type);
  return {
    canCancel: !isFinal(t.status) && !!h && h.cancellable !== false && !(t.status === 'running' && t.cancelRequested),
    canRetry: (t.status === 'failed' || t.status === 'cancelled') && !!h && h.retryable !== false,
  };
};

export const taskRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', app.authenticate);

  app.get('/api/tasks', {
    schema: { querystring: Filters.extend({ limit: z.coerce.number().int().min(1).max(200).default(50), offset: z.coerce.number().int().min(0).default(0) }) },
  }, async (req) => {
    const w = where(req.user, req.query);
    const [rows, [total]] = await Promise.all([
      db.select({ ...listColumns, createdByName: schema.users.username })
        .from(T).leftJoin(schema.users, eq(schema.users.id, T.createdBy))
        .where(w).orderBy(desc(T.createdAt), asc(T.id)).limit(req.query.limit).offset(req.query.offset),
      db.select({ n: count() }).from(T).where(w),
    ]);
    return { tasks: rows, total: total?.n ?? 0 };
  });

  /** Counts by status (ignoring the status filter, for the tabs) and by type. */
  app.get('/api/tasks/stats', { schema: { querystring: Filters } }, async (req) => {
    const w = where(req.user, req.query, false);
    const [byStatus, byType] = await Promise.all([
      db.select({ k: T.status, n: count() }).from(T).where(w).groupBy(T.status),
      db.select({ k: T.type, n: count() }).from(T).where(where(req.user, req.query)).groupBy(T.type),
    ]);
    return {
      byStatus: Object.fromEntries(TASK_STATUSES.map((s) => [s, byStatus.find((r) => r.k === s)?.n ?? 0])),
      byType: Object.fromEntries(byType.map((r) => [r.k, r.n])),
      types: registeredTaskTypes(),
    };
  });

  app.get('/api/tasks/:id', { schema: { params: z.object({ id: z.string().uuid() }) } }, async (req) => {
    const task = await visibleTask(req.user, req.params.id);
    const [owner] = task.createdBy ? await db.select({ username: schema.users.username }).from(schema.users).where(eq(schema.users.id, task.createdBy)) : [];
    const logs = await db.select().from(schema.taskLogs).where(eq(schema.taskLogs.taskId, task.id)).orderBy(asc(schema.taskLogs.ts)).limit(1000);
    return { task: { ...task, createdByName: owner?.username ?? null, ...withActions(task) }, logs };
  });

  app.post('/api/tasks/:id/cancel', { schema: { params: z.object({ id: z.string().uuid() }) } }, async (req) => {
    const task = await visibleTask(req.user, req.params.id);
    if (task.instanceId) await assertInstanceAccess(req.user, task.instanceId, 'operate');
    const row = await cancelTask(task, req.user.username);
    return { task: { ...row, ...withActions(row) } };
  });

  app.post('/api/tasks/:id/retry', { schema: { params: z.object({ id: z.string().uuid() }) } }, async (req, reply) => {
    const task = await visibleTask(req.user, req.params.id);
    if (task.instanceId) await assertInstanceAccess(req.user, task.instanceId, 'operate');
    const created = await retryTask(task, req.user);
    if (req.audit) req.audit.extra = { newTaskId: created.id };
    reply.code(202);
    return { task: { ...created, ...withActions(created) } };
  });
};
