import { isNotNull } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { config } from '../../config.js';
import { db, schema } from '../../db/index.js';
import type { Instance } from '../../db/schema.js';
import { getProfile } from '../../profiles.js';
import { adb, dockerHost, network, stf } from '../../services.js';
import { checkGoogleHealth } from '../google/health.js';
import { updateInstance } from '../instances/repo.js';
import { sourceOf } from '../sources/index.js';

const BUSY: Instance['status'][] = ['creating', 'starting', 'stopping', 'restarting', 'deleting'];
const GOOGLE_CHECK_MS = 60_000;
const PROXY_CHECK_MS = 5 * 60_000;
/** External phones' power/adb poll (BitBrowser's client API allows 1 request per second in total). */
const EXT_INTERVAL_MS = 15_000;

type AdbStates = Map<string, string>;
type StfDevices = Map<string, { present?: boolean; ready?: boolean; owner?: { email?: string } | null }>;

/**
 * adb/boot/STF part of the reconciliation, shared by every engine: re-attaches dropped adb
 * connections, claims the device in STF, and marks a device that is up again as running.
 */
async function observeAdb(log: FastifyBaseLogger, inst: Instance, adbStates: AdbStates, stfBySerial: StfDevices, patch: Partial<Instance>): Promise<boolean> {
  const serial = adb.serialFor(inst.adbPort);
  let adbState = adbStates.get(serial) ?? 'disconnected';
  if (adbState !== 'device') {
    // Self-heal: re-attach dropped TCP adb connections.
    await adb.connect(inst.adbPort).catch(() => undefined);
  }
  const booted = adbState === 'device' && (inst.bootCompleted || await adb.bootCompleted(inst.adbPort));
  const dev = stfBySerial.get(serial);
  const stfReady = Boolean(dev?.present && dev.ready) && adbState === 'device';
  if (stfReady && dev?.owner?.email !== config.STF_SERVICE_EMAIL) {
    await stf.claim(serial).catch((err) => log.warn({ err, serial }, 'claim failed'));
  }
  if (adbState === 'disconnected') adbState = 'offline';
  if (inst.adbState !== adbState) patch.adbState = adbState;
  if (inst.bootCompleted !== booted) patch.bootCompleted = booted;
  if (inst.stfReady !== stfReady) patch.stfReady = stfReady;
  // Started outside the platform, or recovered from an error.
  if ((inst.status === 'stopped' || inst.status === 'error') && booted && adbState === 'device') {
    patch.status = 'running';
    patch.lastError = null;
  }
  return booted && adbState === 'device';
}

const clearDevice = (inst: Instance, patch: Partial<Instance>) => {
  if (inst.adbState !== null) patch.adbState = null;
  if (inst.bootCompleted) patch.bootCompleted = false;
  if (inst.stfReady) patch.stfReady = false;
};

/**
 * Reconciles observed state into the DB. STF status lags behind reality
 * (it kept reporting ready while adb was offline), so health is decided by
 * our own checks: Docker state + adb state + boot_completed; STF is advisory.
 */
export function startMonitor(log: FastifyBaseLogger, intervalMs = 5000): () => void {
  let running = false;

  async function tick(): Promise<void> {
    if (running) return;
    running = true;
    try {
      const instances = (await db.select().from(schema.instances)).filter((i) => i.sourceId === null);
      if (instances.length === 0) return;
      const [containers, netStates, adbStates, stfDevices] = await Promise.all([
        dockerHost.listStates(),
        network.listStates(),
        adb.states(),
        stf.listDevices().catch((err) => { log.warn({ err }, 'STF unreachable'); return null; }),
      ]);
      const stfBySerial = new Map((stfDevices ?? []).map((d) => [d.serial, d]));

      for (const inst of instances) {
        if (BUSY.includes(inst.status)) continue;
        const serial = adb.serialFor(inst.adbPort);
        const c = containers.get(inst.id);
        const patch: Partial<Instance> = {};

        if (!c || c.state !== 'running') {
          if (inst.status === 'running') {
            patch.status = c ? 'stopped' : 'error';
            patch.lastError = c ? `container ${c.state} unexpectedly` : 'container missing on Android host';
          }
          clearDevice(inst, patch);
        } else if (inst.netContainerId && netStates.get(inst.id) !== 'running') {
          // Android without its network sidecar has no network at all (namespace owner gone).
          if (inst.status !== 'error') { patch.status = 'error'; patch.lastError = '网络边车未运行（请重启实例）'; }
        } else {
          const booted = await observeAdb(log, inst, adbStates, stfBySerial, patch);
          if (inst.containerId !== c.containerId) patch.containerId = c.containerId;
          // Google services health for GApps profiles, at most once a minute.
          const due = !inst.google || Date.now() - Date.parse(inst.google.checkedAt) > GOOGLE_CHECK_MS;
          const proxyDue = inst.proxyId && inst.netContainerId && (!inst.proxyStatus || Date.now() - Date.parse(inst.proxyStatus.checkedAt) > PROXY_CHECK_MS);
          if (proxyDue && booted) patch.proxyStatus = await network.check(inst.netContainerId!);
          if (getProfile(inst.profile)?.gapps && booted && due) {
            patch.google = await checkGoogleHealth(inst.adbPort).catch((err) => { log.warn({ err, instance: inst.name }, 'google health failed'); return inst.google; });
          }
        }
        if (Object.keys(patch).length) await updateInstance(inst.id, patch);
      }
    } catch (err) {
      log.error({ err }, 'monitor tick failed');
    } finally {
      running = false;
    }
  }

  const timer = setInterval(() => void tick(), intervalMs);
  void tick();
  const stopExt = startExternalMonitor(log);
  return () => { clearInterval(timer); stopExt(); };
}

/**
 * External phones (device sources): power state from the source's driver, then its adb connection,
 * then the shared adb/STF reconciliation. A phone switched off outside the platform becomes
 * `stopped`; one switched on outside it is attached and becomes `running` once adb sees it booted.
 */
function startExternalMonitor(log: FastifyBaseLogger): () => void {
  let running = false;
  async function tick(): Promise<void> {
    if (running) return;
    running = true;
    try {
      const rows = await db.select().from(schema.instances).where(isNotNull(schema.instances.sourceId));
      if (!rows.length) return;
      const [adbStates, stfDevices] = await Promise.all([adb.states(), stf.listDevices().catch(() => null)]);
      const stfBySerial = new Map((stfDevices ?? []).map((d) => [d.serial, d]));
      for (const inst of rows) {
        if (BUSY.includes(inst.status)) continue;
        const patch: Partial<Instance> = {};
        let src: Awaited<ReturnType<typeof sourceOf>>;
        let on: boolean;
        try {
          src = await sourceOf(inst);
          on = src.driver.power ? await src.driver.power.isOn(src.cfg, inst.externalId!) : true;
        } catch (err) {
          log.warn({ err, instance: inst.name }, 'external phone: power state unavailable');
          continue;
        }
        if (!on) {
          src.driver.closeAdb(inst.id);
          if (inst.status === 'running') { patch.status = 'stopped'; patch.lastError = '手机已在平台外关机'; }
          clearDevice(inst, patch);
        } else {
          try {
            await src.driver.openAdb(src.cfg, src.target);
            await observeAdb(log, inst, adbStates, stfBySerial, patch);
          } catch (err) {
            log.warn({ err, instance: inst.name }, 'external phone: adb connection failed');
            if (inst.adbState !== 'offline') patch.adbState = 'offline';
            if (inst.stfReady) patch.stfReady = false;
          }
        }
        if (Object.keys(patch).length) await updateInstance(inst.id, patch);
      }
    } catch (err) {
      log.error({ err }, 'external monitor tick failed');
    } finally {
      running = false;
    }
  }
  const timer = setInterval(() => void tick(), EXT_INTERVAL_MS);
  void tick();
  return () => clearInterval(timer);
}
