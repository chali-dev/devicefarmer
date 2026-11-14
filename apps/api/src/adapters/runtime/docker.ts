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

  /** Runs a short-lived alpine helper on the Android host and returns its exit code + output. */
  async helper(cmd: string[], binds: string[]): Promise<{ code: number; out: string }> {
    await this.ensureImage(HELPER_IMAGE);
    const c = await this.docker.createContainer({ Image: HELPER_IMAGE, Cmd: cmd, HostConfig: { Binds: binds }, Labels: { 'cloudphone.helper': '1' } });
    try {
      await c.start();
      const res = (await c.wait()) as { StatusCode: number };
      const logs = await c.logs({ stdout: true, stderr: true });
      return { code: res.StatusCode, out: logs.toString('utf8').replace(/[\x00-\x08]/g, '').trim() };
    } finally {
      await c.remove({ force: true }).catch(() => undefined);
    }
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
    const container = await this.host.docker.createContainer({
      ...spec,
      name: `cloudphone-${input.name}`,
      Image: input.image,
      Labels: { ...spec.Labels, [INSTANCE_LABEL]: input.instanceId, 'cloudphone.name': input.name, 'cloudphone.engine': this.engine },
    });
    return { containerId: container.id };
  }

  async start(containerId: string): Promise<void> {
    try {
      await this.host.docker.getContainer(containerId).start();
    } catch (err) {
      if (statusCode(err) !== 304) throw err; // already started
    }
  }

  async stop(containerId: string): Promise<void> {
    try {
      await this.host.docker.getContainer(containerId).stop({ t: 10 });
    } catch (err) {
      const code = statusCode(err);
      if (code !== 304 && code !== 404) throw err;
    }
  }

  async remove(containerId: string): Promise<void> {
    try {
      await this.host.docker.getContainer(containerId).remove({ force: true, v: true });
    } catch (err) {
      if (statusCode(err) !== 404) throw err;
    }
  }

  async removeData(name: string): Promise<void> {
    this.host.instanceDir(name); // validates the name
    const r = await this.host.helper(['rm', '-rf', `/target/${name}`], [`${this.host.dataRoot}:/target`]);
    if (r.code !== 0) throw new Error(`failed to remove data for ${name} (exit ${r.code})`);
  }

  async state(containerId: string): Promise<ContainerState> {
    try {
      const info = await this.host.docker.getContainer(containerId).inspect();
      return info.State.Status as ContainerState;
    } catch (err) {
      if (statusCode(err) === 404) return 'missing';
      throw err;
    }
  }
}
