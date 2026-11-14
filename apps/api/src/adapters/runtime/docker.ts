import Docker from 'dockerode';
import path from 'node:path';
import type { AndroidRuntime, ContainerState, CreateContainerInput } from './types.js';

export const INSTANCE_LABEL = 'cloudphone.instance';
const HELPER_IMAGE = 'alpine:3.22';

export function dockerFromEnv(dockerHost: string): Docker {
  if (dockerHost.startsWith('unix://')) return new Docker({ socketPath: dockerHost.slice('unix://'.length) });
  const u = new URL(dockerHost.replace(/^tcp:/, 'http:'));
  return new Docker({ protocol: u.protocol === 'https:' ? 'https' : 'http', host: u.hostname, port: Number(u.port) });
}

function statusCode(err: unknown): number | undefined {
  return typeof err === 'object' && err !== null ? (err as { statusCode?: number }).statusCode : undefined;
}

/** Shared Docker plumbing for one Android host (one Docker daemon). */
export class DockerHost {
  private kvmCache: { value: boolean; at: number } | null = null;

  constructor(readonly docker: Docker, readonly dataRoot: string) {}

  instanceDir(name: string): string {
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(name)) throw new Error(`unsafe instance name "${name}"`);
    return path.posix.join(this.dataRoot, name);
  }

  async ensureImage(image: string): Promise<void> {
    try {
      await this.docker.getImage(image).inspect();
      return;
    } catch (err) {
      if (statusCode(err) !== 404) throw err;
    }
    const stream = await this.docker.pull(image);
    await new Promise<void>((resolve, reject) =>
      this.docker.modem.followProgress(stream, (err: Error | null) => (err ? reject(err) : resolve())));
  }

  /**
   * Runs a short-lived alpine helper on the Android host and returns its exit code + output.
   * `netContainerId` joins an instance's network namespace (used for proxy/egress probes).
   */
  async helper(cmd: string[], binds: string[], opts: { netContainerId?: string; env?: string[]; timeoutMs?: number } = {}): Promise<{ code: number; out: string }> {
    await this.ensureImage(HELPER_IMAGE);
    const c = await this.docker.createContainer({
      // Tty: logs come back raw (non-TTY logs are multiplexed with 8-byte frame headers).
      Image: HELPER_IMAGE, Cmd: cmd, Env: opts.env, Tty: true,
      HostConfig: { Binds: binds, ...(opts.netContainerId ? { NetworkMode: `container:${opts.netContainerId}` } : {}) },
      Labels: { 'cloudphone.helper': '1' },
    });
    let timer: NodeJS.Timeout | undefined;
    try {
      await c.start();
      const res = (await Promise.race([
        c.wait(),
        new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('helper timeout')), opts.timeoutMs ?? 60_000); }),
      ])) as { StatusCode: number };
      // docker-modem may hand back a Buffer, a string, or (if the raw output looks like JSON) a parsed value.
      const logs: unknown = await c.logs({ stdout: true, stderr: true });
      const text = Buffer.isBuffer(logs) ? logs.toString('utf8') : typeof logs === 'string' ? logs : JSON.stringify(logs);
      return { code: res.StatusCode, out: text.replace(/\r/g, '').trim() };
    } finally {
      clearTimeout(timer);
      await c.remove({ force: true }).catch(() => undefined);
    }
  }

  /** Writes files into a directory on the Android host (contents passed base64 via env, no shell quoting). */
  async writeFiles(hostDir: string, files: Record<string, { content: string; mode: string }>): Promise<void> {
    const names = Object.keys(files);
    if (!names.every((n) => /^[a-z0-9._-]+$/.test(n))) throw new Error('invalid file name');
    const env = names.map((n, i) => `F${i}=${Buffer.from(files[n]!.content).toString('base64')}`);
    const script = ['set -e', 'mkdir -p /target', ...names.map((n, i) =>
      `printf '%s' "$F${i}" | base64 -d > /target/${n}.tmp && chmod ${files[n]!.mode} /target/${n}.tmp && mv /target/${n}.tmp /target/${n}`)].join('; ');
    const r = await this.helper(['sh', '-c', script], [`${hostDir}:/target`], { env });
    if (r.code !== 0) throw new Error(`writing files to ${hostDir} failed: ${r.out}`);
  }

  private bridgeCache: string | null = null;
  /** Subnet of Docker's default bridge (adb/platform traffic that must bypass the proxy). */
  async bridgeSubnet(): Promise<string> {
    if (this.bridgeCache) return this.bridgeCache;
    const info = await this.docker.getNetwork('bridge').inspect() as { IPAM?: { Config?: { Subnet?: string }[] } };
    const subnet = info.IPAM?.Config?.find((c) => c.Subnet && c.Subnet.includes('.'))?.Subnet;
    if (!subnet) throw new Error('cannot determine docker bridge subnet');
    this.bridgeCache = subnet;
    return subnet;
  }

  // ---- generic container ops shared by engine containers and network sidecars
  async startContainer(id: string): Promise<void> {
    try { await this.docker.getContainer(id).start(); } catch (err) { if (statusCode(err) !== 304) throw err; }
  }
  async stopContainer(id: string): Promise<void> {
    try { await this.docker.getContainer(id).stop({ t: 10 }); } catch (err) { const c = statusCode(err); if (c !== 304 && c !== 404) throw err; }
  }
  async removeContainer(id: string): Promise<void> {
    try { await this.docker.getContainer(id).remove({ force: true, v: true }); } catch (err) { if (statusCode(err) !== 404) throw err; }
  }
  async containerState(id: string): Promise<ContainerState> {
    try { return (await this.docker.getContainer(id).inspect()).State.Status as ContainerState; }
    catch (err) { if (statusCode(err) === 404) return 'missing'; throw err; }
  }
  /** docker exec, returns combined output; throws on non-zero exit. */
  async exec(id: string, cmd: string[]): Promise<string> {
    const e = await this.docker.getContainer(id).exec({ Cmd: cmd, AttachStdout: true, AttachStderr: true, Tty: true });
    const stream = await e.start({ hijack: true, stdin: false, Tty: true });
    const out = await new Promise<string>((resolve, reject) => {
      let b = ''; stream.on('data', (d: Buffer) => (b += d)); stream.on('end', () => resolve(b)); stream.on('error', reject);
    });
    const { ExitCode } = await e.inspect();
    if (ExitCode !== 0) throw new Error(`exec ${cmd.join(' ')} failed (${ExitCode}): ${out.trim()}`);
    return out;
  }
  async signal(id: string, sig: string): Promise<void> {
    await this.docker.getContainer(id).kill({ signal: sig });
  }

  /** Whether the Android host exposes /dev/kvm (required by the Google emulator). Cached 60 s. */
  async hasKvm(): Promise<boolean> {
    if (this.kvmCache && Date.now() - this.kvmCache.at < 60_000) return this.kvmCache.value;
    const r = await this.helper(['sh', '-c', 'test -c /host-dev/kvm && echo yes || echo no'], ['/dev:/host-dev:ro']);
    const value = r.out.endsWith('yes');
    this.kvmCache = { value, at: Date.now() };
    return value;
  }

  /** MemAvailable of the Android host in MiB (read via a helper container). */
  async memAvailableMb(): Promise<number> {
    const r = await this.helper(['sh', '-c', "awk '/MemAvailable/ {print int($2/1024)}' /proc/meminfo"], []);
    const n = Number(r.out.trim().split(/\s+/).pop());
    if (!Number.isFinite(n)) throw new Error(`cannot read host memory: ${r.out}`);
    return n;
  }

  async listStates(): Promise<Map<string, { containerId: string; state: ContainerState }>> {
    const list = await this.docker.listContainers({ all: true, filters: { label: [INSTANCE_LABEL] } });
    const out = new Map<string, { containerId: string; state: ContainerState }>();
    for (const c of list) {
      const id = c.Labels[INSTANCE_LABEL];
      if (id) out.set(id, { containerId: c.Id, state: c.State as ContainerState });
    }
    return out;
  }
}

/** Lifecycle shared by all engines; subclasses only describe their container. */
export abstract class DockerRuntime implements AndroidRuntime {
  abstract readonly engine: 'redroid' | 'emulator';
  protected abstract containerSpec(input: CreateContainerInput, dataDir: string): Docker.ContainerCreateOptions;

  constructor(protected readonly host: DockerHost) {}

  async create(input: CreateContainerInput): Promise<{ containerId: string }> {
    await this.host.ensureImage(input.image);
    const spec = this.containerSpec(input, path.posix.join(this.host.instanceDir(input.name), 'data'));
    if (input.netContainerId) {
      // Join the network sidecar's namespace: it owns the adb port mapping and the proxy policy.
      delete spec.ExposedPorts;
      spec.HostConfig = { ...spec.HostConfig, NetworkMode: `container:${input.netContainerId}` };
      delete spec.HostConfig.PortBindings;
    }
    const container = await this.host.docker.createContainer({
      ...spec,
      name: `cloudphone-${input.name}`,
      Image: input.image,
      Labels: { ...spec.Labels, [INSTANCE_LABEL]: input.instanceId, 'cloudphone.name': input.name, 'cloudphone.engine': this.engine },
    });
    return { containerId: container.id };
  }

  start(containerId: string): Promise<void> { return this.host.startContainer(containerId); }
  stop(containerId: string): Promise<void> { return this.host.stopContainer(containerId); }
  remove(containerId: string): Promise<void> { return this.host.removeContainer(containerId); }
  state(containerId: string): Promise<ContainerState> { return this.host.containerState(containerId); }

  async removeData(name: string): Promise<void> {
    this.host.instanceDir(name); // validates the name
    const r = await this.host.helper(['rm', '-rf', `/target/${name}`], [`${this.host.dataRoot}:/target`]);
    if (r.code !== 0) throw new Error(`failed to remove data for ${name} (exit ${r.code})`);
  }
}
