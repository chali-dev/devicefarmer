import type { Instance } from '../../db/schema.js';
import { adb, network, runtimeFor, stf } from '../../services.js';
import { applyDeviceSettings } from './device-settings.js';
import { importFromDevice, libraryAppsByIds, libraryInstallJob, libraryTaskRef, preinstallApps } from '../library/library.js';
import { enqueue } from './queue.js';
import { getMedia, withMediaFile } from '../media/media.js';
import { mediaTarget } from '../../adapters/adb.js';
import { deleteInstanceRow, getInstance, updateInstance } from './repo.js';
import { resolveProxyConfig } from '../proxies/pool.js';
import { conflict } from '../../lib/errors.js';
import { sourceOf } from '../sources/index.js';

const BOOT_TIMEOUT_MS = 180_000;
const STF_TIMEOUT_MS = 90_000;
/** External phones: a cloud phone's cold boot takes about a minute. */
const EXT_POWER_TIMEOUT_MS = 240_000;

/** A phone from a device source (modules/sources) rather than a local container. */
const isExternal = (inst: Instance) => inst.sourceId !== null;

async function waitUntil(label: string, fn: () => Promise<boolean>, timeoutMs: number, everyMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await fn().catch(() => false)) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

async function mustGet(id: string): Promise<Instance> {
  const inst = await getInstance(id);
  if (!inst) throw new Error('instance no longer exists');
  return inst;
}

/**
 * Device attach is separate from container lifecycle: boot -> adb connect
 * -> wait for STF -> claim for the service account.
 */
async function attachDevice(inst: Instance): Promise<void> {
  // adb first, then boot via adb getprop: identical for redroid and the emulator.
  const serial = adb.serialFor(inst.adbPort);
  await waitUntil('adb connection', async () => {
    await adb.ensureConnected(inst.adbPort, (await adb.states()).get(serial));
    return (await adb.states()).get(serial) === 'device';
  }, BOOT_TIMEOUT_MS);
  await updateInstance(inst.id, { adbState: 'device' });
  await waitUntil('Android boot', () => adb.bootCompleted(inst.adbPort), BOOT_TIMEOUT_MS);
  await updateInstance(inst.id, { bootCompleted: true });
  if (isExternal(inst)) {
    // Locale/time zone of external phones belong to their source (e.g. BitBrowser re-applies its
    // profile on every boot): never set them here. The screen size is the phone's, recorded for the player.
    const screen = await adb.screenSize(inst.adbPort).catch(() => null);
    if (screen) await updateInstance(inst.id, { spec: { ...inst.spec, ...screen } });
  } else {
    // Locale/timezone/name before STF attaches (a locale change restarts the framework).
    await applyDeviceSettings(inst.adbPort, inst.spec);
  }

  await waitUntil('STF device ready', async () => {
    const d = await stf.getDevice(serial);
    return Boolean(d?.present && d.ready);
  }, STF_TIMEOUT_MS);
  await stf.claim(serial);
  await updateInstance(inst.id, { stfReady: true, status: 'running', lastError: null });
}

async function detachDevice(inst: Instance): Promise<void> {
  const serial = adb.serialFor(inst.adbPort);
  await stf.release(serial).catch(() => undefined);
  await adb.disconnect(inst.adbPort);
  if (isExternal(inst)) (await sourceOf(inst).catch(() => null))?.driver.closeAdb(inst.id);
  await updateInstance(inst.id, { adbState: null, stfReady: false, bootCompleted: false });
}

// ---------------------------------------------------------------- external phones (device sources)
// No containers: power goes through the source's driver (may be billed while on), adb through the
// connection the driver keeps (SSH tunnel, TCP forward). Deleting the device only removes it from
// this platform; the phone itself is left as it is.

async function waitPower(inst: Instance, on: boolean): Promise<void> {
  const { driver, cfg } = await sourceOf(inst);
  if (!driver.power) return;
  await waitUntil(on ? 'phone power-on' : 'phone shutdown', async () => (await driver.power!.isOn(cfg, inst.externalId!)) === on, EXT_POWER_TIMEOUT_MS, 3000);
}

/** adb connection → adb → STF. A source's adb info can lag a fresh boot, so it is retried for a while. */
async function attachExternal(inst: Instance): Promise<void> {
  const { driver, cfg, target } = await sourceOf(inst);
  await waitUntil('adb connection to the phone', async () => { await driver.openAdb(cfg, target); return true; }, 120_000, 5000);
  await attachDevice(inst);
}

async function extIsOn(inst: Instance): Promise<boolean> {
  const { driver, cfg } = await sourceOf(inst);
  return driver.power ? driver.power.isOn(cfg, inst.externalId!) : true;
}

async function extStart(id: string): Promise<void> {
  const inst = await mustGet(id);
  await updateInstance(id, { status: 'starting', lastError: null });
  const { driver, cfg } = await sourceOf(inst);
  if (driver.power && !(await driver.power.isOn(cfg, inst.externalId!))) {
    await driver.power.on(cfg, inst.externalId!);
    await waitPower(inst, true);
  }
  await attachExternal(await mustGet(id));
}

async function extStop(id: string): Promise<void> {
  const inst = await mustGet(id);
  await updateInstance(id, { status: 'stopping', lastError: null });
  await detachDevice(inst);
  const { driver, cfg } = await sourceOf(inst);
  if (driver.power && (await driver.power.isOn(cfg, inst.externalId!))) {
    await driver.power.off(cfg, inst.externalId!);
    await waitPower(inst, false);
  }
  await updateInstance(id, { status: 'stopped' });
}

/** Added to the platform: attach when the phone is already on, otherwise stay stopped (power-on may be billed). */
async function extCreate(id: string): Promise<void> {
  const inst = await mustGet(id);
  await updateInstance(id, { status: 'creating', lastError: null });
  if (await extIsOn(inst)) {
    await updateInstance(id, { status: 'starting' });
    await attachExternal(await mustGet(id));
  } else {
    await updateInstance(id, { status: 'stopped' });
  }
}

/** Creates the network sidecar (owns netns + adb port) and the engine container joined to it. */
async function createContainers(inst: Instance): Promise<Instance> {
  const netContainerId = await network.create({ instanceId: inst.id, name: inst.name, adbPort: inst.adbPort }, await resolveProxyConfig(inst.proxyId));
  await updateInstance(inst.id, { netContainerId });
  const { containerId } = await runtimeFor(inst.engine).create({
    instanceId: inst.id, name: inst.name, image: inst.image, adbPort: inst.adbPort, spec: inst.spec, netContainerId,
  });
  return (await updateInstance(inst.id, { containerId }))!;
}

/** Sidecar first (it owns the namespace), then the engine. */
async function startContainers(inst: Instance): Promise<void> {
  if (inst.netContainerId) await network.start(inst.netContainerId);
  await runtimeFor(inst.engine).start(inst.containerId!);
}

/** Engine first, then the sidecar. */
async function stopContainers(inst: Instance): Promise<void> {
  if (inst.containerId) await runtimeFor(inst.engine).stop(inst.containerId);
  if (inst.netContainerId) await network.stop(inst.netContainerId);
}

async function refreshProxyStatus(inst: Instance): Promise<void> {
  if (!inst.proxyId || !inst.netContainerId) { await updateInstance(inst.id, { proxyStatus: null }); return; }
  await updateInstance(inst.id, { proxyStatus: await network.check(inst.netContainerId) });
}

export async function opCreate(id: string, appIds?: string[]): Promise<void> {
  let inst = await mustGet(id);
  if (isExternal(inst)) return extCreate(id);
  await updateInstance(id, { status: 'creating', lastError: null });
  inst = await createContainers(inst);
  await updateInstance(id, { status: 'starting' });
  await startContainers(inst);
  await attachDevice(await mustGet(id));
  await refreshProxyStatus(await mustGet(id));
  // Preinstall library apps as separate, visible tasks (a failed install doesn't fail the create).
  for (const app of appIds ? await libraryAppsByIds(appIds) : await preinstallApps()) {
    await enqueue('install-apk', inst, inst.createdBy, libraryInstallJob(app, true), `预装 ${app.package} ${app.versionName ?? app.versionCode}`, libraryTaskRef(app));
  }
}

export async function opStart(id: string): Promise<void> {
  let inst = await mustGet(id);
  if (isExternal(inst)) return extStart(id);
  const runtime = runtimeFor(inst.engine);
  const engineMissing = !inst.containerId || (await runtime.state(inst.containerId)) === 'missing';
  const netMissing = inst.netContainerId ? (await network.state(inst.netContainerId)) === 'missing' : false;
  if (engineMissing || netMissing) {
    // Containers were lost (e.g. host wiped): recreate them on the same data dir.
    if (inst.containerId) await runtime.remove(inst.containerId);
    if (inst.netContainerId) await network.remove(inst.netContainerId);
    inst = await createContainers(inst);
  }
  await updateInstance(id, { status: 'starting', lastError: null });
  await startContainers(inst);
  await attachDevice(await mustGet(id));
  await refreshProxyStatus(await mustGet(id));
}

export async function opStop(id: string): Promise<void> {
  const inst = await mustGet(id);
  if (isExternal(inst)) return extStop(id);
  await updateInstance(id, { status: 'stopping', lastError: null });
  await detachDevice(inst);
  await stopContainers(inst);
  await updateInstance(id, { status: 'stopped' });
}

export async function opRestart(id: string): Promise<void> {
  await updateInstance(id, { status: 'restarting', lastError: null });
  const inst = await mustGet(id);
  if (isExternal(inst)) { await extStop(id); await extStart(id); return; }
  await detachDevice(inst);
  await stopContainers(inst);
  await updateInstance(id, { status: 'restarting' });
  await opStart(id);
}

export async function opDelete(id: string): Promise<void> {
  const inst = await getInstance(id);
  if (!inst) return;
  await updateInstance(id, { status: 'deleting', lastError: null });
  await detachDevice(inst);
  if (isExternal(inst)) { await deleteInstanceRow(id); return; }
  const runtime = runtimeFor(inst.engine);
  if (inst.containerId) await runtime.remove(inst.containerId);
  if (inst.netContainerId) await network.remove(inst.netContainerId);
  await runtime.removeData(inst.name);
  await deleteInstanceRow(id);
}

/**
 * Applies the instance's bound pool proxy (`proxy_id`, already saved on the row; the pool entry's
 * current host/credentials are read and decrypted here, so it also re-applies edited pool entries).
 * With a sidecar: rewrite config + nft rules, hot reload; Android keeps running.
 * Legacy instance (no sidecar): recreate the engine container joined to a new sidecar
 * on the same /data, restarting it if it was running.
 */
export async function opSetProxy(id: string): Promise<void> {
  let inst = await mustGet(id);
  if (isExternal(inst)) throw conflict('外部手机的代理由其来源设置', 'instances.engine_unsupported', { engine: inst.engine });
  if (inst.netContainerId) {
    await network.apply(inst.name, inst.netContainerId, await resolveProxyConfig(inst.proxyId));
  } else {
    const wasRunning = inst.status === 'running';
    await updateInstance(id, { status: 'restarting', lastError: null });
    await detachDevice(inst);
    if (inst.containerId) {
      await runtimeFor(inst.engine).stop(inst.containerId);
      await runtimeFor(inst.engine).remove(inst.containerId);
    }
    inst = await createContainers(inst);
    if (wasRunning) {
      await startContainers(inst);
      await attachDevice(await mustGet(id));
    } else {
      await updateInstance(id, { status: 'stopped' });
    }
  }
  inst = await mustGet(id);
  if (inst.status === 'running') await refreshProxyStatus(inst);
  else await updateInstance(id, { proxyStatus: null });
}

async function mustBeRunning(id: string): Promise<Instance> {
  const inst = await mustGet(id);
  if (inst.status !== 'running' || inst.adbState !== 'device') throw new Error('instance is not running');
  return inst;
}

/** Installs/updates one app (base + splits). Upload files are shared by batch tasks and cleaned up by age. */
export async function opInstallApk(id: string, apkPaths: string[], sizes: number[]): Promise<void> {
  const inst = await mustBeRunning(id);
  await adb.installApks(inst.adbPort, apkPaths, sizes);
}

/** Copies an installed app (e.g. from Google Play) from this instance into the app library. */
export async function opImportApp(id: string, pkg: string): Promise<void> {
  const inst = await mustBeRunning(id);
  await importFromDevice(inst.adbPort, pkg, inst.name);
}

/**
 * Copies a media-library file into the device's shared storage (Pictures/Movies by type), over
 * adb from the API host (never through the device's proxy). The device-side name is the asset's
 * display name with the canonical extension of its verified format.
 */
export async function opPushAsset(id: string, assetId: string): Promise<void> {
  const inst = await mustBeRunning(id);
  const asset = await getMedia(assetId);
  if (!asset) throw new Error('media asset no longer exists');
  const ext = asset.fileKey.split('.').pop()!;
  const { remote } = mediaTarget(`${asset.name}.${ext}`, asset.mimeType);
  await withMediaFile(asset, (local) => adb.pushMedia(inst.adbPort, local, remote));
}

export async function opUninstallApp(id: string, pkg: string): Promise<void> {
  const inst = await mustBeRunning(id);
  await adb.uninstall(inst.adbPort, pkg);
}

export async function opApplySettings(id: string): Promise<void> {
  const inst = await mustBeRunning(id);
  if (isExternal(inst)) throw conflict('外部手机的语言/时区由其来源设置', 'instances.engine_unsupported', { engine: inst.engine });
  await applyDeviceSettings(inst.adbPort, inst.spec);
  // Framework restart (locale) re-creates the STF worker: make sure it is attached again.
  const serial = adb.serialFor(inst.adbPort);
  await waitUntil('STF device ready', async () => { const d = await stf.getDevice(serial); return Boolean(d?.present && d.ready); }, STF_TIMEOUT_MS);
  await stf.claim(serial);
}
