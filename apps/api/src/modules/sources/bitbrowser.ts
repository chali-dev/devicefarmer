import { z } from 'zod';
import { bitbrowserClient, isTimeZone } from '../../adapters/bitbrowser.js';
import { close as closeTunnel, ensureTunnel } from '../../adapters/bitbrowser-tunnel.js';
import type { SourceDriver } from './types.js';

const Config = z.object({
  /** The BitBrowser client's local API, e.g. http://127.0.0.1:54345 (the client runs on Windows/Mac). */
  apiUrl: z.string().trim().url().refine((u) => /^https?:\/\//i.test(u), 'http(s) URL required').transform((u) => u.replace(/\/+$/, '')),
  /** The client's optional "Local API Token" (sent as x-api-key); secret: stored sealed, write-only. */
  apiKey: z.string().trim().min(1).max(200).regex(/^[\x21-\x7e]+$/, 'invalid API key').optional(),
  /** IANA zone of the machine running the client (its adb grant expiry is in that wall clock); default: the API host's. */
  timeZone: z.string().trim().max(64).refine(isTimeZone, 'unknown time zone').optional(),
});
type Cfg = z.infer<typeof Config>;
const client = (cfg: Cfg) => bitbrowserClient(cfg.apiUrl, { apiKey: cfg.apiKey ?? null, timeZone: cfg.timeZone ?? null });

/**
 * BitBrowser (比特) cloud phones: listing and power through the client's local API (billed while
 * on), adb through an SSH tunnel to BitBrowser's gateway (adapters/bitbrowser-tunnel.ts).
 */
export const bitbrowserDriver: SourceDriver<Cfg> = {
  type: 'bitbrowser',
  config: Config,
  secrets: ['apiKey'],
  health: (cfg) => ({ ...client(cfg).health }),
  async test(cfg) { return { phones: (await client(cfg).list()).length }; },
  async listPhones(cfg) {
    return (await client(cfg).list()).map((p) => ({
      id: p.id, name: p.name, detail: [p.groupName, p.remark].filter(Boolean).join(' · ') || null,
      model: [p.brand, p.model].filter(Boolean).join(' ') || null, region: [p.country, p.city].filter(Boolean).join(' · ') || null,
      on: p.phoneStatus === null ? null : p.phoneStatus === 1,
    }));
  },
  power: {
    isOn: (cfg, id) => client(cfg).running(id),
    on: (cfg, id) => client(cfg).open(id),
    off: (cfg, id) => client(cfg).shutdown(id),
  },
  openAdb: (cfg, t) => ensureTunnel(t.instanceId, client(cfg), t.phoneId, t.localPort),
  closeAdb: (instanceId) => closeTunnel(instanceId),
};
