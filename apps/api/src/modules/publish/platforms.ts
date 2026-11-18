import type { MediaAsset, PostType } from '../../db/schema.js';

/**
 * What each platform accepts in one post (capability table, checked at distribution and again right
 * before a run). Platforms without an entry (added to the social registry later) use DEFAULT until
 * their limits are entered here.
 */
export interface MediaRule { min: number; max: number; kinds: ('image' | 'video')[]; /** images and videos in one post */ mixed: boolean; /** longest video in seconds (media_assets.duration) */ maxVideoSec?: number }

/** Rules of one post type; the platform-wide `media` rule is the `feed` rule. */
export interface PostTypeRule { media: MediaRule; /** false: the type has no caption (texts are dropped at distribution) */ caption: boolean }

export interface PublishCapability {
  media: MediaRule;
  /** Post types besides `feed` (帖子). Platforms without the field accept `feed` only. */
  postTypes?: Partial<Record<Exclude<PostType, 'feed'>, PostTypeRule>>;
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
  // Reels: exactly one video. Stories (限动): one image or one video ≤ 60 s, no caption (in the app, text on a
  // story is a sticker the operator adds by hand).
  instagram: {
    media: { min: 1, max: 10, kinds: ['image', 'video'], mixed: true }, title: null, captionMax: 2200, hashtagsMax: 30,
    postTypes: {
      reel: { media: { min: 1, max: 1, kinds: ['video'], mixed: false }, caption: true },
      story: { media: { min: 1, max: 1, kinds: ['image', 'video'], mixed: false, maxVideoSec: 60 }, caption: false },
    },
  },
  // TikTok: one video; caption ≤ 2200.
  tiktok: { media: { min: 1, max: 1, kinds: ['video'], mixed: false }, title: null, captionMax: 2200, hashtagsMax: 30, privacy: ['public', 'friends', 'private'] },
  // Facebook (manual publishing for now): text-only posts allowed, up to 10 photos/videos; text ≤ 63206.
  facebook: { media: { min: 0, max: 10, kinds: ['image', 'video'], mixed: true }, title: null, captionMax: 63206, hashtagsMax: 30 },
};

const DEFAULT: PublishCapability = { media: { min: 0, max: 10, kinds: ['image', 'video'], mixed: true }, title: null, captionMax: 5000, hashtagsMax: 30 };

export const capabilityOf = (platform: string): PublishCapability => PUBLISH_CAPABILITIES[platform] ?? DEFAULT;

/** Post types the platform accepts (feed first). */
export const postTypesOf = (platform: string): PostType[] => ['feed', ...Object.keys(capabilityOf(platform).postTypes ?? {}) as PostType[]];

/** The rule of `postType` on the platform, or null when the platform has no such type. */
export function postTypeRule(platform: string, postType: PostType): PostTypeRule | null {
  const cap = capabilityOf(platform);
  if (postType === 'feed') return { media: cap.media, caption: true };
  return cap.postTypes?.[postType] ?? null;
}

export interface Violation { code: string; message: string; params: Record<string, string | number> }

/** Full post text as it is published: caption, then the hashtags. */
export function composeText(caption: string, hashtags: string[]): string {
  const tags = hashtags.map((h) => `#${h}`).join(' ');
  return [caption.trim(), tags].filter(Boolean).join('\n\n');
}

/** First violation of the platform's limits, or null. */
export function validateForPlatform(platform: string, media: Pick<MediaAsset, 'fileType' | 'name' | 'duration'>[], post: { title: string | null; caption: string; hashtags: string[]; postType?: PostType }): Violation | null {
  const cap = capabilityOf(platform);
  const postType = post.postType ?? 'feed';
  const n = media.length;
  const v = (code: string, message: string, params: Record<string, string | number> = {}): Violation => ({ code, message, params: { platform, postType, ...params } });
  const rule = postTypeRule(platform, postType);
  if (!rule) return v('publish.post_type_unsupported', `${platform} 不支持该发布类型：${postType}`);
  const r = rule.media;
  if (n < r.min || n > r.max) {
    return v('publish.media_count', `${platform} 需要 ${r.min}–${r.max} 个素材（当前 ${n} 个）`, { min: r.min, max: r.max, count: n });
  }
  const bad = media.find((m) => !r.kinds.includes(m.fileType));
  if (bad) return v('publish.media_kind', `${platform} 不支持该类型的素材：${bad.name}`, { name: bad.name, kinds: r.kinds.join('/') });
  if (!r.mixed && new Set(media.map((m) => m.fileType)).size > 1) return v('publish.media_mixed', `${platform} 不支持图片和视频混合发布`);
  if (r.maxVideoSec) {
    const long = media.find((m) => m.fileType === 'video' && (m.duration ?? 0) > r.maxVideoSec!);
    if (long) return v('publish.video_too_long', `视频「${long.name}」超过 ${r.maxVideoSec} 秒`, { name: long.name, max: r.maxVideoSec, duration: Math.round(long.duration ?? 0) });
  }
  if (!rule.caption) return null; // no caption: the texts are not published
  if (cap.title?.required && !post.title?.trim()) return v('publish.title_required', `${platform} 需要标题`);
  if (cap.title && post.title && post.title.length > cap.title.max) return v('publish.title_too_long', `${platform} 标题最多 ${cap.title.max} 个字符`, { max: cap.title.max });
  const text = composeText(post.caption, post.hashtags);
  if (text.length > cap.captionMax) return v('publish.caption_too_long', `${platform} 文案（含话题标签）最多 ${cap.captionMax} 个字符`, { max: cap.captionMax, length: text.length });
  if (post.hashtags.length > cap.hashtagsMax) return v('publish.too_many_hashtags', `${platform} 最多 ${cap.hashtagsMax} 个话题标签`, { max: cap.hashtagsMax });
  return null;
}
