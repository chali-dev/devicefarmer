import { z } from 'zod';
import { bitbrowserClient } from '../../adapters/bitbrowser.js';
import { close as closeTunnel, ensureTunnel } from '../../adapters/bitbrowser-tunnel.js';
import type { SourceDriver } from './types.js';

const Config = z.object({
  /** The BitBrowser client's local API, e.g. http://127.0.0.1:54345 (the client runs on Windows/Mac). */
  apiUrl: z.string().trim().url().refine((u) => /^https?:\/\//i.test(u), 'http(s) URL required').transform((u) => u.replace(/\/+$/, '')),
});
type Cfg = z.infer<typeof Config>;

/**
 * BitBrowser (比特) cloud phones: listing and power through the client's local API (billed while
 * on), adb through an SSH tunnel to BitBrowser's gateway (adapters/bitbrowser-tunnel.ts).
 */
export const bitbrowserDriver: SourceDriver<Cfg> = {
  type: 'bitbrowser',
  config: Config,
  async test(cfg) { return { phones: (await bitbrowserClient(cfg.apiUrl).list()).length }; },
  async listPhones(cfg) {
    return (await bitbrowserClient(cfg.apiUrl).list()).map((p) => ({
      id: p.id, name: p.name, detail: [p.groupName, p.remark].filter(Boolean).join(' · ') || null,
      model: [p.brand, p.model].filter(Boolean).join(' ') || null, region: [p.country, p.city].filter(Boolean).join(' · ') || null,
      on: p.phoneStatus === null ? null : p.phoneStatus === 1,
    }));
  },
  power: {
    isOn: (cfg, id) => bitbrowserClient(cfg.apiUrl).running(id),
    on: (cfg, id) => bitbrowserClient(cfg.apiUrl).open(id),
    off: (cfg, id) => bitbrowserClient(cfg.apiUrl).shutdown(id),
  },
  openAdb: (cfg, t) => ensureTunnel(t.instanceId, bitbrowserClient(cfg.apiUrl), t.phoneId, t.localPort),
  closeAdb: (instanceId) => closeTunnel(instanceId),
};
