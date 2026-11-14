import { config } from './config.js';
import { sqlClient } from './db/index.js';
import { events } from './lib/events.js';
import { PROFILES } from './profiles.js';
import { adb, dockerHost, stf } from './services.js';

/** Dependency health: each check is a real call, nothing is assumed. Used by /api/health and the settings page. */
export async function checkHealth(): Promise<{ ok: boolean; checks: Record<string, string>; capabilities: { kvm: boolean } }> {
  const checks = await Promise.all([
    ['postgres', () => sqlClient`select 1`],
    ['redis', () => events.ping()],
    ['docker', () => dockerHost.listStates()],
    ['adb', () => adb.states()],
    ['stf', () => stf.listDevices()],
  ].map(async ([name, fn]) => {
    try { await (fn as () => Promise<unknown>)(); return [name, 'ok'] as const; }
    catch (err) { return [name, (err as Error).message] as const; }
  }));
  const result: Record<string, string> = Object.fromEntries(checks);
  // Capability, not a failure: only the Google emulator engine needs it.
  const kvm = await dockerHost.hasKvm().catch(() => false);
  return { ok: Object.values(result).every((v) => v === 'ok'), checks: result, capabilities: { kvm } };
}

/**
 * Android host capacity: MemAvailable (read through a helper container, so cached for 60 s) and how many
 * more devices of each usable profile fit with the same 512 MiB headroom as the create-time check.
 */
let capCache: { at: number; value: Capacity } | null = null;
export interface Capacity { freeMb: number | null; error: string | null; checkedAt: string; fits: { profile: string; memEstimateMb: number; count: number }[] }
export async function hostCapacity(): Promise<Capacity> {
  if (capCache && Date.now() - capCache.at < 60_000) return capCache.value;
  let freeMb: number | null = null; let error: string | null = null;
  try { freeMb = await dockerHost.memAvailableMb(); } catch (err) { error = (err as Error).message; }
  const value: Capacity = {
    freeMb, error, checkedAt: new Date().toISOString(),
    fits: PROFILES.filter((p) => p.image && !p.blockedReason && !p.requiresKvm)
      .map((p) => ({ profile: p.id, memEstimateMb: p.memEstimateMb, count: freeMb === null ? 0 : Math.max(0, Math.floor((freeMb - 512) / p.memEstimateMb)) })),
  };
  capCache = { at: Date.now(), value };
  return value;
}

const settle = async <T>(p: Promise<T>): Promise<T | null> => { try { return await p; } catch { return null; } };

/** Read-only system information for admins (versions, STF device counts). Never secrets or connection strings. */
export async function systemInfo() {
  const [pg, redis, docker, stfDevices] = await Promise.all([
    settle(sqlClient`show server_version`.then((r) => String(r[0]?.server_version ?? ''))),
    settle(events.serverVersion()),
    settle(dockerHost.docker.version().then((v) => ({ version: v.Version, os: v.Os, arch: v.Arch, kernel: v.KernelVersion ?? null }))),
    settle(stf.listDevices()),
  ]);
  return {
    versions: { node: process.version, postgres: pg, redis, docker },
    env: config.NODE_ENV,
    uptimeSec: Math.round(process.uptime()),
    stf: stfDevices ? { reachable: true, devices: stfDevices.length, present: stfDevices.filter((d) => d.present).length, ready: stfDevices.filter((d) => d.ready).length } : { reachable: false, devices: 0, present: 0, ready: 0 },
  };
}
