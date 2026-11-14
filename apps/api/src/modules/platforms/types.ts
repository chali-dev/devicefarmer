import type { MediaAsset, PlatformConnection } from '../../db/schema.js';

/**
 * Official platform adapters (PlatformAdapter). Each platform declares what its official API can do
 * (`capabilities`); callers (publish scheduler, comments, account checks) only use what is declared
 * and fall back to the manual mode otherwise. No scraping and no phone UI automation here.
 */

export interface PlatformCapabilities {
  publishVideo: boolean;
  publishImage: boolean;
  publishCarousel: boolean;
  /** Publishing only hands the media to the user's drafts/inbox; the user finishes the post in the app. */
  draftOnly: boolean;
  /** Media must be reachable by the platform at a public HTTPS URL (it fetches it); local storage can't serve that. */
  needsPublicMediaUrl: boolean;
  commentsRead: boolean;
  commentsReply: boolean;
  profileStats: boolean;
}

/** Admin-configured app credentials of one platform (decrypted; only ever used server-side). */
export interface PlatformApp {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  options: PlatformAppOptions;
}

export interface PlatformAppOptions {
  /** TikTok: the app passed the Content Posting API audit (direct post with video.publish). */
  directPost?: boolean;
}

export interface TokenSet {
  accessToken: string;
  refreshToken?: string | null;
  expiresAt?: Date | null;
  refreshExpiresAt?: Date | null;
  scopes: string[];
  /** Platform account id when the token response carries it (Instagram user_id, TikTok open_id). */
  externalAccountId?: string | null;
}

/** A connection with a valid (refreshed if needed) access token. */
export interface Authed {
  connection: PlatformConnection;
  accessToken: string;
  app: PlatformApp;
  signal?: AbortSignal;
  log?: (message: string, data?: Record<string, unknown>) => Promise<void> | void;
}

export interface OwnProfile {
  externalAccountId: string;
  name: string | null;
  handle: string | null;
  avatarUrl: string | null;
  followers: number | null;
  posts: number | null;
  views: number | null;
  /** Instagram: BUSINESS / MEDIA_CREATOR (personal accounts cannot use the API). */
  accountType?: string | null;
}

export interface PublishInput {
  /** YouTube title / TikTok title; Instagram ignores it. */
  title?: string | null;
  /** Description / caption. */
  caption?: string | null;
  tags?: string[];
  privacy?: 'public' | 'unlisted' | 'private';
  /** Ready media assets in post order (one video, one image, or several images = carousel). */
  media: MediaAsset[];
}

export interface PublishResult {
  externalId?: string;
  url?: string;
  /** awaiting_operator = handed to the user's drafts/inbox; the user must finish it in the app. */
  state: 'published' | 'awaiting_operator';
}

export interface PlatformComment {
  id: string;
  /** Top-level comment id for a reply, null for a top-level comment. */
  parentId: string | null;
  /** Video / media id the comment belongs to. */
  postId: string | null;
  authorName: string | null;
  text: string;
  publishedAt: string | null;
  likeCount: number | null;
  replyCount: number | null;
}

export interface CommentPage {
  comments: PlatformComment[];
  /** Opaque cursor for the next call (null = nothing more right now). */
  nextCursor: string | null;
}

export interface PlatformAdapter {
  id: 'youtube' | 'instagram' | 'tiktok';
  name: string;
  capabilities(options: PlatformAppOptions): PlatformCapabilities;
  oauth: {
    /** Authorization code + PKCE (S256) supported by the platform's web flow. */
    pkce: boolean;
    scopes(options: PlatformAppOptions): string[];
    authorizeUrl(app: PlatformApp, state: string, codeChallenge: string | null): string;
    exchangeCode(app: PlatformApp, code: string, codeVerifier: string | null): Promise<TokenSet>;
    /** Refresh before expiry; tokens expiring within this window are refreshed before a call. */
    refreshWindowMs: number;
    refresh(app: PlatformApp, refreshToken: string | null, accessToken: string): Promise<TokenSet>;
    /** Best-effort revocation at the platform (undefined = the platform has no revoke endpoint). */
    revoke?(app: PlatformApp, accessToken: string, refreshToken: string | null): Promise<void>;
  };
  fetchOwnProfile(a: Authed): Promise<OwnProfile>;
  /** Why the API cannot publish this input (coded message), or null when it can. */
  publishUnavailableReason(input: PublishInput, options: PlatformAppOptions): Promise<{ code: string; message: string } | null>;
  publish(a: Authed, input: PublishInput): Promise<PublishResult>;
  listComments(a: Authed, cursor: string | null): Promise<CommentPage>;
  replyToComment(a: Authed, commentId: string, text: string): Promise<{ id: string }>;
}
