import type Docker from 'dockerode';
import { DockerRuntime } from './docker.js';
import type { CreateContainerInput } from './types.js';

/** redroid: Android in a privileged container sharing the host kernel (binder). */
export class RedroidRuntime extends DockerRuntime {
  readonly engine = 'redroid' as const;

  protected containerSpec(input: CreateContainerInput, dataDir: string): Docker.ContainerCreateOptions {
    const { spec } = input;
    return {
      Cmd: [
        `androidboot.redroid_width=${spec.width}`,
        `androidboot.redroid_height=${spec.height}`,
        `androidboot.redroid_dpi=${spec.dpi}`,
      ],
      ExposedPorts: { '5555/tcp': {} },
      HostConfig: {
        Privileged: true, // required by redroid (binderfs, cgroups)
        // Own /data per instance (apps, Google account, GSF ID survive restarts/re-creation);
        // own network namespace (default bridge).
        Binds: [`${dataDir}:/data`],
        PortBindings: { '5555/tcp': [{ HostIp: '0.0.0.0', HostPort: String(input.adbPort) }] },
        RestartPolicy: { Name: 'no' },
        ...(spec.memoryMb ? { Memory: spec.memoryMb * 1024 * 1024 } : {}),
      },
    };
  }
}
