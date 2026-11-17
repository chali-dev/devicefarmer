import type { SocialAccount } from '../../db/schema.js';
import { isPlatformEnabled } from '../../lib/platforms-enabled.js';
import { appOptions, isConfigured } from './credentials.js';
import { connectionFor, withConnection } from './connections.js';
import { adapterById, requireAdapter } from './index.js';
import type { AccountStats, Authed, CommentPage, OwnPost, PublishInput, PublishResult } from './types.js';

/**
 * Entry points for other modules (publish scheduler, comments). They take ids/rows, never tokens.
 * Publish wiring (modules/publish/methods.ts, owned by the scheduler):
 *   registerPublishMethod(platform, { id: 'api', unavailableReason: (account, input) => apiPublishUnavailableReason(account, input),
 *     publish: (input, ctx) => apiPublish(account, input, { signal: ctx.signal, log: … }) })
 */
export interface Reason { code: string; message: string }
type CallOpts = Pick<Authed, 'signal' | 'log' | 'commit'>;

/** Null when `account` can publish `input` through its official API right now, else a coded reason. */
export async function apiPublishUnavailableReason(account: SocialAccount, input: PublishInput): Promise<Reason | null> {
  if (!isPlatformEnabled(account.platform)) return { code: 'platform.disabled', message: `平台 ${account.platform} 未启用` };
  const adapter = adapterById(account.platform);
  if (!adapter) return { code: 'platform.unsupported', message: `平台 ${account.platform} 没有官方接口适配` };
  if (!(await isConfigured(account.platform))) return { code: 'platform.not_configured', message: `未配置 ${adapter.name} 平台接入` };
  const conn = await connectionFor(account.id);
  if (!conn) return { code: 'platform.not_connected', message: '该账号未通过官方接口授权' };
  if (conn.status === 'expired' || conn.status === 'revoked') return { code: 'platform.auth_expired', message: `${adapter.name} 授权已失效，请重新授权` };
  const caps = adapter.capabilities(await appOptions(account.platform));
  const postType = input.postType ?? 'feed';
  if (postType !== 'feed' && !caps.postTypes?.includes(postType)) {
    return { code: 'platform.post_type_unsupported', message: `${adapter.name} 官方接口不支持该发布类型（${postType}）` };
  }
  const videos = input.media.filter((m) => m.fileType === 'video').length;
  if (!input.media.length) return { code: 'platform.media_unsupported', message: '没有素材' };
  if (input.media.some((m) => m.status !== 'ready' || m.deletedAt)) return { code: 'platform.media_not_ready', message: '素材未就绪' };
  if (input.media.length > 1 && !caps.publishCarousel) return { code: 'platform.media_unsupported', message: `${adapter.name} 不支持多素材帖子` };
  if (input.media.length === 1 && videos === 1 && !caps.publishVideo) return { code: 'platform.media_unsupported', message: `${adapter.name} 不支持发布视频` };
  if (input.media.length === 1 && videos === 0 && !caps.publishImage) return { code: 'platform.media_unsupported', message: `${adapter.name} 不支持通过 API 发布图片` };
  return adapter.publishUnavailableReason(input, await appOptions(account.platform));
}

/** Publishes through the official API. state 'awaiting_operator' = sent to the creator's drafts/inbox. */
export async function apiPublish(account: SocialAccount, input: PublishInput, opts: CallOpts = {}): Promise<PublishResult> {
  const adapter = requireAdapter(account.platform);
  return withConnection(account.id, (a) => adapter.publish(a, input), opts);
}

export async function apiListComments(account: SocialAccount, cursor: string | null, opts: CallOpts = {}): Promise<CommentPage> {
  const adapter = requireAdapter(account.platform);
  return withConnection(account.id, (a) => adapter.listComments(a, cursor), opts);
}

export async function apiReplyToComment(account: SocialAccount, commentId: string, text: string, opts: CallOpts = {}): Promise<{ id: string }> {
  const adapter = requireAdapter(account.platform);
  return withConnection(account.id, (a) => adapter.replyToComment(a, commentId, text), opts);
}

/** Own-account counters + day activity (账号分析) for UTC `days`; scope gaps come back in `missing`. */
export async function apiAccountStats(account: SocialAccount, days: string[], opts: CallOpts = {}): Promise<AccountStats> {
  const adapter = requireAdapter(account.platform);
  return withConnection(account.id, (a) => adapter.fetchAccountStats(a, days), opts);
}

/** The account's own recent posts with per-post counters (capability accountPosts), newest first. */
export async function apiOwnPosts(account: SocialAccount, maxPages: number, opts: CallOpts = {}): Promise<OwnPost[]> {
  const adapter = requireAdapter(account.platform);
  const fetch = adapter.fetchOwnPosts;
  if (!fetch) return [];
  return withConnection(account.id, (a) => fetch(a, maxPages), opts);
}

/** Capabilities of the account's platform given the admin's app options (null = no adapter). */
export async function platformCapabilities(platform: string) {
  const adapter = adapterById(platform);
  return adapter ? adapter.capabilities(await appOptions(platform)) : null;
}
