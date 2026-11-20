import type { Instance } from '../../db/schema.js';
import { adb, stf } from '../../services.js';
import { importFromDevice } from '../library/library.js';
import { queueRequiredAppsCheck } from '../library/required.js';
import { getMedia, withMediaFile } from '../media/media.js';
import { mediaTarget } from '../../adapters/adb.js';
import { deleteInstanceRow, getInstance, updateInstance } from './repo.js';
import { sourceOf } from '../sources/index.js';

const BOOT_TIMEOUT_MS = 180_000;
const STF_TIMEOUT_MS = 90_000;
/** A cloud phone's cold boot takes about a minute. */
const POWER_TIMEOUT_MS = 240_000;

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

/** adb connect -> boot via adb getprop -> wait for STF -> claim for the service account. */
async function attachDevice(inst: Instance): Promise<void> {
  const serial = adb.serialFor(inst.adbPort);
  await waitUntil('adb connection', async () => {
    await adb.ensureConnected(inst.adbPort, (await adb.states()).get(serial));
    return (await adb.states()).get(serial) === 'device';
  }, BOOT_TIMEOUT_MS);
  await updateInstance(inst.id, { adbState: 'device' });
  await waitUntil('Android boot', () => adb.bootCompleted(inst.adbPort), BOOT_TIMEOUT_MS);
  await updateInstance(inst.id, { bootCompleted: true });
  // Locale/time zone belong to the source (e.g. BitBrowser re-applies its profile on every boot): never set
  // here. The screen size is the phone's, recorded for the player.
  const screen = await adb.screenSize(inst.adbPort).catch(() => null);
  if (screen) await updateInstance(inst.id, { spec: { ...inst.spec, ...screen } });

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
  (await sourceOf(inst).catch(() => null))?.driver.closeAdb(inst.id);
  await updateInstance(inst.id, { adbState: null, stfReady: false, bootCompleted: false });
}

// Every device is a phone of a device source (modules/sources; redroid containers were removed on 2026-11-20):
// power goes through the source's driver (may be billed while on), adb through the connection the driver keeps
// (SSH tunnel, TCP forward). Deleting the device only removes it from this platform; the phone is left as it is.

async function waitPower(inst: Instance, on: boolean): Promise<void> {
  const { driver, cfg } = await sourceOf(inst);
  if (!driver.power) return;
  await waitUntil(on ? 'phone power-on' : 'phone shutdown', async () => (await driver.power!.isOn(cfg, inst.externalId!)) === on, POWER_TIMEOUT_MS, 3000);
}

/**
 * adb connection → adb → STF, then the 必装应用 check (its own task). A source's adb info can lag a fresh boot,
 * so it is retried for a while.
 */
async function attachExternal(inst: Instance): Promise<void> {
  const { driver, cfg, target } = await sourceOf(inst);
  await waitUntil('adb connection to the phone', async () => { await driver.openAdb(cfg, target); return true; }, 120_000, 5000);
  await attachDevice(inst);
  await queueRequiredAppsCheck(inst, inst.createdBy);
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

export const opCreate = (id: string) => extCreate(id);
export const opStart = (id: string) => extStart(id);
export const opStop = (id: string) => extStop(id);

export async function opRestart(id: string): Promise<void> {
  await updateInstance(id, { status: 'restarting', lastError: null });
  await extStop(id);
  await extStart(id);
}

export async function opDelete(id: string): Promise<void> {
  const inst = await getInstance(id);
  if (!inst) return;
  await updateInstance(id, { status: 'deleting', lastError: null });
  await detachDevice(inst);
  await deleteInstanceRow(id);
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
