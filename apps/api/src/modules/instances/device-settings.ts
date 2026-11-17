import { z } from 'zod';
import type { InstanceSpec } from '../../db/schema.js';
import { adb } from '../../services.js';

/**
 * Device parameters limited to what Android itself exposes as user/system settings.
 * Hardware identity (model, IMEI, fingerprint) is intentionally NOT configurable.
 */
export const DeviceSettings = z.object({
  /** BCP-47 like "zh-CN", "en-US" */
  locale: z.string().regex(/^[a-z]{2,3}(-[A-Z]{2}|-[A-Za-z]{4}(-[A-Z]{2})?)?$/, 'e.g. zh-CN, en-US').optional(),
  /** IANA zone, validated against the runtime's zone list */
  timezone: z.string().refine((tz) => Intl.supportedValuesOf('timeZone').includes(tz) || tz === 'UTC', 'unknown IANA time zone').optional(),
  /** Shown in Settings > About / Bluetooth / network name */
  deviceName: z.string().regex(/^[\w .-]{1,40}$/, 'letters, digits, space, . _ -').optional(),
});
export type DeviceSettings = z.infer<typeof DeviceSettings>;

async function waitFrameworkUp(adbPort: number, timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  await new Promise((r) => setTimeout(r, 3000)); // let zygote go down first
  for (;;) {
    const out = await adb.shell(adbPort, 'getprop sys.boot_completed; pidof system_server; getprop init.svc.bootanim', 5000).catch(() => '');
    const [boot, pid, anim] = out.split(/\r?\n/).map((s) => s.trim());
    if (boot === '1' && pid && anim !== 'running') return;
    if (Date.now() > deadline) throw new Error('framework did not come back after locale change');
    await new Promise((r) => setTimeout(r, 2000));
  }
}

/**
 * Applies settings idempotently. Values persist in /data (persist.* props, settings db),
 * so they survive restarts; this is re-run after every boot to converge drift.
 * Only a locale change restarts the Android framework (zygote), not the container or adbd.
 */
export async function applyDeviceSettings(adbPort: number, spec: InstanceSpec): Promise<void> {
  // Locale first: it restarts the framework, and SettingsProvider persists writes asynchronously,
  // so settings written just before a zygote restart can be lost.
  if (spec.locale) {
    const cur = (await adb.shell(adbPort, 'getprop persist.sys.locale')).trim();
    if (cur !== spec.locale) {
      await adb.shell(adbPort, `su 0 setprop persist.sys.locale ${spec.locale} && su 0 setprop ctl.restart zygote`);
      await waitFrameworkUp(adbPort);
    }
  }
  if (spec.timezone) {
    const cur = (await adb.shell(adbPort, 'getprop persist.sys.timezone')).trim();
    if (cur !== spec.timezone) await adb.shell(adbPort, `cmd alarm set-timezone ${spec.timezone}`);
  }
  if (spec.deviceName) {
    await adb.shell(adbPort, `settings put global device_name '${spec.deviceName.replace(/'/g, '')}'`);
  }
}

/** Reads back what the device actually uses (for verification and the UI). */
export async function readDeviceSettings(adbPort: number) {
  const out = await adb.shell(adbPort, [
    'echo "locale=$(getprop persist.sys.locale)"',
    'echo "timezone=$(getprop persist.sys.timezone)"',
    'echo "deviceName=$(settings get global device_name)"',
    'echo "androidId=$(settings get secure android_id)"',
    'echo "model=$(getprop ro.product.model)"',
    'echo "release=$(getprop ro.build.version.release)"',
    // /sys/class/net/*/address and `ip link show <if>` are denied to shell on recent Android; the full
    // `ip -o link` dump is not. wlan0 first (real phones), else eth0 (redroid has no Wi-Fi interface).
    'l=$(ip -o link 2>/dev/null); for i in wlan0 eth0; do m=$(echo "$l" | grep -E "^[0-9]+: $i[:@]" | grep -o "link/ether [0-9a-f:]*" | cut -d" " -f2); if [ -n "$m" ]; then echo "mac=$m"; echo "macIf=$i"; break; fi; done',
  ].join('; '));
  const kv: Record<string, string> = {};
  for (const l of out.split(/\r?\n/)) { const i = l.indexOf('='); if (i > 0) kv[l.slice(0, i)] = l.slice(i + 1).trim(); }
  return kv;
}
