/**
 * Social platform registry. `social_accounts.platform` stores these ids as plain text, so adding a
 * platform is a code change here (plus its name/icon in the web UI), never a DB enum migration.
 * `defaultLimit` is the default number of accounts of this platform one device may hold; admins
 * override it per platform (settings key `social.limits`, see social.ts).
 */
export interface SocialPlatform {
  id: string;
  name: string;
  defaultLimit: number;
  /** Public profile URL for a handle (used when no URL is entered). */
  profileUrl: (handle: string) => string;
}

export const PLATFORMS: readonly SocialPlatform[] = [
  { id: 'instagram', name: 'Instagram', defaultLimit: 1, profileUrl: (h) => `https://www.instagram.com/${encodeURIComponent(h)}/` },
  { id: 'youtube', name: 'YouTube', defaultLimit: 1, profileUrl: (h) => `https://www.youtube.com/@${encodeURIComponent(h)}` },
  { id: 'tiktok', name: 'TikTok', defaultLimit: 1, profileUrl: (h) => `https://www.tiktok.com/@${encodeURIComponent(h)}` },
];

export const PLATFORM_IDS = PLATFORMS.map((p) => p.id) as [string, ...string[]];

export function platformById(id: string): SocialPlatform | undefined {
  return PLATFORMS.find((p) => p.id === id);
}
