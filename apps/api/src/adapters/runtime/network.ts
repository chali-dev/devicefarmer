import path from 'node:path';
import type { ProxyConfig, ProxyStatus } from '../../db/schema.js';
import { buildConfig, buildRules, START_SCRIPT } from '../../modules/network/singbox.js';
import type { DockerHost } from './docker.js';
import { parseKv } from '../../lib/kv.js';

const NET_LABEL = 'cloudphone.net';

/**
 * Per-instance network sidecar (sing-box). It owns the instance's network namespace
 * and adb port mapping; the Android container joins it. Proxy changes are applied by
 * rewriting config + nft rules and SIGHUP (no Android restart).
 */
export class NetworkSidecar {
  constructor(private readonly host: DockerHost, private readonly image: string) {}

  private dir(name: string): string {
    return path.posix.join(this.host.instanceDir(name), 'net');
  }

  private async writeConfig(name: string, proxy: ProxyConfig | null): Promise<void> {
    await this.host.writeFiles(this.dir(name), {
      'config.json': { content: JSON.stringify(buildConfig(proxy), null, 2), mode: '600' }, // may hold proxy credentials
      'rules.nft': { content: buildRules(proxy, await this.host.bridgeSubnet()), mode: '644' },
      'start.sh': { content: START_SCRIPT, mode: '755' },
    });
  }

  async create(input: { instanceId: string; name: string; adbPort: number }, proxy: ProxyConfig | null): Promise<string> {
    await this.writeConfig(input.name, proxy);
    await this.host.ensureImage(this.image);
    const c = await this.host.docker.createContainer({
      name: `cloudphone-${input.name}-net`,
      Image: this.image,
      Entrypoint: ['/etc/cloudphone/start.sh'],
      ExposedPorts: { '5555/tcp': {} },
      Labels: { [NET_LABEL]: input.instanceId, 'cloudphone.name': input.name },
      HostConfig: {
        CapAdd: ['NET_ADMIN'],
        Sysctls: { 'net.ipv6.conf.all.disable_ipv6': '1' },
        Binds: [`${this.dir(input.name)}:/etc/cloudphone:ro`],
        PortBindings: { '5555/tcp': [{ HostIp: '0.0.0.0', HostPort: String(input.adbPort) }] },
        RestartPolicy: { Name: 'no' },
        Memory: 64 * 1024 * 1024,
      },
    });
    return c.id;
  }

  /** Switch proxy on a running or stopped sidecar without touching the Android container. */
  async apply(name: string, netContainerId: string, proxy: ProxyConfig | null): Promise<void> {
    await this.writeConfig(name, proxy);
    if ((await this.host.containerState(netContainerId)) !== 'running') return; // picked up on next start
    await this.host.exec(netContainerId, ['nft', '-f', '/etc/cloudphone/rules.nft']);
    await this.host.signal(netContainerId, 'SIGHUP');
  }

  /** instanceId -> sidecar state */
  async listStates(): Promise<Map<string, string>> {
    const list = await this.host.docker.listContainers({ all: true, filters: { label: [NET_LABEL] } });
    return new Map(list.filter((c) => c.Labels[NET_LABEL]).map((c) => [c.Labels[NET_LABEL]!, c.State]));
  }

  start(id: string) { return this.host.startContainer(id); }
  stop(id: string) { return this.host.stopContainer(id); }
  remove(id: string) { return this.host.removeContainer(id); }
  state(id: string) { return this.host.containerState(id); }

  /** Egress probe from inside the instance's namespace: same path as Android's traffic. */
  async check(netContainerId: string): Promise<ProxyStatus> {
    const script = [
      't0=$(cut -d" " -f1 /proc/uptime)',
      'ip=$(wget -qO- -T 12 https://api.ipify.org 2>/dev/null)',
      't1=$(cut -d" " -f1 /proc/uptime)',
      'nslookup -timeout=6 www.google.com >/dev/null 2>&1 && dns=1 || dns=0',
      'echo "ip=$ip"; echo "t0=$t0"; echo "t1=$t1"; echo "dns=$dns"',
      // Geo of the egress IP, best effort (rate limits must not fail the check); one line of JSON.
      'if [ -n "$ip" ]; then echo "geo=$(wget -qO- -T 8 https://ipinfo.io/json 2>/dev/null | tr -d \'\\n\')"; fi',
    ].join('; ');
    const checkedAt = new Date().toISOString();
    try {
      const r = await this.host.helper(['sh', '-c', script], [], { netContainerId, timeoutMs: 40_000 });
      const kv = parseKv(r.out);
      const ip = /^\d{1,3}(\.\d{1,3}){3}$/.test(kv.ip ?? '') ? kv.ip! : null;
      const latencyMs = ip ? Math.round((Number(kv.t1) - Number(kv.t0)) * 1000) : null;
      return { checkedAt, ok: Boolean(ip), egressIp: ip, latencyMs, dnsOk: kv.dns === '1', error: ip ? null : 'no egress through proxy (blocked or proxy unreachable)', ...geoOf(kv.geo, ip) };
    } catch (err) {
      return { checkedAt, ok: false, egressIp: null, latencyMs: null, dnsOk: false, error: (err as Error).message };
    }
  }
}

/** country/region/city from ipinfo's JSON, only if it describes the IP we saw (ipinfo answers for the caller). */
function geoOf(raw: string | undefined, ip: string | null): Pick<ProxyStatus, 'country' | 'region' | 'city'> {
  if (!raw || !ip) return {};
  try {
    const g = JSON.parse(raw) as Record<string, unknown>;
    if (g.ip !== ip) return {};
    const str = (v: unknown) => (typeof v === 'string' && v ? v.slice(0, 80) : null);
    return { country: str(g.country), region: str(g.region), city: str(g.city) };
  } catch { return {}; }
}
