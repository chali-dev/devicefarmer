import { config } from './config.js';
import { sqlClient } from './db/index.js';
import { events } from './lib/events.js';
import { adb, stf } from './services.js';

/** Dependency health: each check is a real call, nothing is assumed. Used by /api/health and the settings page. */
export async function checkHealth(): Promise<{ ok: boolean; checks: Record<string, string> }> {
  const checks = await Promise.all([
    ['postgres', () => sqlClient`select 1`],
    ['redis', () => events.ping()],
    ['adb', () => adb.states()],
    ['stf', () => stf.listDevices()],
  ].map(async ([name, fn]) => {
    try { await (fn as () => Promise<unknown>)(); return [name, 'ok'] as const; }
    catch (err) { return [name, (err as Error).message] as const; }
  }));
  const result: Record<string, string> = Object.fromEntries(checks);
  return { ok: Object.values(result).every((v) => v === 'ok'), checks: result };
}

const settle = async <T>(p: Promise<T>): Promise<T | null> => { try { return await p; } catch { return null; } };

/** Read-only system information for admins (versions, STF device counts). Never secrets or connection strings. */
export async function systemInfo() {
  const [pg, redis, stfDevices] = await Promise.all([
    settle(sqlClient`show server_version`.then((r) => String(r[0]?.server_version ?? ''))),
    settle(events.serverVersion()),
    settle(stf.listDevices()),
  ]);
  return {
    versions: { node: process.version, postgres: pg, redis },
    env: config.NODE_ENV,
    uptimeSec: Math.round(process.uptime()),
    stf: stfDevices ? { reachable: true, devices: stfDevices.length, present: stfDevices.filter((d) => d.present).length, ready: stfDevices.filter((d) => d.ready).length } : { reachable: false, devices: 0, present: 0, ready: 0 },
  };
}
