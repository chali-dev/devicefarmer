import type { FastifyBaseLogger } from 'fastify';
import { config } from '../../config.js';
import { db, schema } from '../../db/index.js';
import type { Instance } from '../../db/schema.js';
import { getProfile } from '../../profiles.js';
import { adb, dockerHost, network, stf } from '../../services.js';
import { checkGoogleHealth } from '../google/health.js';
import { updateInstance } from '../instances/repo.js';

const BUSY: Instance['status'][] = ['creating', 'starting', 'stopping', 'restarting', 'deleting'];
const GOOGLE_CHECK_MS = 60_000;
const PROXY_CHECK_MS = 5 * 60_000;

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
      const instances = await db.select().from(schema.instances);
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
          if (inst.adbState !== null) patch.adbState = null;
          if (inst.bootCompleted) patch.bootCompleted = false;
          if (inst.stfReady) patch.stfReady = false;
        } else if (inst.netContainerId && netStates.get(inst.id) !== 'running') {
          // Android without its network sidecar has no network at all (namespace owner gone).
          if (inst.status !== 'error') { patch.status = 'error'; patch.lastError = '网络边车未运行（请重启实例）'; }
        } else {
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
          if (inst.containerId !== c.containerId) patch.containerId = c.containerId;
          // Google services health for GApps profiles, at most once a minute.
          const due = !inst.google || Date.now() - Date.parse(inst.google.checkedAt) > GOOGLE_CHECK_MS;
          const proxyDue = inst.proxy && inst.netContainerId && (!inst.proxyStatus || Date.now() - Date.parse(inst.proxyStatus.checkedAt) > PROXY_CHECK_MS);
          if (proxyDue && booted) patch.proxyStatus = await network.check(inst.netContainerId!);
          if (getProfile(inst.profile)?.gapps && booted && adbState === 'device' && due) {
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
  return () => clearInterval(timer);
}
