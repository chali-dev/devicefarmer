import { Adb, type Client } from '@devicefarmer/adbkit';
import { config } from '../config.js';

/**
 * Talks to the adb server shared with STF. Attaching a device here
 * (`adb connect`) is what makes STF's provider pick it up.
 */
/** Installed by STF on every device; removing them breaks screen/input. */
const PROTECTED_PREFIXES = ['jp.co.cyberagent.stf'];
/**
 * Where an uploaded file lands in the phone's shared storage: images -> Pictures, videos -> Movies,
 * others -> Download, with a unique "<timestamp>-<safe name>" accepted by pushMedia.
 * Keeps letters/digits of any script (e.g. Chinese); no quotes or shell metacharacters.
 */
export function mediaTarget(filename: string, mime: string): { safe: string; folder: 'Pictures' | 'Movies' | 'Download'; remote: string } {
  const safe = filename.normalize('NFC').replace(/[^\p{L}\p{N}._\- ]/gu, '_').slice(-100) || 'upload';
  const folder = mime.startsWith('image/') ? 'Pictures' : mime.startsWith('video/') ? 'Movies' : 'Download';
  return { safe, folder, remote: `/sdcard/${folder}/${Date.now()}-${safe}` };
}

export function isProtectedPackage(pkg: string): boolean {
  return PROTECTED_PREFIXES.some((p) => pkg === p || pkg.startsWith(`${p}.`));
}

const OFFLINE_RECONNECT_MS = 10_000;

export class AdbAdapter {
  private readonly client: Client;

  constructor(host: string, port: number, private readonly deviceHost: string) {
    this.client = Adb.createClient({ host, port });
  }

  serialFor(adbPort: number): string {
    return `${this.deviceHost}:${adbPort}`;
  }

  async connect(adbPort: number): Promise<string> {
    return this.client.connect(this.deviceHost, adbPort);
  }

  /** serial -> since when it has been seen "offline" (see ensureConnected). */
  private readonly offlineSince = new Map<string, number>();

  /**
   * Connects, or repairs a stale connection. When the far end of a TCP adb connection goes away and
   * comes back (e.g. a BitBrowser SSH tunnel renewed on the same local port), the adb server keeps the
   * old transport as "offline" and `adb connect` only answers "already connected", so it never heals.
   * A transport offline for longer than OFFLINE_RECONNECT_MS is dropped and connected again; shorter
   * offline spells are left alone, since adbd briefly reports offline during its handshake at boot.
   */
  async ensureConnected(adbPort: number, state: string | undefined): Promise<void> {
    const serial = this.serialFor(adbPort);
    if (state === 'device') { this.offlineSince.delete(serial); return; }
    if (state === 'offline') {
      const since = this.offlineSince.get(serial) ?? Date.now();
      this.offlineSince.set(serial, since);
      if (Date.now() - since < OFFLINE_RECONNECT_MS) return;
      this.offlineSince.delete(serial);
      await this.disconnect(adbPort);
    }
    await this.connect(adbPort);
  }

  async disconnect(adbPort: number): Promise<void> {
    try {
      await this.client.disconnect(this.deviceHost, adbPort);
    } catch {
      // not connected: fine
    }
  }

  /** serial -> adb state ("device", "offline", "unauthorized", ...) */
  async states(): Promise<Map<string, string>> {
    const devices = await this.client.listDevices();
    return new Map(devices.map((d) => [d.id, d.type]));
  }

  /** Runs a shell command on the device and returns stdout (engine-agnostic). */
  /** Effective screen size and density (`wm` override first, else physical). */
  async screenSize(adbPort: number): Promise<{ width: number; height: number; dpi: number }> {
    const out = await this.shell(adbPort, 'wm size; wm density');
    const pick = (re: RegExp, over: RegExp) => over.exec(out) ?? re.exec(out);
    const size = pick(/Physical size: (\d+)x(\d+)/, /Override size: (\d+)x(\d+)/);
    const dens = pick(/Physical density: (\d+)/, /Override density: (\d+)/);
    if (!size || !dens) throw new Error(`unexpected wm output: ${out.slice(0, 100)}`);
    return { width: Number(size[1]), height: Number(size[2]), dpi: Number(dens[1]) };
  }

  async shell(adbPort: number, command: string, timeoutMs = 15_000): Promise<string> {
    const device = this.client.getDevice(this.serialFor(adbPort));
    const run = async () => {
      const stream = await device.shell(command);
      const chunks: Buffer[] = [];
      for await (const c of stream) chunks.push(c as Buffer);
      return Buffer.concat(chunks).toString('utf8');
    };
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([run(), new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error('adb shell timeout')), timeoutMs); })]);
    } finally {
      clearTimeout(timer);
    }
  }

  async bootCompleted(adbPort: number): Promise<boolean> {
    try {
      return (await this.shell(adbPort, 'getprop sys.boot_completed', 5000)).trim() === '1';
    } catch {
      return false;
    }
  }

  private async push(adbPort: number, localPath: string, remotePath: string): Promise<void> {
    const transfer = await this.client.getDevice(this.serialFor(adbPort)).push(localPath, remotePath);
    await new Promise<void>((resolve, reject) => { transfer.on('end', resolve); transfer.on('error', reject); });
  }

  /** Pushes a file (mode 644) unless the device already has one of the same size at that path. */
  async pushIfMissing(adbPort: number, localPath: string, remotePath: string): Promise<void> {
    if (!/^\/data\/local\/tmp\/[\w.-]+$/.test(remotePath)) throw new Error('invalid target path');
    const { size } = await (await import('node:fs')).promises.stat(localPath);
    const remote = (await this.shell(adbPort, `stat -c %s ${remotePath} 2>/dev/null`)).trim();
    if (remote === String(size)) return;
    await this.push(adbPort, localPath, remotePath);
    await this.shell(adbPort, `chmod 644 ${remotePath}`);
  }

  /** Raw shell / local-socket streams for long-running helpers (adapters/scrcpy.ts). */
  device(adbPort: number) {
    return this.client.getDevice(this.serialFor(adbPort));
  }

  /**
   * Installs one app made of one or more APKs (base + splits) in a single
   * PackageInstaller session (same as `adb install-multiple -r`).
   */
  async installApks(adbPort: number, apkPaths: string[], sizes: number[]): Promise<void> {
    const tmp = `/data/local/tmp/cp-${Date.now()}`;
    await this.shell(adbPort, `mkdir -p ${tmp}`);
    try {
      const remote: string[] = [];
      for (const [i, p] of apkPaths.entries()) {
        const r = `${tmp}/${i}.apk`;
        await this.push(adbPort, p, r);
        remote.push(r);
      }
      const total = sizes.reduce((a, b) => a + b, 0);
      const created = await this.shell(adbPort, `pm install-create -r -S ${total}`);
      const sid = /\[(\d+)\]/.exec(created)?.[1];
      if (!sid) throw new Error(`install-create failed: ${created.trim()}`);
      for (const [i, r] of remote.entries()) {
        const w = await this.shell(adbPort, `pm install-write -S ${sizes[i]} ${sid} ${i}.apk ${r}`, 120_000);
        if (!/Success/.test(w)) {
          await this.shell(adbPort, `pm install-abandon ${sid}`).catch(() => undefined);
          throw new Error(`install-write failed: ${w.trim()}`);
        }
      }
      const c = await this.shell(adbPort, `pm install-commit ${sid}`, 180_000);
      if (!/Success/.test(c)) throw new Error(`install failed: ${c.trim()}`);
    } finally {
      await this.shell(adbPort, `rm -rf ${tmp}`).catch(() => undefined);
    }
  }

  /** User-installed apps with versions (one round trip). Platform components are flagged as protected. */
  async listApps(adbPort: number): Promise<{ package: string; versionName: string | null; versionCode: string | null; protected: boolean }[]> {
    const out = await this.shell(adbPort,
      `for p in $(pm list packages -3 | sed 's/^package://'); do echo "$p|$(dumpsys package $p | grep -m1 versionName= | sed 's/.*versionName=//')|$(dumpsys package $p | grep -m1 versionCode= | sed 's/.*versionCode=\\([0-9]*\\).*/\\1/')"; done`, 60_000);
    return out.split(/\r?\n/).filter((l) => l.includes('|')).map((l) => {
      const [pkg, vn, vc] = l.split('|');
      return { package: pkg!.trim(), versionName: vn?.trim() || null, versionCode: vc?.trim() || null, protected: isProtectedPackage(pkg!.trim()) };
    }).sort((a, b) => a.package.localeCompare(b.package));
  }

  async uninstall(adbPort: number, pkg: string): Promise<void> {
    if (!/^[a-zA-Z0-9_.]{3,150}$/.test(pkg)) throw new Error('invalid package name');
    if (isProtectedPackage(pkg)) throw new Error(`${pkg} is a platform component (remote control) and cannot be uninstalled`);
    const r = await this.shell(adbPort, `pm uninstall ${pkg}`, 60_000);
    if (!/Success/.test(r)) throw new Error(`uninstall failed: ${r.trim()}`);
  }

  /**
   * Copies a file to shared storage and registers it with MediaStore so Gallery and
   * app pickers (e.g. Instagram) see it immediately.
   */
  async pushMedia(adbPort: number, localPath: string, remotePath: string): Promise<void> {
    if (!/^\/sdcard\/(Pictures|Movies|Download)\/[\p{L}\p{N}._\- ]{1,120}$/u.test(remotePath)) throw new Error('invalid target path');
    await this.push(adbPort, localPath, remotePath);
    // Files written through adb sync get indexed as pending (hidden from other apps, no metadata).
    // Selection on _data is not honoured for shell callers, so locate the row by name + folder
    // (names are unique: timestamp prefix), clear is_pending by _id, then rescan for width/height/date.
    const name = remotePath.split('/').pop()!;
    const folder = remotePath.split('/')[2]!;
    const where = `"_display_name='${name}' AND relative_path='${folder}/'"`;
    await this.shell(adbPort, `content call --uri content://media --method scan_file --arg '${remotePath}' >/dev/null`);
    const found = await this.shell(adbPort, `content query --uri content://media/external/file --projection _id --where ${where}`);
    const id = /_id=(\d+)/.exec(found)?.[1];
    if (!id) throw new Error(`file uploaded but not indexed: ${found.trim()}`);
    await this.shell(adbPort, `content update --uri content://media/external/file/${id} --bind is_pending:i:0`);
    await this.shell(adbPort, `content call --uri content://media --method scan_file --arg '${remotePath}' >/dev/null`);
    const row = await this.shell(adbPort, `content query --uri content://media/external/file/${id} --projection is_pending`);
    if (!/is_pending=0/.test(row)) throw new Error(`file uploaded but not visible to apps: ${row.trim()}`);
  }

  /** Running capture helpers: one foreground adb shell stream per device keeps the helper alive. */
  private captureHelpers = new Map<number, import('node:stream').Duplex>();

  /**
   * Ensures the secure capture helper (CpCapture via app_process as the system user) is running
   * and returns a stream of [int32 len][JPEG] frames. The helper runs in the foreground of an adb
   * shell stream held here: backgrounded processes get killed when adbkit's shell connection
   * closes, so the stream's lifetime is the helper's lifetime. Requires userdebug `su` (redroid).
   */
  async openSecureCapture(adbPort: number, dexPath: string, fps = 10, quality = 70): Promise<import('node:stream').Duplex> {
    const SOCK = 'cloudphone-capture';
    const listening = async () => (await this.shell(adbPort, `grep -c '@${SOCK}$' /proc/net/unix`)).trim() !== '0';
    if (!this.captureHelpers.has(adbPort) || !(await listening())) {
      this.captureHelpers.get(adbPort)?.destroy();
      await this.shell(adbPort, `su 0 sh -c 'pkill -f "CpCapture ${SOCK}"' || true`).catch(() => undefined);
      await this.push(adbPort, dexPath, '/data/local/tmp/cpcapture.dex');
      await this.shell(adbPort, 'chmod 644 /data/local/tmp/cpcapture.dex');
      // uid 1000 so SurfaceFlinger honours captureSecureLayers.
      const proc = await this.client.getDevice(this.serialFor(adbPort))
        .shell(`su 1000 sh -c 'CLASSPATH=/data/local/tmp/cpcapture.dex exec app_process / CpCapture ${SOCK} ${fps} ${quality}'`);
      proc.on('data', () => undefined); // drain stdout
      proc.on('close', () => { if (this.captureHelpers.get(adbPort) === proc) this.captureHelpers.delete(adbPort); });
      proc.on('error', () => undefined);
      this.captureHelpers.set(adbPort, proc);
      const deadline = Date.now() + 10_000;
      while (!(await listening())) {
        if (Date.now() > deadline) { proc.destroy(); throw new Error('secure capture helper did not start'); }
        await new Promise((r) => setTimeout(r, 300));
      }
    }
    return this.client.getDevice(this.serialFor(adbPort)).openLocal(`localabstract:${SOCK}`);
  }

  /** Version of an installed package. */
  async packageVersion(adbPort: number, pkg: string): Promise<{ versionName: string | null; versionCode: string } | null> {
    const out = await this.shell(adbPort, `dumpsys package ${pkg} | grep -m2 -E "versionCode=|versionName="`);
    const code = /versionCode=(\d+)/.exec(out)?.[1];
    if (!code) return null;
    return { versionCode: code, versionName: /versionName=(\S+)/.exec(out)?.[1] ?? null };
  }

  /**
   * Copies an installed app's APKs (base + all splits, exactly as installed) to destDir.
   * Returns file names in install order (base first) with sizes and SHA-256.
   */
  async pullApks(adbPort: number, pkg: string, destDir: string): Promise<{ name: string; size: number; sha256: string }[]> {
    if (!/^[a-zA-Z0-9_.]{3,150}$/.test(pkg)) throw new Error('invalid package name');
    const paths = (await this.shell(adbPort, `pm path ${pkg}`)).split(/\r?\n/)
      .map((l) => l.trim()).filter((l) => l.startsWith('package:')).map((l) => l.slice('package:'.length));
    if (!paths.length) throw new Error(`${pkg} is not installed`);
    paths.sort((a, b) => (a.endsWith('/base.apk') ? -1 : b.endsWith('/base.apk') ? 1 : a.localeCompare(b)));
    const { createHash } = await import('node:crypto');
    const fs = await import('node:fs');
    const path = await import('node:path');
    await fs.promises.mkdir(destDir, { recursive: true });
    const device = this.client.getDevice(this.serialFor(adbPort));
    const files: { name: string; size: number; sha256: string }[] = [];
    for (const [i, remote] of paths.entries()) {
      const name = `${i}-${path.basename(remote)}`;
      const transfer = await device.pull(remote);
      const hash = createHash('sha256');
      let size = 0;
      const out = fs.createWriteStream(path.join(destDir, name));
      await new Promise<void>((resolve, reject) => {
        transfer.on('data', (c: Buffer) => { hash.update(c); size += c.length; });
        transfer.on('error', reject);
        out.on('error', reject);
        out.on('finish', resolve);
        transfer.pipe(out);
      });
      files.push({ name, size, sha256: hash.digest('hex') });
    }
    return files;
  }

  /** Full-resolution PNG screenshot. */
  async screenshot(adbPort: number): Promise<Buffer> {
    const stream = await this.client.getDevice(this.serialFor(adbPort)).screencap();
    const chunks: Buffer[] = [];
    for await (const c of stream) chunks.push(c as Buffer);
    return Buffer.concat(chunks);
  }

  async install(adbPort: number, apkPath: string): Promise<void> {
    const ok = await this.client.getDevice(this.serialFor(adbPort)).install(apkPath);
    if (!ok) throw new Error('adb install reported failure');
  }
}

export function createAdb(): AdbAdapter {
  return new AdbAdapter(config.STF_ADB_HOST, config.STF_ADB_PORT, config.ADB_DEVICE_HOST);
}
