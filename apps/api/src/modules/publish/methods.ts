import type { MediaAsset, PostType, SocialAccount } from '../../db/schema.js';

/**
 * Publishing is manual only (官方接口发帖 removed on 2026-11-18 by owner decision): a run checks the
 * account, media and device, then hands the task to an operator, who publishes by hand on the bound
 * device (remote control) and records the outcome. The phone UI is never automated.
 */

export interface PublishInput {
  publishTaskId: string;
  /** Scheduling round (bumped by reschedule / manual retry). */
  attemptNo: number;
  platform: string;
  account: SocialAccount;
  /** Platforms with titles (YouTube); undefined otherwise. */
  title?: string;
  caption: string;
  /** Without '#'. */
  hashtags: string[];
  /** Caption + hashtags, as it should appear on the platform. */
  text: string;
  /** e.g. { privacy: 'private' } */
  options: Record<string, unknown>;
  /** Ordered, all `ready`. */
  media: MediaAsset[];
  /** feed | reel | story (validated for the platform). */
  postType: PostType;
}

export type PublishLogLevel = 'debug' | 'info' | 'warn' | 'error';

/** The only publish method (publish_tasks.method). */
export const MANUAL_METHOD = 'manual';
