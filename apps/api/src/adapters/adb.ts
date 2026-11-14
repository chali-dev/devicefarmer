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
