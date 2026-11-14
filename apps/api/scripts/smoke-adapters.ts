/**
 * Real integration smoke test for the adapters (no mocks):
 * Docker (redroid) -> adb connect -> STF ready -> claim -> input via STF websocket -> teardown.
 * Usage: npx tsx --env-file=../../.env scripts/smoke-adapters.ts
 */
import Docker from 'dockerode';
import { createAdb } from '../src/adapters/adb.js';
import { dockerFromEnv } from '../src/adapters/runtime/docker.js';
import { runtimeFor } from '../src/adapters/runtime/index.js';
import { createStf } from '../src/adapters/stf.js';
import { config } from '../src/config.js';

const NAME = 'smoke-adapters';
const PORT = 5600;
const runtime = runtimeFor('redroid');
const adb = createAdb();
const stf = createStf();
const docker: Docker = dockerFromEnv(config.DOCKER_HOST);
const serial = adb.serialFor(PORT);

async function waitFor<T>(label: string, fn: () => Promise<T | false | null | undefined>, timeoutMs = 180_000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) { console.log(`  ✓ ${label} (${((Date.now() - t0) / 1000).toFixed(1)}s)`); return v; }
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout: ${label}`);
    await new Promise((r) => setTimeout(r, 2000));
  }
}

async function sh(containerId: string, cmd: string): Promise<string> {
  const exec = await docker.getContainer(containerId).exec({ Cmd: ['sh', '-c', cmd], AttachStdout: true, Tty: true });
  const s = await exec.start({ hijack: true, stdin: false, Tty: true });
  return new Promise((resolve) => { let b = ''; s.on('data', (d: Buffer) => (b += d)); s.on('end', () => resolve(b.trim())); });
}

let containerId: string | undefined;
try {
  console.log('1. create + start container');
  ({ containerId } = await runtime.create({ instanceId: '00000000-0000-0000-0000-000000000001', name: NAME, image: config.REDROID_IMAGE, adbPort: PORT, spec: { width: 720, height: 1280, dpi: 320 } }));
  await runtime.start(containerId);
  console.log('2. adb connect + boot (via adb, engine-agnostic)');
  await waitFor('adb device', async () => { await adb.connect(PORT); return (await adb.states()).get(serial) === 'device'; });
  await waitFor('boot_completed', () => adb.bootCompleted(PORT));

  console.log('3. STF');
  const dev = await waitFor('STF present+ready', async () => { const d = await stf.getDevice(serial); return d?.present && d.ready ? d : null; });
  await stf.claim(serial);
  const owned = await stf.getDevice(serial);
  console.log(`  owner=${owned?.owner?.email} channel=${owned?.channel ? 'yes' : 'no'} screen=${owned?.display?.url}`);
  if (owned?.owner?.email !== config.STF_SERVICE_EMAIL) throw new Error('claim failed');
  // The channel changes on claim (group channel): always use the post-claim value.
  const channel = owned.channel;
  if (!channel) throw new Error('no device channel');
  console.log(`  channel changed on claim: ${dev.channel !== channel}`);

  console.log('4. input via STF websocket');
  const top = () => sh(containerId!, 'dumpsys activity activities | grep -m1 -E \"mResumedActivity|ResumedActivity:\"');
  await waitFor('launcher in foreground', async () => (await top()).includes('launcher'), 120_000);
  // 4a. key event (layout independent). Note: redroid ignores KEYCODE_SETTINGS, so open Settings via am.
  await sh(containerId!, 'am start -a android.settings.SETTINGS');
  await waitFor('Settings opened (setup via am)', async () => (await top()).includes('settings'), 20_000);
  await stf.key(channel, 'press', 'home');
  await waitFor('key "home" via STF -> launcher', async () => (await top()).includes('launcher'), 20_000);
  await new Promise((r) => setTimeout(r, 1500));
  // 4b. touch: Gallery icon centre on the stock redroid launcher, in device pixels (720x1280).
  // (uiautomator dump does not work on redroid, so the position is fixed.)
  // Launcher layout differs per Android version (measured from screenshots at 720x1280).
  const release = await sh(containerId!, 'getprop ro.build.version.release');
  const LAYOUT: Record<string, { gallery: [number, number]; search: [number, number] }> = {
    '12': { gallery: [277, 799], search: [400, 172] },
    '13': { gallery: [274, 860], search: [400, 186] },
  };
  const layout = LAYOUT[release] ?? LAYOUT['12']!;
  console.log(`  Android ${release}`);
  const label = 'Gallery', pkg = 'gallery';
  const x = layout.gallery[0] / 720, y = layout.gallery[1] / 1280;
  await stf.tap(channel, x, y);
  console.log('  ' + await waitFor(`tap opened ${label}`, async () => { const a = await top(); return a.toLowerCase().includes(pkg) ? a : null; }, 20_000));
  // 4c. text: open search box and type a whole string in one message
  await stf.key(channel, 'press', 'home');
  await waitFor('back to launcher', async () => (await top()).includes('launcher'), 20_000);
  await new Promise((r) => setTimeout(r, 800));
  await stf.tap(channel, layout.search[0] / 720, layout.search[1] / 1280); // Google search widget
  await waitFor('search activity', async () => (await top()).includes('quicksearchbox'), 20_000);
  await new Promise((r) => setTimeout(r, 800));
  // Per-key typing races on redroid, so text goes through the clipboard paste transaction.
  await stf.paste(channel, 'cloudphone 123');
  console.log('  ✓ paste transaction acknowledged by device');
  await new Promise((r) => setTimeout(r, 1000));
  const shot = await sh(containerId!, 'screencap -p /data/local/tmp/s.png && echo ok');
  if (shot === 'ok') {
    const { execFileSync } = await import('node:child_process');
    const fs = await import('node:fs');
    fs.mkdirSync('var/smoke', { recursive: true });
    const exec = await docker.getContainer(containerId!).getArchive({ path: '/data/local/tmp/s.png' });
    const tar = await new Promise<Buffer>((res) => { const c: Buffer[] = []; exec.on('data', (d: Buffer) => c.push(d)); exec.on('end', () => res(Buffer.concat(c))); });
    fs.writeFileSync('var/smoke/paste.tar', tar);
    execFileSync('tar', ['-xf', 'var/smoke/paste.tar', '-C', 'var/smoke']);
    console.log('  screenshot: apps/api/var/smoke/s.png');
  }
  await stf.key(channel, 'press', 'home');

  console.log('SMOKE OK');
} finally {
  console.log('teardown');
  await stf.release(serial);
  await adb.disconnect(PORT);
  if (containerId) await runtime.remove(containerId);
  await runtime.removeData(NAME);
  stf.close();
}
