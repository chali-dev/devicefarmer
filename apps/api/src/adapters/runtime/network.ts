import path from 'node:path';
import type { ProxyConfig, ProxyStatus } from '../../db/schema.js';
import { buildConfig, buildRules, START_SCRIPT } from '../../modules/network/singbox.js';
import type { DockerHost } from './docker.js';

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
    ].join('; ');
    const checkedAt = new Date().toISOString();
    try {
      const r = await this.host.helper(['sh', '-c', script], [], { netContainerId, timeoutMs: 40_000 });
      const kv = Object.fromEntries(r.out.split(/\r?\n/).map((l) => l.split('=')).filter((p) => p.length === 2).map(([k, v]) => [k!.trim(), v!.trim()]));
      const ip = /^\d{1,3}(\.\d{1,3}){3}$/.test(kv.ip ?? '') ? kv.ip! : null;
      const latencyMs = ip ? Math.round((Number(kv.t1) - Number(kv.t0)) * 1000) : null;
      return { checkedAt, ok: Boolean(ip), egressIp: ip, latencyMs, dnsOk: kv.dns === '1', error: ip ? null : 'no egress through proxy (blocked or proxy unreachable)' };
    } catch (err) {
      return { checkedAt, ok: false, egressIp: null, latencyMs: null, dnsOk: false, error: (err as Error).message };
    }
  }
}
