import { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';

/**
 * Background-work leadership for blue-green deploys (BACKGROUND_WORK=leader): during the overlap two API
 * processes run, but task workers, the monitor (which also owns the BitBrowser ssh tunnels on fixed ports)
 * and the schedulers must run in one of them only. The leader holds a Redis lease (SET NX PX), renews it
 * every RENEW_MS and deletes it as the very last step of a graceful shutdown; a standby polls and takes
 * over. If a renewal finds the lease owned by someone else (it expired, e.g. after a long Redis outage),
 * the process exits: its restart policy brings it back as a standby, never two leaders.
 * Like the event channel, the key carries the Redis DB number.
 */
const KEY = `cloudphone:leader:${new URL(config.REDIS_URL).pathname.replace(/^\//, '') || '0'}`;
const TTL_MS = 15_000;
const RENEW_MS = 5_000;
const POLL_MS = 2_000;

const RENEW = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end";
const RELEASE = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

interface Log { info(o: object, m: string): void; warn(o: object, m: string): void; fatal(o: object, m: string): void }

export interface Leadership {
  isLeader(): boolean;
  /** Stops polling/renewing and releases the lease (if held). Call after the background work stopped. */
  release(): Promise<void>;
}

export function startLeaderElection(log: Log, onAcquire: () => Promise<void>): Leadership {
  const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 2 });
  const id = `${config.DEPLOY_COLOR ?? 'api'}:${config.APP_VERSION ?? 'dev'}:${process.pid}:${randomUUID().slice(0, 8)}`;
  let leader = false;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;

  const schedule = (ms: number) => { if (!stopped) timer = setTimeout(() => void tick(), ms); };
  async function tick(): Promise<void> {
    try {
      if (!leader) {
        if (await redis.set(KEY, id, 'PX', TTL_MS, 'NX') === 'OK') {
          leader = true;
          log.info({ id }, 'background work: leadership acquired');
          // Not awaited: renewals must keep running while the background work starts up.
          void onAcquire().catch((err) => { log.fatal({ err }, 'background work: start failed, exiting'); process.exit(1); });
        }
      } else if (Number(await redis.eval(RENEW, 1, KEY, id, TTL_MS)) !== 1) {
        log.fatal({ id, holder: await redis.get(KEY).catch(() => null) }, 'background work: leadership lost, exiting');
        process.exit(1);
      }
    } catch (err) {
      log.warn({ err }, 'background work: leadership check failed');
    }
    schedule(leader ? RENEW_MS : POLL_MS);
  }
  void tick();

  return {
    isLeader: () => leader,
    async release() {
      stopped = true;
      clearTimeout(timer);
      if (leader) await redis.eval(RELEASE, 1, KEY, id).catch(() => undefined);
      leader = false;
      await redis.quit().catch(() => undefined);
    },
  };
}
