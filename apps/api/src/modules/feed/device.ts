import { setTimeout as sleep } from 'node:timers/promises';
import { HttpError } from '../../lib/errors.js';
import { adb, stf } from '../../services.js';
import type { CollectorDevice } from '../tracked/collector.js';
import { classifyIgDump, dumpExcerpt, requireApp, screenProblem, type UiNode } from '../tracked/instagram-device.js';
import {
  commentKey, commentListBounds, firstGridItem, IgScreenSession, isCommentsSheet, isPostList, normText, parseCommentRows, parseComposer,
  parseMediaIdList, parsePostScreen, parseRelativeTime, permalinkOf, pkTime, sessionUserPk, shortcodeOf, type CommentRow,
} from './ig-ui.js';

/**
 * The two device flows of the account feed (owner decision 2026-11-18), both inside a withDevice operation:
 *
 * - collectIgFeed: profile deep link → header (posts count) → tap the first grid item → media ids from
 *   `dumpsys activity top` → the N newest posts, each opened by its /p/<shortcode>/ deep link → counts and
 *   caption → tap the comment button → read the first M top-level comments (scrolling the sheet). Read only.
 * - sendIgComment: (own profile check when the account's numeric id is unknown) → open the post → check the
 *   logged-in account (session user id) → open the comments → (reply) find the comment, tap its 回复 → paste
 *   the person's text through STF's clipboard.paste (works for any script/emoji; `input text` doesn't) → read
 *   the field back → screenshot → tap 发布 and read back until the comment shows (sent), never retried after the
 *   tap. There is no test mode any more (owner decision 2026-11-18): a person saved the reply as a draft and
 *   scheduled it, so a run sends for real.
 *
 * Every dump is deleted at once, HOME at the end (also after failures). Only the taps/scrolls needed to open the
 * post, the comments and the reply field, plus the paste and 发布: no likes, follows, DMs, profile edits.
 */
export const SCREEN_GAP_MS = 3000;
const MAX_SCROLLS = 12;

const coded = (status: number, code: string, message: string, extra: Record<string, unknown> = {}) => Object.assign(new HttpError(status, message, code), extra);
type Log = (level: 'info' | 'warn' | 'error', message: string, data?: Record<string, unknown>) => Promise<void>;

// ---------------------------------------------------------------- collection

export interface CollectedComment { key: string; author: string; text: string; likes: number | null; replyCount: number | null; publishedAt: Date | null; position: number }
export interface CollectedPost {
  pk: string; shortcode: string; url: string; publishedAt: Date; mediaType: string | null; caption: string | null;
  likes: number | null; comments: number | null; approx: string[]; commentRows: CollectedComment[] | null;
}
export interface FeedResult {
  posts: CollectedPost[];
  postsCount: number | null;
  private: boolean;
  /** Numeric id of the account logged in on the phone (session), when seen. */
  sessionPk: string | null;
  screens: number;
  skipped: { pk: string; code: string }[];
}

/** Coded collection failure; `kind` challenge = halt the device. */
export class FeedScreenError extends HttpError {
  constructor(readonly kind: 'challenge' | 'login' | 'unavailable' | 'timeout' | 'parse', code: string, message: string, readonly excerpt?: string) { super(kind === 'unavailable' ? 404 : 409, message, code); }
}

const problemError = (p: 'challenge' | 'login' | 'not_found', nodes: UiNode[], what: string) =>
  p === 'challenge' ? new FeedScreenError('challenge', 'feed.challenge', 'Instagram 显示了验证/限制页面：设备的自动操作已暂停，需管理员在云机管理的设备卡片上恢复', dumpExcerpt(nodes))
    : p === 'login' ? new FeedScreenError('login', 'feed.logged_out', '设备上的 Instagram 未登录', dumpExcerpt(nodes))
      : new FeedScreenError('unavailable', 'feed.unavailable', `${what} 无法显示（不存在、已删除或无法加载）`, dumpExcerpt(nodes));

/** Reads the first `limit` top-level comments of the open comments sheet, scrolling as needed. */
async function readComments(s: IgScreenSession, postPk: string, limit: number, now: Date): Promise<CollectedComment[]> {
  const out = new Map<string, CollectedComment>();
  let stale = 0;
  for (let i = 0; i <= MAX_SCROLLS && out.size < limit; i++) {
    const nodes = await s.dump();
    const before = out.size;
    for (const r of parseCommentRows(nodes)) {
      const key = commentKey(postPk, r.author, r.text);
      const prev = out.get(key);
      if (prev) { prev.replyCount ??= r.replyCount; continue; }
      if (out.size >= limit) break;
      out.set(key, { key, author: r.author, text: r.text, likes: r.likes, replyCount: r.replyCount, publishedAt: r.timeLabel ? parseRelativeTime(r.timeLabel, now) : null, position: out.size });
    }
    if (out.size >= limit) break;
    stale = out.size === before ? stale + 1 : 0;
    if (stale >= 2) break; // end of the list (or nothing loads)
    const b = commentListBounds(nodes);
    if (!b) break;
    await s.scrollUp(b);
    await sleep(1200, undefined, { signal: s.signal });
  }
  return [...out.values()];
}

export async function collectIgFeed(dev: CollectorDevice, handle: string, opts: { posts: number; commentsPerPost: number; log: Log; signal?: AbortSignal }): Promise<FeedResult> {
  const { log } = opts;
  const s = new IgScreenSession(dev, opts.signal);
  const res: FeedResult = { posts: [], postsCount: null, private: false, sessionPk: null, screens: 0, skipped: [] };
  try {
    await requireApp(dev, 'feed.app_missing');
    await s.open(`https://www.instagram.com/${handle}/`);
    await log('info', 'feed: profile opened', { handle });
    const decided = (nodes: UiNode[]) => ['profile', 'challenge', 'login', 'not_found'].includes(classifyIgDump(nodes, handle).kind);
    let { nodes } = await s.waitFor(decided, 15_000, 2500);
    const screen = classifyIgDump(nodes, handle);
    if (screen.kind === 'challenge' || screen.kind === 'login' || screen.kind === 'not_found') throw problemError(screen.kind, nodes, `Instagram 主页 @${handle}`);
    if (screen.kind === 'shell') throw problemError('not_found', nodes, `Instagram 主页 @${handle}`);
    if (screen.kind !== 'profile') throw new FeedScreenError('timeout', 'feed.timeout', '等待页面超时', dumpExcerpt(nodes));
    res.postsCount = screen.counts.posts?.value ?? null;
    res.private = screen.private;
    if (res.postsCount === 0 || opts.posts <= 0) {
      await log('info', 'feed: no posts on the profile', { posts: res.postsCount });
      return res;
    }
    let grid = firstGridItem(nodes);
    if (!grid) {
      ({ nodes } = await s.waitFor((n) => !!firstGridItem(n), 8000, 500));
      grid = firstGridItem(nodes);
    }
    if (!grid) {
      if (screen.private) { await log('info', 'feed: private account, posts not visible'); return res; }
      throw new FeedScreenError('timeout', 'feed.timeout', '主页的帖子网格没有显示', dumpExcerpt(nodes));
    }
    await sleep(SCREEN_GAP_MS, undefined, { signal: opts.signal });
    await s.tap({ x: Math.round((grid.bounds![0] + grid.bounds![2]) / 2), y: Math.round((grid.bounds![1] + grid.bounds![3]) / 2) });
    s.screens++;
    ({ nodes } = await s.waitFor(isPostList, 12_000, 2000));
    let top = await s.activityTop();
    let ids = parseMediaIdList(top);
    if (!ids.length) { await sleep(2000, undefined, { signal: opts.signal }); top = await s.activityTop(); ids = parseMediaIdList(top); }
    res.sessionPk = sessionUserPk(top);
    if (!ids.length) {
      const p = isPostList(nodes) ? null : screenProblem(nodes);
      if (p) throw problemError(p, nodes, '帖子');
      throw new FeedScreenError('parse', 'feed.parse_failed', '读取不到帖子列表', dumpExcerpt(nodes));
    }
    const newest = [...new Map(ids.map((x) => [x.pk, x])).values()].sort((a, b) => (BigInt(b.pk) > BigInt(a.pk) ? 1 : -1)).slice(0, opts.posts);
    await log('info', 'feed: post ids read', { grid: ids.length, newest: newest.map((x) => shortcodeOf(x.pk)) });
    const now = new Date();
    for (const { pk } of newest) {
      await sleep(SCREEN_GAP_MS, undefined, { signal: opts.signal });
      const url = permalinkOf(pk);
      await s.open(url);
      ({ nodes } = await s.waitFor((n) => !!parsePostScreen(n, handle) || !!screenProblem(n), 15_000, 2500));
      const post = parsePostScreen(nodes, handle);
      if (!post) {
        const p = screenProblem(nodes);
        if (p === 'challenge' || p === 'login') throw problemError(p, nodes, '帖子');
        res.skipped.push({ pk, code: p === 'not_found' ? 'feed.post_unavailable' : 'feed.timeout' });
        await log('warn', 'feed: post did not show', { shortcode: shortcodeOf(pk), excerpt: dumpExcerpt(nodes) });
        continue;
      }
      let commentRows: CollectedComment[] | null = null;
      if (opts.commentsPerPost > 0 && post.comments !== 0 && post.commentButton) {
        await s.tap(post.commentButton);
        const sheet = await s.waitFor(isCommentsSheet, 10_000, 1500);
        if (sheet.ok) commentRows = await readComments(s, pk, opts.commentsPerPost, now);
        else await log('warn', 'feed: comments did not open', { shortcode: shortcodeOf(pk), excerpt: dumpExcerpt(sheet.nodes) });
        await s.keys(4);
      } else if (post.comments === 0) commentRows = [];
      res.posts.push({
        pk, shortcode: shortcodeOf(pk), url, publishedAt: pkTime(pk), mediaType: post.mediaType, caption: post.caption,
        likes: post.likes, comments: post.comments, approx: post.approx, commentRows,
      });
      await log('info', 'feed: post read', { shortcode: shortcodeOf(pk), likes: post.likes, comments: post.comments, commentsRead: commentRows?.length ?? null });
    }
    return res;
  } finally {
    res.screens = s.screens;
    await s.close();
  }
}

// ---------------------------------------------------------------- sending a comment / reply

/** Coded failure of a device send. `afterSend` = the 发布 tap happened (never retried); `challenge` = halt the device. */
export class ReplyDeviceError extends HttpError {
  constructor(code: string, message: string, readonly opts: { final?: boolean; afterSend?: boolean; challenge?: boolean; excerpt?: string } = {}) { super(409, message, code); }
}

export interface SendInput {
  shortcode: string;
  postPk: string;
  /** The account's handle (the logged-in account must be this one). */
  handle: string;
  /** The account's numeric id; null = verify via its own profile (one more screen). */
  externalId: string | null;
  /** Reply to this comment (author + text as read on screen); null = comment directly under the post. */
  replyTo: { author: string; text: string; key: string } | null;
  text: string;
  log: Log;
  signal?: AbortSignal;
}
export interface SendResult { outcome: 'sent'; inputText: string; excerpt: string; screenshot: Buffer | null; screens: number }

const fail = (code: string, message: string, o: ConstructorParameters<typeof ReplyDeviceError>[2] = { final: true }) => new ReplyDeviceError(code, message, o);

/** Clears the composer (verified by reading it back); throws when text stays. */
async function clearComposer(s: IgScreenSession, len: number): Promise<void> {
  for (let i = 0; i < 2; i++) {
    await s.clearField(len + 10);
    await sleep(800, undefined, { signal: s.signal });
    const c = parseComposer(await s.dump());
    if (!c || c.empty) return;
    len = c.text.length;
  }
  throw fail('comment.device_clear_failed', '输入框清空失败，请在远程控制中检查设备');
}

/** Finds the comment in the open sheet and taps its 回复 (scrolling). */
async function openReply(s: IgScreenSession, postPk: string, to: NonNullable<SendInput['replyTo']>): Promise<CommentRow> {
  let stale = 0;
  const seen = new Set<string>();
  for (let i = 0; i <= MAX_SCROLLS; i++) {
    const nodes = await s.dump();
    const rows = parseCommentRows(nodes);
    const match = rows.find((r) => commentKey(postPk, r.author, r.text) === to.key)
      ?? rows.find((r) => r.author.toLowerCase() === to.author.toLowerCase() && normText(r.text) === normText(to.text));
    if (match?.replyButton) {
      await s.tap(match.replyButton);
      const c = await s.waitFor((n) => parseComposer(n)?.replyingTo?.toLowerCase() === to.author.toLowerCase(), 6000, 800);
      if (!c.ok) throw fail('comment.device_comment_not_found', '点了“回复”但没有进入回复状态', { final: true, excerpt: dumpExcerpt(c.nodes) });
      return match;
    }
    const before = seen.size;
    for (const r of rows) seen.add(commentKey(postPk, r.author, r.text));
    stale = seen.size === before && !match ? stale + 1 : 0;
    if (stale >= 2) break;
    const b = commentListBounds(nodes);
    if (!b) break;
    // The row is there but its 回复 is cut off at the bottom: a short scroll is enough.
    if (match) await s.sh(`input swipe ${Math.round((b[0] + b[2]) / 2)} ${b[3] - 60} ${Math.round((b[0] + b[2]) / 2)} ${b[3] - 360} 400`);
    else await s.scrollUp(b);
    await sleep(1200, undefined, { signal: s.signal });
  }
  throw fail('comment.device_comment_not_found', `在帖子下找不到 @${to.author} 的这条评论（可能已删除或排在很后面）`);
}

export async function sendIgComment(dev: CollectorDevice, input: SendInput): Promise<SendResult> {
  const { log } = input;
  const s = new IgScreenSession(dev, input.signal);
  let dirty = false;
  try {
    await requireApp(dev, 'comment.device_app_missing');
    if (!input.externalId) {
      // Unknown numeric id: the logged-in account's own profile must show this handle.
      await s.open('instagram://profile');
      const { nodes } = await s.waitFor((n) => ['profile', 'challenge', 'login'].includes(classifyIgDump(n, null).kind), 15_000, 2500);
      const own = classifyIgDump(nodes, null);
      if (own.kind === 'challenge') throw fail('comment.device_challenge', 'Instagram 显示了验证/限制页面', { final: true, challenge: true, excerpt: dumpExcerpt(nodes) });
      if (own.kind === 'login') throw fail('comment.device_logged_out', '设备上的 Instagram 未登录');
      if (own.kind !== 'profile' || !own.handle) throw new ReplyDeviceError('comment.device_timeout', '读取设备上登录的账号超时', { excerpt: dumpExcerpt(nodes) });
      if (own.handle.toLowerCase() !== input.handle.toLowerCase()) throw fail('comment.device_wrong_account', `设备上登录的是 @${own.handle}，不是 @${input.handle}`);
      await sleep(SCREEN_GAP_MS, undefined, { signal: input.signal });
    }
    await s.open(`https://www.instagram.com/p/${input.shortcode}/`);
    await log('info', 'reply: post opened', { shortcode: input.shortcode });
    let { nodes } = await s.waitFor((n) => !!parsePostScreen(n, null) || !!screenProblem(n), 15_000, 2500);
    const post = parsePostScreen(nodes, null);
    if (!post) {
      const p = screenProblem(nodes);
      if (p === 'challenge') throw fail('comment.device_challenge', 'Instagram 显示了验证/限制页面', { final: true, challenge: true, excerpt: dumpExcerpt(nodes) });
      if (p === 'login') throw fail('comment.device_logged_out', '设备上的 Instagram 未登录');
      if (p === 'not_found') throw fail('comment.device_post_not_found', '帖子无法显示（可能已删除）');
      throw new ReplyDeviceError('comment.device_timeout', '等待帖子页面超时', { excerpt: dumpExcerpt(nodes) });
    }
    if (input.externalId) {
      const pk = sessionUserPk(await s.activityTop());
      if (!pk) throw fail('comment.device_account_unverified', '无法确认设备上登录的账号');
      if (pk !== input.externalId) throw fail('comment.device_wrong_account', `设备上登录的账号（ID ${pk}）不是 @${input.handle}`);
    }
    if (!post.commentButton) throw fail('comment.device_comments_closed', '这个帖子没有评论入口（可能关闭了评论）');
    await s.tap(post.commentButton);
    const sheet = await s.waitFor(isCommentsSheet, 10_000, 1500);
    if (!sheet.ok) {
      const p = screenProblem(sheet.nodes);
      if (p === 'challenge') throw fail('comment.device_challenge', 'Instagram 显示了验证/限制页面', { final: true, challenge: true, excerpt: dumpExcerpt(sheet.nodes) });
      throw new ReplyDeviceError('comment.device_timeout', '评论区没有打开', { excerpt: dumpExcerpt(sheet.nodes) });
    }
    await log('info', 'reply: comments opened');
    if (input.replyTo) {
      await openReply(s, input.postPk, input.replyTo);
      await log('info', 'reply: replying to the comment', { author: input.replyTo.author });
    } else {
      const c = parseComposer(sheet.nodes);
      if (!c?.field) throw new ReplyDeviceError('comment.device_timeout', '找不到评论输入框');
      await s.tap(c.field);
      await sleep(800, undefined, { signal: input.signal });
    }
    // Text: STF clipboard.paste (any script / emoji); `input text` can't type them.
    const dev2 = await stf.getDevice(adb.serialFor(dev.adbPort)).catch(() => null);
    if (!dev2?.channel) throw new ReplyDeviceError('comment.device_input_unavailable', '设备在 STF 中不可用，无法输入文字');
    await stf.claim(dev2.serial).catch(() => undefined);
    dirty = true;
    await stf.paste(dev2.channel, input.text);
    const want = normText(input.text);
    const filled = await s.waitFor((n) => normText(parseComposer(n)?.text ?? '').endsWith(want), 6000, 600);
    const composer = parseComposer(filled.nodes);
    if (!filled.ok || !composer) throw fail('comment.device_text_mismatch', '输入框里的文字与回复内容不一致', { final: true, excerpt: (composer?.text ?? '').slice(0, 200) });
    const inputText = composer.text;
    await log('info', 'reply: text pasted and read back', { length: inputText.length, replyingTo: composer.replyingTo });
    const screenshot = await s.screenshot().catch(() => null);
    const excerpt = `${composer.replyingTo ? `replying to ${composer.replyingTo} · ` : ''}input: ${inputText}`.slice(0, 300);
    if (!composer.postButton) throw fail('comment.device_timeout', '找不到“发布”按钮');
    await s.tap(composer.postButton);
    dirty = false;
    const me = input.handle.toLowerCase();
    const done = await s.waitFor((n) => {
      const c = parseComposer(n);
      return !!c?.empty && parseCommentRows(n).some((r) => r.author.toLowerCase() === me && normText(r.text).includes(want));
    }, 15_000, 1500);
    if (!done.ok) {
      const rows = new Set(parseCommentRows(done.nodes).map((r) => r.text));
      const p = screenProblem(done.nodes.filter((n) => !rows.has(n.text) && !rows.has(n.desc)));
      throw new ReplyDeviceError('comment.send_uncertain', '已点“发布”，但没能在评论区确认这条评论', { final: true, afterSend: true, challenge: p === 'challenge', excerpt: dumpExcerpt(done.nodes) });
    }
    await log('info', 'reply: sent and seen in the comments');
    return { outcome: 'sent', inputText, excerpt, screenshot, screens: s.screens };
  } finally {
    if (dirty) {
      // Never leave typed text behind after a failure.
      const c = parseComposer(await s.dump().catch(() => [] as UiNode[]));
      if (c && !c.empty) await clearComposer(s, c.text.length).catch(async (err) => { await log('error', 'reply: the input field could not be cleared', { error: (err as Error).message }); });
    }
    await s.close();
  }
}
