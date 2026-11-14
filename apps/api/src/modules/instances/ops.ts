import type { Instance } from '../../db/schema.js';
import { adb, runtimeFor, stf } from '../../services.js';
import { applyDeviceSettings } from './device-settings.js';
import { deleteInstanceRow, getInstance, updateInstance } from './repo.js';

const BOOT_TIMEOUT_MS = 180_000;
const STF_TIMEOUT_MS = 90_000;

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
    await adb.connect(inst.adbPort);
    return (await adb.states()).get(serial) === 'device';
  }, BOOT_TIMEOUT_MS);
  await updateInstance(inst.id, { adbState: 'device' });
  await waitUntil('Android boot', () => adb.bootCompleted(inst.adbPort), BOOT_TIMEOUT_MS);
  await updateInstance(inst.id, { bootCompleted: true });
  // Locale/timezone/name before STF attaches (a locale change restarts the framework).
  await applyDeviceSettings(inst.adbPort, inst.spec);

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
  await updateInstance(inst.id, { adbState: null, stfReady: false, bootCompleted: false });
}

export async function opCreate(id: string): Promise<void> {
  const inst = await mustGet(id);
  await updateInstance(id, { status: 'creating', lastError: null });
  const runtime = runtimeFor(inst.engine);
  const { containerId } = await runtime.create({
    instanceId: inst.id, name: inst.name, image: inst.image, adbPort: inst.adbPort, spec: inst.spec,
  });
  await updateInstance(id, { containerId, status: 'starting' });
  await runtime.start(containerId);
  await attachDevice(await mustGet(id));
}

export async function opStart(id: string): Promise<void> {
  let inst = await mustGet(id);
  const runtime = runtimeFor(inst.engine);
  if (!inst.containerId || (await runtime.state(inst.containerId)) === 'missing') {
    // Container was lost (e.g. host wiped): recreate it on the same data dir.
    const { containerId } = await runtime.create({
      instanceId: inst.id, name: inst.name, image: inst.image, adbPort: inst.adbPort, spec: inst.spec,
    });
    inst = (await updateInstance(id, { containerId }))!;
  }
  await updateInstance(id, { status: 'starting', lastError: null });
  await runtime.start(inst.containerId!);
  await attachDevice(await mustGet(id));
}

export async function opStop(id: string): Promise<void> {
  const inst = await mustGet(id);
  await updateInstance(id, { status: 'stopping', lastError: null });
  await detachDevice(inst);
  if (inst.containerId) await runtimeFor(inst.engine).stop(inst.containerId);
  await updateInstance(id, { status: 'stopped' });
}

export async function opRestart(id: string): Promise<void> {
  await updateInstance(id, { status: 'restarting', lastError: null });
  const inst = await mustGet(id);
  await detachDevice(inst);
  if (inst.containerId) await runtimeFor(inst.engine).stop(inst.containerId);
  await updateInstance(id, { status: 'restarting' });
  await opStart(id);
}

export async function opDelete(id: string): Promise<void> {
  const inst = await getInstance(id);
  if (!inst) return;
  await updateInstance(id, { status: 'deleting', lastError: null });
  await detachDevice(inst);
  const runtime = runtimeFor(inst.engine);
  if (inst.containerId) await runtime.remove(inst.containerId);
  await runtime.removeData(inst.name);
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

export async function opUninstallApp(id: string, pkg: string): Promise<void> {
  const inst = await mustBeRunning(id);
  await adb.uninstall(inst.adbPort, pkg);
}

export async function opApplySettings(id: string): Promise<void> {
  const inst = await mustBeRunning(id);
  await applyDeviceSettings(inst.adbPort, inst.spec);
  // Framework restart (locale) re-creates the STF worker: make sure it is attached again.
  const serial = adb.serialFor(inst.adbPort);
  await waitUntil('STF device ready', async () => { const d = await stf.getDevice(serial); return Boolean(d?.present && d.ready); }, STF_TIMEOUT_MS);
  await stf.claim(serial);
}
