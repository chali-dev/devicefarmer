import type { MediaAsset, PostType, SocialAccount } from '../../db/schema.js';
import { PLATFORMS } from '../social/platforms.js';

/**
 * Publish methods (发布方式) per platform. The scheduler prefers `api` (official platform API, OAuth)
 * when it is registered and available for the account, else `manual`. `manual` is registered for every
 * platform here: the run hands the task to an operator, who publishes by hand on the bound device
 * (remote control) and records the outcome. The phone UI is never automated.
 *
 * Official-API adapters register with `registerPublishMethod(platform, { id: 'api', ... })`. Media files
 * are read with `withMediaFile(asset, fn)` from modules/media/media.ts. `publish` must honour
 * `ctx.signal` (aborted on cancel/timeout) and call `ctx.commit()` right before the request after which
 * the post may exist: until then a failed attempt may be retried; after it the task goes to an operator
 * (outcome unknown) and is never published again automatically.
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
  /** Same as hashtags (shape expected by the platform adapters). */
  tags: string[];
  /** options.privacy when the platform has one. */
  privacy?: 'public' | 'unlisted' | 'private';
  /** Caption + hashtags, as it should appear on the platform. */
  text: string;
  /** e.g. { privacy: 'private' } */
  options: Record<string, unknown>;
  /** Ordered, all `ready`. */
  media: MediaAsset[];
  /** feed | reel | story (validated for the platform). */
  postType: PostType;
}

/** Coded reason (`code` is translated by the UI as errors.<code>). */
export interface UnavailableReason { code: string; message: string }

export type PublishLogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface PublishContext {
  log(level: PublishLogLevel, msg: string, data?: Record<string, unknown>): Promise<void>;
  signal: AbortSignal;
  /** Call right before the request after which the post may exist on the platform (see Authed.commit). */
  commit(): Promise<void>;
}

export interface PublishResult {
  externalId?: string;
  url?: string;
  state: 'published' | 'awaiting_operator';
}

export interface PublishMethod {
  id: 'api' | 'manual';
  /** The method acts through the account's device (needs a linked, online device and a logged-in account). Default false. */
  needsDevice?: boolean;
  /** Why this account can't use the method right now (missing OAuth connection, unsupported media…), or null. */
  unavailableReason(account: SocialAccount, content: PublishInput): Promise<UnavailableReason | null>;
  /**
   * Throw (preferably an Error with a stable `code`) to fail the attempt. Retried while attempts remain
   * unless it is a non-transient platform error (platform.* below 500, except 429) or came after commit().
   */
  publish(input: PublishInput, ctx: PublishContext): Promise<PublishResult>;
}

const ORDER: PublishMethod['id'][] = ['api', 'manual'];
const registry = new Map<string, Map<PublishMethod['id'], PublishMethod>>();

/** Registers (or replaces) the platform's method with the same id. */
export function registerPublishMethod(platform: string, method: PublishMethod): void {
  const m = registry.get(platform) ?? new Map<PublishMethod['id'], PublishMethod>();
  m.set(method.id, method);
  registry.set(platform, m);
}

/** Registered methods of a platform in preference order (api first). */
export function methodsFor(platform: string): PublishMethod[] {
  const m = registry.get(platform);
  return m ? ORDER.flatMap((id) => (m.has(id) ? [m.get(id)!] : [])) : [];
}

export const methodIdsFor = (platform: string) => methodsFor(platform).map((m) => m.id);

/** Manual (人工) method: hand the task over to an operator. */
export const manualMethod: PublishMethod = {
  id: 'manual',
  needsDevice: true,
  async unavailableReason() { return null; },
  async publish(input, ctx) {
    await ctx.log('info', 'handed over to an operator: publish by hand on the bound device, then record the outcome', { postType: input.postType });
    return { state: 'awaiting_operator' };
  },
};

for (const p of PLATFORMS) registerPublishMethod(p.id, manualMethod);
