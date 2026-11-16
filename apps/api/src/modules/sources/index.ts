import { eq } from 'drizzle-orm';
import { db, schema } from '../../db/index.js';
import type { DeviceSource, Instance } from '../../db/schema.js';
import { conflict, notFound } from '../../lib/errors.js';
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

/** The device's source with its driver and parsed config. External devices only. */
export async function sourceOf(inst: Pick<Instance, 'id' | 'sourceId' | 'externalId' | 'adbPort'>) {
  if (!inst.sourceId || !inst.externalId) throw conflict('not an external device', 'instances.not_external');
  const src = await getSource(inst.sourceId);
  if (!src) throw notFound('device source not found', 'sources.not_found');
  const driver = driverFor(src.type);
  const cfg = driver.config.parse(src.config);
  return { src, driver, cfg, target: { instanceId: inst.id, phoneId: inst.externalId, localPort: inst.adbPort } };
}
