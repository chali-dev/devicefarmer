import path from 'node:path';
import type { ProxyConfig, ProxyStatus } from '../../db/schema.js';
import { buildConfig, buildRules, START_SCRIPT } from '../../modules/network/singbox.js';
import type { DockerHost } from './docker.js';
import { egressScript, parseEgress } from '../../lib/egress.js';

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
    const checkedAt = new Date().toISOString();
    try {
      const r = await this.host.helper(['sh', '-c', egressScript('busybox')], [], { netContainerId, timeoutMs: 40_000 });
      return parseEgress(r.out, checkedAt, 'no egress through proxy (blocked or proxy unreachable)');
    } catch (err) {
      return { checkedAt, ok: false, egressIp: null, latencyMs: null, dnsOk: false, error: (err as Error).message };
    }
  }
}
