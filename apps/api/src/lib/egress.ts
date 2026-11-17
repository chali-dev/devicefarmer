import type { ProxyStatus } from '../db/schema.js';
import { parseKv } from './kv.js';

/**
 * Egress probe as a shell script, run where the device's traffic leaves: in the sidecar's netns
 * (`busybox`: helper container) or on the phone itself over adb (`android`: curl, toybox wget as a
 * fallback). Same steps and output either way: egress IP (ipify), latency of that fetch, DNS, and
 * ipinfo.io geo as one JSON line (best effort: rate limits must not fail the check).
 */
export function egressScript(env: 'busybox' | 'android'): string {
  const fetch = env === 'busybox'
    ? 'g() { wget -qO- -T "$2" "$1" 2>/dev/null; }'
    : 'g() { if command -v curl >/dev/null; then curl -fs -m "$2" "$1" 2>/dev/null; else toybox wget -qO- "$1" 2>/dev/null; fi; }';
  // busybox: nslookup; Android has none, ping exits 2 only when the name does not resolve (or on errors).
  const dns = env === 'busybox'
    ? 'nslookup -timeout=6 www.google.com >/dev/null 2>&1 && dns=1 || dns=0'
    : 'ping -c1 -W3 www.google.com >/dev/null 2>&1; [ $? -ne 2 ] && dns=1 || dns=0';
  return [
    fetch,
    env === 'android' ? 'command -v curl >/dev/null || echo "nocurl=1"' : 'true',
    't0=$(cut -d" " -f1 /proc/uptime)',
    'ip=$(g https://api.ipify.org 12)',
    't1=$(cut -d" " -f1 /proc/uptime)',
    dns,
    'echo "ip=$ip"; echo "t0=$t0"; echo "t1=$t1"; echo "dns=$dns"',
    'if [ -n "$ip" ]; then echo "geo=$(g https://ipinfo.io/json 8 | tr -d \'\\n\')"; fi',
  ].join('; ');
}

/** Parses egressScript's output into the stored shape. `noEgress` is the error text when no IP came back. */
export function parseEgress(out: string, checkedAt: string, noEgress: string): ProxyStatus {
  const kv = parseKv(out);
  const ip = /^\d{1,3}(\.\d{1,3}){3}$/.test(kv.ip ?? '') ? kv.ip! : null;
  const latencyMs = ip && kv.t0 && kv.t1 ? Math.round((Number(kv.t1) - Number(kv.t0)) * 1000) : null;
  const error = ip ? null : kv.nocurl ? 'no egress (curl is not available on the device)' : noEgress;
  return { checkedAt, ok: Boolean(ip), egressIp: ip, latencyMs: Number.isFinite(latencyMs) ? latencyMs : null, dnsOk: kv.dns === '1', error, ...geoOf(kv.geo, ip) };
}

/**
 * country/region/city from ipinfo's JSON (raw text or parsed), only if it describes the IP we saw:
 * ipinfo answers for whoever calls it, which behind a rotating proxy may be another exit.
 */
export function geoOf(raw: string | Record<string, unknown> | null | undefined, ip: string | null): Pick<ProxyStatus, 'country' | 'region' | 'city'> {
  if (!raw || !ip) return {};
  try {
    const g = (typeof raw === 'string' ? JSON.parse(raw) : raw) as Record<string, unknown>;
    if (!g || g.ip !== ip) return {};
    const str = (v: unknown) => (typeof v === 'string' && v ? v.slice(0, 80) : null);
    return { country: str(g.country), region: str(g.region), city: str(g.city) };
  } catch { return {}; }
}
