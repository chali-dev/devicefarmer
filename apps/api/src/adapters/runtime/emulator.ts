import type Docker from 'dockerode';
import fs from 'node:fs';
import { DockerRuntime, type DockerHost } from './docker.js';
import type { CreateContainerInput } from './types.js';

/**
 * Google's official emulator packaged by google/android-emulator-container-scripts
 * (emu-docker) with a google_apis_playstore system image.
 * Requires an x86_64 Linux Docker host with /dev/kvm (Google ships no Linux arm64 emulator).
 *
 * NOT YET TESTED: no x86_64 KVM host is available in the current environment.
 */
export class EmulatorRuntime extends DockerRuntime {
  readonly engine = 'emulator' as const;

  constructor(host: DockerHost, private readonly dataPath: string, private readonly adbKeyPath: string | undefined) {
    super(host);
  }

  protected containerSpec(input: CreateContainerInput, dataDir: string): Docker.ContainerCreateOptions {
    // Play Store images only accept adb clients whose key is baked in at start (ADBKEY env).
    // It must be the private key of the adb server STF uses.
    const adbKey = this.adbKeyPath && fs.existsSync(this.adbKeyPath) ? fs.readFileSync(this.adbKeyPath, 'utf8') : undefined;
    if (!adbKey) throw new Error('EMULATOR_ADBKEY_PATH must point to the STF adb server private key');
    return {
      Env: [`ADBKEY=${adbKey}`],
      ExposedPorts: { '5555/tcp': {}, '8554/tcp': {} },
      HostConfig: {
        Devices: [{ PathOnHost: '/dev/kvm', PathInContainer: '/dev/kvm', CgroupPermissions: 'rwm' }],
        Binds: [`${dataDir}:${this.dataPath}`],
        PortBindings: { '5555/tcp': [{ HostIp: '0.0.0.0', HostPort: String(input.adbPort) }] },
        RestartPolicy: { Name: 'no' },
        ...(input.spec.memoryMb ? { Memory: input.spec.memoryMb * 1024 * 1024 } : {}),
      },
    };
  }
}
