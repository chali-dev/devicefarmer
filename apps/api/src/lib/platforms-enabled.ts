import { config } from '../config.js';
import { badRequest } from './errors.js';

/**
 * The single platform switch (config ENABLED_PLATFORMS). Registries keep every platform and filter
 * with `isPlatformEnabled`; adding a platform = its registry/adapter entries + listing it here.
 */
const ids = new Set(config.ENABLED_PLATFORMS.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));

export const isPlatformEnabled = (id: string): boolean => ids.has('all') || ids.has(id);

export function assertPlatformEnabled(id: string): void {
  if (!isPlatformEnabled(id)) throw badRequest(`平台 ${id} 未启用`, 'platform.disabled', { platform: id });
}
