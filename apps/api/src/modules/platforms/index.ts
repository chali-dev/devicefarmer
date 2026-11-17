import { assertPlatformEnabled, isPlatformEnabled } from '../../lib/platforms-enabled.js';
import { platformError } from './http.js';
import { instagramAdapter } from './instagram.js';
import { tiktokAdapter } from './tiktok.js';
import type { PlatformAdapter } from './types.js';
import { youtubeAdapter } from './youtube.js';

/** Official platform adapters by social platform id (see modules/social/platforms.ts). */
export const ADAPTERS: readonly PlatformAdapter[] = [youtubeAdapter, instagramAdapter, tiktokAdapter];

/** Adapters of the platforms switched on by ENABLED_PLATFORMS. */
export const enabledAdapters = () => ADAPTERS.filter((a) => isPlatformEnabled(a.id));

/** The adapter of an enabled platform (a disabled one has none: manual only). */
export const adapterById = (id: string): PlatformAdapter | undefined => (isPlatformEnabled(id) ? ADAPTERS.find((a) => a.id === id) : undefined);

/** Every official API call goes through here: platform.disabled / platform.unsupported otherwise. */
export function requireAdapter(id: string): PlatformAdapter {
  assertPlatformEnabled(id);
  const a = adapterById(id);
  if (!a) throw platformError(400, 'unsupported', `平台 ${id} 没有官方接口适配`, { platform: id });
  return a;
}

export type { PlatformAdapter } from './types.js';
