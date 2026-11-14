import { config } from '../../config.js';
import { DockerHost, dockerFromEnv } from './docker.js';
import { EmulatorRuntime } from './emulator.js';
import { NetworkSidecar } from './network.js';
import { RedroidRuntime } from './redroid.js';
import type { AndroidRuntime } from './types.js';

export type Engine = AndroidRuntime['engine'];

/** One Android host per process for now; scale-out = one DockerHost per Linux server. */
export const dockerHost = new DockerHost(dockerFromEnv(config.DOCKER_HOST), config.INSTANCE_DATA_ROOT);

export const network = new NetworkSidecar(dockerHost, config.SINGBOX_IMAGE);

const runtimes: Record<Engine, AndroidRuntime> = {
  redroid: new RedroidRuntime(dockerHost),
  emulator: new EmulatorRuntime(dockerHost, config.EMULATOR_DATA_PATH, config.EMULATOR_ADBKEY_PATH),
};

export function runtimeFor(engine: Engine): AndroidRuntime {
  return runtimes[engine];
}
