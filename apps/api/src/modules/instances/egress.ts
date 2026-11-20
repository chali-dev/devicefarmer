import type { Instance, ProxyStatus } from '../../db/schema.js';
import { adb } from '../../services.js';
import { updateInstance } from './repo.js';

/** Runs at most one check per device at a time; a second caller gets the running one. */
const inflight = new Map<string, Promise<ProxyStatus>>();

/**
 * Measures where the phone's traffic leaves and stores it in `instances.proxy_status`: on the phone
 * itself over adb, so through the proxy its source binds (we can't see that proxy otherwise).
 */
export function checkEgress(inst: Instance): Promise<ProxyStatus> {
  let p = inflight.get(inst.id);
  if (!p) {
    p = (async () => {
      const status = await adb.egress(inst.adbPort);
      await updateInstance(inst.id, { proxyStatus: status });
      return status;
    })().finally(() => inflight.delete(inst.id));
    inflight.set(inst.id, p);
  }
  return p;
}
