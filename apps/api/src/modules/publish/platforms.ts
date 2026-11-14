import type { MediaAsset } from '../../db/schema.js';

/**
 * What each platform accepts in one post (capability table, checked at distribution and again right
 * before a run). Platforms without an entry (added to the social registry later) use DEFAULT until
 * their limits are entered here.
 */
export interface PublishCapability {
  media: { min: number; max: number; kinds: ('image' | 'video')[]; /** images and videos in one post */ mixed: boolean };
  title: { required: boolean; max: number } | null;
  captionMax: number;
  hashtagsMax: number;
  /** Platform options accepted in publish_tasks.options (validated by the route). */
  privacy?: readonly string[];
}

export const PUBLISH_CAPABILITIES: Record<string, PublishCapability> = {
  // YouTube: one video per upload; title ≤ 100, description ≤ 5000.
  youtube: { media: { min: 1, max: 1, kinds: ['video'], mixed: false }, title: { required: true, max: 100 }, captionMax: 5000, hashtagsMax: 15, privacy: ['public', 'unlisted', 'private'] },
  // Instagram: a single image/video, or a carousel of up to 10 items; caption ≤ 2200, ≤ 30 hashtags.
  instagram: { media: { min: 1, max: 10, kinds: ['image', 'video'], mixed: true }, title: null, captionMax: 2200, hashtagsMax: 30 },
  // TikTok: one video; caption ≤ 2200.
  tiktok: { media: { min: 1, max: 1, kinds: ['video'], mixed: false }, title: null, captionMax: 2200, hashtagsMax: 30, privacy: ['public', 'friends', 'private'] },
};

const DEFAULT: PublishCapability = { media: { min: 0, max: 10, kinds: ['image', 'video'], mixed: true }, title: null, captionMax: 5000, hashtagsMax: 30 };

export const capabilityOf = (platform: string): PublishCapability => PUBLISH_CAPABILITIES[platform] ?? DEFAULT;

export interface Violation { code: string; message: string; params: Record<string, string | number> }

/** Full post text as it is published: caption, then the hashtags. */
export function composeText(caption: string, hashtags: string[]): string {
  const tags = hashtags.map((h) => `#${h}`).join(' ');
  return [caption.trim(), tags].filter(Boolean).join('\n\n');
}

/** First violation of the platform's limits, or null. */
export function validateForPlatform(platform: string, media: Pick<MediaAsset, 'fileType' | 'name'>[], post: { title: string | null; caption: string; hashtags: string[] }): Violation | null {
  const cap = capabilityOf(platform);
  const n = media.length;
  const v = (code: string, message: string, params: Record<string, string | number> = {}): Violation => ({ code, message, params: { platform, ...params } });
  if (n < cap.media.min || n > cap.media.max) {
    return v('publish.media_count', `${platform} 需要 ${cap.media.min}–${cap.media.max} 个素材（当前 ${n} 个）`, { min: cap.media.min, max: cap.media.max, count: n });
  }
  const bad = media.find((m) => !cap.media.kinds.includes(m.fileType));
  if (bad) return v('publish.media_kind', `${platform} 不支持该类型的素材：${bad.name}`, { name: bad.name, kinds: cap.media.kinds.join('/') });
  if (!cap.media.mixed && new Set(media.map((m) => m.fileType)).size > 1) return v('publish.media_mixed', `${platform} 不支持图片和视频混合发布`);
  if (cap.title?.required && !post.title?.trim()) return v('publish.title_required', `${platform} 需要标题`);
  if (cap.title && post.title && post.title.length > cap.title.max) return v('publish.title_too_long', `${platform} 标题最多 ${cap.title.max} 个字符`, { max: cap.title.max });
  const text = composeText(post.caption, post.hashtags);
  if (text.length > cap.captionMax) return v('publish.caption_too_long', `${platform} 文案（含话题标签）最多 ${cap.captionMax} 个字符`, { max: cap.captionMax, length: text.length });
  if (post.hashtags.length > cap.hashtagsMax) return v('publish.too_many_hashtags', `${platform} 最多 ${cap.hashtagsMax} 个话题标签`, { max: cap.hashtagsMax });
  return null;
}
