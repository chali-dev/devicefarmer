import { and, eq, inArray } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { config } from '../../config.js';
import { db, schema } from '../../db/index.js';
import { recordAudit } from '../audit/audit.js';
import { visibleAccount } from '../social/social.js';
import { createTask } from '../tasks/core.js';
import { ACCOUNT_CHECK_TASK, ACCOUNT_REF_TYPE } from './check.js';
import { disconnect, visibleConnections } from './connections.js';
import { appOptions, getPlatformApps, savePlatformApp } from './credentials.js';
import { platformError } from './http.js';
import { ADAPTER_IDS, ADAPTERS, requireAdapter } from './index.js';
import { beginConnect, bindingCookieName, completeConnect, STATE_TTL_SEC } from './oauth.js';
import './check.js'; // registers the social-account-check task handler

const PlatformParam = z.object({ platform: z.enum(ADAPTER_IDS) });
const Id = z.object({ id: z.string().uuid() });
const base = () => (config.PUBLIC_BASE_URL ?? config.WEB_ORIGIN).replace(/\/+$/, '');
const secureCookie = () => base().startsWith('https://');

function cookieValue(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return undefined;
}

const cookie = (name: string, value: string, maxAge: number) =>
  `${name}=${encodeURIComponent(value)}; Path=/api/platforms; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secureCookie() ? '; Secure' : ''}`;

/**
 * Official platform integrations (平台接入): app credentials (admin), OAuth connect/callback,
 * connections (status only, never tokens), disconnect and the account check task.
 */
export const platformRoutes: FastifyPluginAsyncZod = async (app) => {
  /** Adapters, whether they are configured, and what their official APIs can do. */
  app.get('/api/platforms', { preHandler: app.authenticate }, async () => {
    const apps = await getPlatformApps(ADAPTER_IDS);
    return {
      platforms: ADAPTERS.map((a) => {
        const s = apps.find((x) => x.platform === a.id)!;
        return { id: a.id, name: a.name, configured: s.configured, capabilities: a.capabilities(s.options), scopes: a.oauth.scopes(s.options), pkce: a.oauth.pkce };
      }),
    };
  });

  // ------------------------------------------------------------ credentials (admin)
  app.get('/api/settings/platforms', { preHandler: app.requireAdmin }, async () => {
    const apps = await getPlatformApps(ADAPTER_IDS);
    return { apps: apps.map((s) => ({ ...s, name: requireAdapter(s.platform).name, scopes: requireAdapter(s.platform).oauth.scopes(s.options) })) };
  });

  /** clientSecret: string = set, null = clear, omitted = keep. clientId: null removes the whole entry. */
  app.put('/api/settings/platforms/:platform', {
    preHandler: app.requireAdmin,
    schema: {
      params: PlatformParam,
      body: z.object({
        clientId: z.string().trim().min(3).max(300).regex(/^[\x21-\x7e]+$/, 'invalid client id').nullable().optional(),
        clientSecret: z.string().trim().min(8).max(500).regex(/^[\x21-\x7e]+$/, 'invalid client secret').nullable().optional(),
        options: z.object({ directPost: z.boolean().optional(), accountStats: z.boolean().optional() }).strict().optional(),
      }).refine((b) => b.clientId !== undefined || b.clientSecret !== undefined || b.options !== undefined, 'nothing to update'),
    },
  }, async (req) => {
    const { platform } = req.params;
    const cur = (await getPlatformApps([platform]))[0]!;
    if (req.body.clientId !== null && !(req.body.clientId ?? cur.clientId)) {
      throw platformError(400, 'client_id_required', '请先填写 Client ID');
    }
    const saved = await savePlatformApp(platform, req.body);
    const a = requireAdapter(platform);
    return { app: { ...saved, name: a.name, scopes: a.oauth.scopes(saved.options) } };
  });

  // ------------------------------------------------------------ OAuth
  app.post('/api/platforms/:platform/connect', {
    preHandler: app.authenticate,
    schema: { params: PlatformParam, body: z.object({ socialAccountId: z.string().uuid() }) },
  }, async (req, reply) => {
    const start = await beginConnect(req.user, req.params.platform, req.body.socialAccountId);
    reply.header('set-cookie', cookie(start.cookie.name, start.cookie.value, start.cookie.maxAge));
    return { url: start.url, expiresInSec: STATE_TTL_SEC };
  });

  /** Browser comes back here from the platform (no bearer token: the state + binding cookie identify the flow). */
  app.get('/api/platforms/:platform/callback', {
    schema: {
      params: PlatformParam,
      querystring: z.object({
        state: z.string().max(500).optional(), code: z.string().max(4096).optional(),
        error: z.string().max(200).optional(), error_description: z.string().max(1000).optional(),
      }),
    },
  }, async (req, reply) => {
    const { platform } = req.params;
    const q = req.query;
    const name = q.state ? bindingCookieName(q.state) : null;
    const result = await completeConnect({
      platform, state: q.state, code: q.code, error: q.error, errorDescription: q.error_description,
      binding: name ? cookieValue(req.headers.cookie, name) : undefined,
    });
    if (name) reply.header('set-cookie', cookie(name, '', 0));
    const [acc] = result.accountId
      ? await db.select({ platform: schema.socialAccounts.platform, handle: schema.socialAccounts.handle }).from(schema.socialAccounts).where(eq(schema.socialAccounts.id, result.accountId))
      : [];
    recordAudit(req.log, {
      userId: result.user?.id ?? null, username: result.user?.username ?? null,
      action: result.error ? 'platform.connect_failed' : 'platform.connect',
      target: acc ? `${acc.platform} @${acc.handle}` : null, targetId: result.accountId,
      method: 'GET', path: req.routeOptions.url ?? '/api/platforms/:platform/callback', status: result.error?.statusCode ?? 200, ip: req.ip,
      detail: {
        platform, code: result.error?.code ?? undefined, error: result.error?.message.slice(0, 200),
        externalAccountId: result.connection?.externalAccountId ?? undefined, scopes: result.connection?.scopes,
      },
    });
    const qs = new URLSearchParams({ platformConnect: platform, result: result.error ? 'error' : 'ok' });
    if (result.error?.code) qs.set('code', result.error.code);
    if (result.accountId && result.user) qs.set('account', result.accountId);
    return reply.redirect(`${base()}/social?${qs}`, 302);
  });

  // ------------------------------------------------------------ connections
  app.get('/api/platforms/connections', {
    preHandler: app.authenticate,
    schema: { querystring: z.object({ accountIds: z.string().max(200 * 37).optional() }) },
  }, async (req) => {
    const ids = req.query.accountIds?.split(',').map((s) => s.trim()).filter(Boolean);
    if (ids?.some((id) => !/^[0-9a-f-]{36}$/i.test(id))) throw platformError(400, 'bad_account_ids', 'accountIds must be uuids');
    return { connections: await visibleConnections(req.user, ids) };
  });

  app.delete('/api/platforms/accounts/:id/connection', { preHandler: app.authenticate, schema: { params: Id } }, async (req) => {
    return disconnect(req.user, req.params.id);
  });

  /** Queues a social-account-check task (also for accounts without a connection: it records "manual only"). */
  app.post('/api/platforms/accounts/:id/check', { preHandler: app.authenticate, schema: { params: Id } }, async (req, reply) => {
    const acc = await visibleAccount(req.user, req.params.id);
    const [busy] = await db.select({ id: schema.tasks.id }).from(schema.tasks).where(and(
      eq(schema.tasks.type, ACCOUNT_CHECK_TASK), eq(schema.tasks.refId, acc.id), inArray(schema.tasks.status, ['pending', 'scheduled', 'running']),
    ));
    if (busy) throw platformError(409, 'check_in_progress', '该账号正在检查', {});
    const { task } = await createTask({
      type: ACCOUNT_CHECK_TASK, userId: req.user.id, label: `${acc.platform} @${acc.handle}`,
      refType: ACCOUNT_REF_TYPE, refId: acc.id, payload: { socialAccountId: acc.id },
    });
    reply.code(202);
    return { taskId: task.id };
  });

  /** Capabilities of one platform (with the admin's options), e.g. for the publish UI. */
  app.get('/api/platforms/:platform/capabilities', { preHandler: app.authenticate, schema: { params: PlatformParam } }, async (req) => ({
    capabilities: requireAdapter(req.params.platform).capabilities(await appOptions(req.params.platform)),
  }));
};
