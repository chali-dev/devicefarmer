import type { FastifyPluginAsync } from 'fastify';
import WebSocket from 'ws';
import { events, type PlatformEvent } from '../../lib/events.js';
import { accessibleInstanceIds, type AuthUser } from '../auth/rbac.js';

/** Real-time instance/task updates, filtered per user by RBAC. First message: {type:"auth",token}. */
export const eventsRoutes: FastifyPluginAsync = async (app) => {
  app.get('/api/events', { websocket: true }, (client) => {
    let user: AuthUser | null = null;
    let allowed: Set<string> | 'all' = new Set();
    let refreshedAt = 0;
    const authTimer = setTimeout(() => { if (!user) client.close(4001, 'auth timeout'); }, 5000);

    const refresh = async () => {
      if (!user || Date.now() - refreshedAt < 5000) return;
      refreshedAt = Date.now();
      allowed = await accessibleInstanceIds(user);
    };

    const onEvent = async (ev: PlatformEvent) => {
      if (!user || client.readyState !== WebSocket.OPEN) return;
      await refresh();
      if (ev.type === 'task.cancel') return; // internal
      if (ev.type === 'notification.created') { if (ev.userId === user.id) client.send(JSON.stringify(ev)); return; }
      // Tasks: visible on a granted device or to their owner (same rule as GET /api/tasks).
      const id = ev.type === 'instance.updated' ? ev.instance.id : ev.type === 'instance.deleted' ? ev.instanceId : ev.type === 'task.log' ? ev.instanceId : ev.task.instanceId;
      const owner = ev.type === 'task.updated' ? ev.task.createdBy : ev.type === 'task.log' ? ev.createdBy : null;
      if (allowed === 'all' || (id && allowed.has(id)) || (owner && owner === user.id)) client.send(JSON.stringify(ev));
    };

    client.on('message', async (raw) => {
      if (user) return;
      try {
        const msg = JSON.parse(raw.toString()) as { type?: string; token?: string };
        if (msg.type !== 'auth' || !msg.token) throw new Error();
        user = await app.userFromToken(msg.token);
        refreshedAt = 0;
        await refresh();
        clearTimeout(authTimer);
        events.on('event', onEvent);
        client.send(JSON.stringify({ type: 'ready' }));
      } catch {
        client.close(4001, 'unauthorized');
      }
    });

    client.on('close', () => {
      clearTimeout(authTimer);
      events.off('event', onEvent);
    });
  });
};
