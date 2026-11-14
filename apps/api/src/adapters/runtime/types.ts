import type { InstanceSpec } from '../../db/schema.js';

export interface CreateContainerInput {
  instanceId: string;
  name: string;
  image: string;
  adbPort: number;
  spec: InstanceSpec;
}

export type ContainerState = 'running' | 'exited' | 'created' | 'restarting' | 'paused' | 'dead' | 'missing';

/**
 * Container lifecycle of an Android engine. Deliberately knows nothing about
 * adb or STF: device control is a separate concern (AdbAdapter / StfAdapter).
 * Boot detection goes through adb so it is identical for every engine.
 */
export interface AndroidRuntime {
  readonly engine: 'redroid' | 'emulator';
  create(input: CreateContainerInput): Promise<{ containerId: string }>;
  start(containerId: string): Promise<void>;
  stop(containerId: string): Promise<void>;
  remove(containerId: string): Promise<void>;
  /** Removes the instance's data directory on the Android host. */
  removeData(name: string): Promise<void>;
  state(containerId: string): Promise<ContainerState>;
}
