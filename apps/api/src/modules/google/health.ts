import type { GoogleHealth } from '../../db/schema.js';
import { adb } from '../../services.js';

const PKG = {
  gms: 'com.google.android.gms',
  gsf: 'com.google.android.gsf',
  playStore: 'com.android.vending',
  youtube: 'com.google.android.youtube',
} as const;

/**
 * One adb round trip collecting Google services state. Read-only.
 * Account check counts com.google accounts only; names/emails are never read.
 */
const SCRIPT = [
  ...Object.entries(PKG).flatMap(([k, p]) => [
    `echo "${k}.path=$(pm path ${p} 2>/dev/null | head -1)"`,
    `echo "${k}.version=$(dumpsys package ${p} 2>/dev/null | grep -m1 versionName= | sed 's/.*versionName=//')"`,
  ]),
  `echo "gms.pid=$(pidof ${PKG.gms})"`,
  // Real accounts only ("Account {name=..., type=com.google}"); the authenticator line also contains
  // "type=com.google}" and must not be counted. Only the count leaves the device.
  `echo "accounts=$(dumpsys account 2>/dev/null | grep -E '^ *Account \\{name=' | grep -c 'type=com.google}')"`,
  // GSF ID (decimal) = Android ID assigned by GMS check-in; the user registers it themselves at
  // google.com/android/uncertified. GMS private prefs need root: adb shell runs as uid 2000, so use
  // `su 0` (available on redroid userdebug builds) for this single read-only command.
  // Stored as <string name="android_id">N</string> (or value="N" on some GMS versions).
  `echo "gsfid=$(su 0 sed -n -e 's/.*<string name=\"android_id\">\\([0-9-]*\\)<.*/\\1/p' -e 's/.*name=\"android_id\" value=\"\\([0-9-]*\\)\".*/\\1/p' /data/data/com.google.android.gms/shared_prefs/Checkin.xml 2>/dev/null | head -1)"`,
  // PlaybackState.STATE_PLAYING == 3 for the YouTube media session
  `echo "yt.playing=$(dumpsys media_session 2>/dev/null | grep -A12 'package=${PKG.youtube}' | grep -c 'state=PlaybackState {state=3')"`,
].join('; ');

export async function checkGoogleHealth(adbPort: number): Promise<GoogleHealth> {
  const out = await adb.shell(adbPort, SCRIPT, 20_000);
  const kv = new Map<string, string>();
  for (const line of out.split(/\r?\n/)) {
    const i = line.indexOf('=');
    if (i > 0) kv.set(line.slice(0, i).trim(), line.slice(i + 1).trim());
  }
  const installed = (k: string) => (kv.get(`${k}.path`) ?? '').startsWith('package:');
  const version = (k: string) => (installed(k) && kv.get(`${k}.version`)) || null;
  return {
    checkedAt: new Date().toISOString(),
    gms: { installed: installed('gms'), version: version('gms'), running: Boolean(kv.get('gms.pid')) },
    gsf: { installed: installed('gsf'), gsfId: kv.get('gsfid') || null },
    playStore: { installed: installed('playStore'), version: version('playStore') },
    youtube: { installed: installed('youtube'), version: version('youtube'), playing: Number(kv.get('yt.playing') ?? 0) > 0 },
    googleAccounts: Number(kv.get('accounts') ?? 0) || 0,
  };
}
