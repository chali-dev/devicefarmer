import { Adb, type Client } from '@devicefarmer/adbkit';
import { config } from '../config.js';

/**
 * Talks to the adb server shared with STF. Attaching a device here
 * (`adb connect`) is what makes STF's provider pick it up.
 */
/** Installed by STF on every device; removing them breaks screen/input. */
const PROTECTED_PREFIXES = ['jp.co.cyberagent.stf'];
export function isProtectedPackage(pkg: string): boolean {
  return PROTECTED_PREFIXES.some((p) => pkg === p || pkg.startsWith(`${p}.`));
}

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
    await this.shell(adbPort, `content call --uri content://media --method scan_file --arg '${remotePath}'`);
  }

  /**
   * Starts the secure capture helper (CpCapture via app_process as the system user) if it
   * isn't listening yet, and returns a stream of [int32 len][JPEG] frames.
   * Requires a userdebug build with `su` (redroid).
   */
  async openSecureCapture(adbPort: number, dexPath: string, fps = 10, quality = 70): Promise<import('node:stream').Duplex> {
    const SOCK = 'cloudphone-capture';
    const listening = async () => (await this.shell(adbPort, `grep -c '@${SOCK}$' /proc/net/unix`)).trim() !== '0';
    if (!(await listening())) {
      await this.push(adbPort, dexPath, '/data/local/tmp/cpcapture.dex');
      await this.shell(adbPort, 'chmod 644 /data/local/tmp/cpcapture.dex');
      // Detached (all fds redirected, or `adb shell` waits for it); runs as uid 1000 so
      // SurfaceFlinger honours captureSecureLayers.
      await this.shell(adbPort, `su 1000 sh -c 'CLASSPATH=/data/local/tmp/cpcapture.dex nohup app_process / CpCapture ${SOCK} ${fps} ${quality} </dev/null >/dev/null 2>&1 &'`);
      const deadline = Date.now() + 10_000;
      while (!(await listening())) {
        if (Date.now() > deadline) throw new Error('secure capture helper did not start');
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
