import type { z } from 'zod';
import type { DeviceSource } from '../../db/schema.js';

export type SourceType = DeviceSource['type'];

/** A phone offered by a source (for the "add devices" picker). */
export interface SourcePhone {
  id: string;
  name: string;
  /** Free text such as group / remark. */
  detail: string | null;
  model: string | null;
  region: string | null;
  /** Power state as listed (null = the source doesn't say); `power.isOn` is authoritative. */
  on: boolean | null;
}

export interface SourceHealth { ok: boolean | null; lastOkAt: string | null; failingSince: string | null; lastError: string | null; lastErrorCode: string | null }

/** Where the API makes the phone's adbd reachable: ADB_DEVICE_HOST:<localPort> for STF. */
export interface AdbTarget { instanceId: string; phoneId: string; localPort: number }

/**
 * One kind of device source (设备来源). Device ops and the monitor only talk to this interface, so a
 * new kind of external phone (e.g. self-hosted adb over TCP) is one driver file plus its registration.
 * Everything past the adb connection (STF, remote control, apps, media, social) is shared. External
 * phones have no network sidecar (the proxy pool doesn't apply) and keep their own locale/time zone.
 */
export interface SourceDriver<C = Record<string, unknown>> {
  type: SourceType;
  /**
   * Validates the source config entered in the UI (stored as jsonb). Fields named in `secrets` are
   * sealed (secret-box) as `<field>Enc` before storage, never returned (only `<field>Set`), and
   * handed back decrypted to the driver (modules/sources/index.ts).
   */
  config: z.ZodType<C>;
  secrets?: readonly string[];
  /** What the platform currently knows about the source's reachability (null = no data). */
  health?(cfg: C): SourceHealth | null;
  /** Connectivity check when a source is saved; returns how many phones it offers. */
  test(cfg: C): Promise<{ phones: number }>;
  listPhones(cfg: C): Promise<SourcePhone[]>;
  /** Power control; null = always on (nothing to switch). Power-on may be billed. */
  power: null | {
    isOn(cfg: C, phoneId: string): Promise<boolean>;
    on(cfg: C, phoneId: string): Promise<void>;
    off(cfg: C, phoneId: string): Promise<void>;
  };
  /** Opens (or keeps) the adb connection; idempotent and cheap when already up. */
  openAdb(cfg: C, target: AdbTarget): Promise<void>;
  closeAdb(instanceId: string): void;
}
