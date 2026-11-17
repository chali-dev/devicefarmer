import { eq } from 'drizzle-orm';
import { db, schema } from '../../db/index.js';
import type { DeviceSource, Instance } from '../../db/schema.js';
import { conflict, notFound } from '../../lib/errors.js';
import { openSecret, sealSecret } from '../../lib/secret-box.js';
import { bitbrowserDriver } from './bitbrowser.js';
import type { SourceDriver, SourceType } from './types.js';

const DRIVERS: Record<SourceType, SourceDriver<any>> = {
  bitbrowser: bitbrowserDriver,
};
export const SOURCE_TYPES = Object.keys(DRIVERS) as [SourceType, ...SourceType[]];

export function driverFor(type: SourceType): SourceDriver<any> {
  return DRIVERS[type];
}

export async function getSource(id: string): Promise<DeviceSource | undefined> {
  const [row] = await db.select().from(schema.deviceSources).where(eq(schema.deviceSources.id, id));
  return row;
}

type Raw = Record<string, unknown>;

/** Stored config → driver config: `<field>Enc` of each secret field opened back into `<field>`. */
export function openConfig(driver: SourceDriver<any>, stored: unknown): Raw {
  const out: Raw = { ...(stored as Raw) };
  for (const f of driver.secrets ?? []) {
    const enc = out[`${f}Enc`];
    delete out[`${f}Enc`];
    if (typeof enc === 'string') out[f] = openSecret(enc);
  }
  return out;
}

/**
 * Config entered in the UI → what the driver gets for its test, with secret fields merged: absent
 * keeps the stored value, null or '' clears it.
 */
export function mergeSecrets(driver: SourceDriver<any>, input: Raw, stored: unknown): Raw {
  const cur = openConfig(driver, stored ?? {});
  const out: Raw = { ...input };
  for (const f of driver.secrets ?? []) {
    if (!(f in input)) { if (cur[f] !== undefined) out[f] = cur[f]; }
    else if (input[f] === null || input[f] === '') delete out[f];
  }
  return out;
}

/** Validated driver config → stored form (secret fields sealed as `<field>Enc`). */
export function sealConfig(driver: SourceDriver<any>, cfg: Raw): Raw {
  const out: Raw = { ...cfg };
  for (const f of driver.secrets ?? []) {
    if (typeof out[f] === 'string') out[`${f}Enc`] = sealSecret(out[f] as string);
    delete out[f];
  }
  return out;
}

/** Stored config → what the API returns: secrets only as `<field>Set`. */
export function publicConfig(driver: SourceDriver<any>, stored: unknown): Raw {
  const out: Raw = { ...(stored as Raw) };
  for (const f of driver.secrets ?? []) { out[`${f}Set`] = typeof out[`${f}Enc`] === 'string'; delete out[`${f}Enc`]; }
  return out;
}

/** The device's source with its driver and parsed config. External devices only. */
export async function sourceOf(inst: Pick<Instance, 'id' | 'sourceId' | 'externalId' | 'adbPort'>) {
  if (!inst.sourceId || !inst.externalId) throw conflict('not an external device', 'instances.not_external');
  const src = await getSource(inst.sourceId);
  if (!src) throw notFound('device source not found', 'sources.not_found');
  const driver = driverFor(src.type);
  const cfg = driver.config.parse(openConfig(driver, src.config));
  return { src, driver, cfg, target: { instanceId: inst.id, phoneId: inst.externalId, localPort: inst.adbPort } };
}
