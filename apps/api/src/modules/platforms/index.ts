import { platformError } from './http.js';
import { instagramAdapter } from './instagram.js';
import { tiktokAdapter } from './tiktok.js';
import type { PlatformAdapter } from './types.js';
import { youtubeAdapter } from './youtube.js';

/** Official platform adapters by social platform id (see modules/social/platforms.ts). */
export const ADAPTERS: readonly PlatformAdapter[] = [youtubeAdapter, instagramAdapter, tiktokAdapter];
export const ADAPTER_IDS = ADAPTERS.map((a) => a.id) as [PlatformAdapter['id'], ...PlatformAdapter['id'][]];

export const adapterById = (id: string): PlatformAdapter | undefined => ADAPTERS.find((a) => a.id === id);

export function requireAdapter(id: string): PlatformAdapter {
  const a = adapterById(id);
  if (!a) throw platformError(404, 'unsupported', `平台 ${id} 没有官方接口适配`, { platform: id });
  return a;
}

export type { PlatformAdapter } from './types.js';
