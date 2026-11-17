import { Redis } from 'ioredis';
import { EventEmitter } from 'node:events';
import { config } from '../config.js';
import type { Notification, Task, TaskLog } from '../db/schema.js';
import type { PublicInstance } from '../modules/instances/repo.js';

export type PlatformEvent =
  | { type: 'instance.updated'; instance: PublicInstance }
  | { type: 'instance.deleted'; instanceId: string }
  | { type: 'task.updated'; task: PublicTask }
  /** A handler/transition log line; carries the task's RBAC keys so /api/events can filter it. */
  | { type: 'task.log'; taskId: string; instanceId: string | null; createdBy: string | null; log: TaskLog }
  /** Internal (never forwarded to browsers): ask whichever worker runs the task to abort its signal. */
  | { type: 'task.cancel'; taskId: string }
  /** In-app alert (modules/notify): forwarded only to `userId`. */
  | { type: 'notification.created'; userId: string; notification: Notification };

/** Task row as broadcast and listed: payload/result only come with GET /api/tasks/:id. */
export type PublicTask = Omit<Task, 'payload' | 'result'>;

/**
 * Redis pub/sub ignores the DB number, so the channel carries it: environments that share
 * one Redis on different DBs (parallel worktrees) don't receive each other's events.
 */
const CHANNEL = `cloudphone:events:${new URL(config.REDIS_URL).pathname.replace(/^\//, '') || '0'}`;

/**
 * Event bus over Redis pub/sub so that API and worker processes can be split
 * later (scale-out) without changing producers or the WebSocket gateway.
 */
class EventBus extends EventEmitter {
  private pub = new Redis(config.REDIS_URL, { lazyConnect: true });
  private sub = new Redis(config.REDIS_URL, { lazyConnect: true });
  private started = false;

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await Promise.all([this.pub.connect(), this.sub.connect()]);
    await this.sub.subscribe(CHANNEL);
    this.sub.on('message', (_ch, raw) => {
      try { this.emit('event', JSON.parse(raw) as PlatformEvent); } catch { /* ignore malformed */ }
    });
  }

  publish(ev: PlatformEvent): void {
    void this.pub.publish(CHANNEL, JSON.stringify(ev));
  }

  ping(): Promise<string> {
    return this.pub.ping();
  }

  /** redis_version from INFO server (system info page). */
  async serverVersion(): Promise<string | null> {
    return /redis_version:(\S+)/.exec(await this.pub.info('server'))?.[1] ?? null;
  }

  async close(): Promise<void> {
    await Promise.allSettled([this.pub.quit(), this.sub.quit()]);
  }
}

export const events = new EventBus();
events.setMaxListeners(1000);
