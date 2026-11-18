import { createHash, randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { adb } from '../../services.js';
import type { CollectorDevice } from '../tracked/collector.js';
import { ID, parseCompactCount, parseUiDump, PKG, type UiNode } from '../tracked/instagram-device.js';

/**
 * Instagram app screens beyond the profile header (account feed: posts + comments, and comments sent from the
 * cloud phone). Pure parsers over `uiautomator dump` nodes plus a small screen session (open a deep link, dump,
 * tap, swipe, keys, read `dumpsys activity top`). Probed on bit-ins-02 on 2026-11-18 (Instagram 433.0.0.42.68,
 * Android 16, zh-CN UI); dumps of that probe are the reference for these parsers:
 *
 * - profile grid: `#image_button` buttons ("National Geographic的3张照片，第1行，第1列"); pinned posts come first.
 * - tapping a grid item opens the contextual feed; `dumpsys activity top` then lists the grid's media ids
 *   (`ContextualFeedFragment.ARGUMENT_MEDIA_ID_LIST=[<media pk>_<owner pk>, …]`). The media pk is the stable
 *   post id: its top bits are the creation time (ms since the Instagram epoch) and its base-64 form is the
 *   shortcode of https://www.instagram.com/p/<shortcode>/, which opens the post in the app. The newest N posts
 *   = the N largest pks (so pinned posts don't count as new).
 * - post screen: `#row_feed_profile_header` ("natgeo于11小时前发布了video"), `#row_feed_view_group_buttons` with
 *   `#row_feed_button_like` / `#row_feed_button_comment` each followed by a count button ("9,138", "1.4万"),
 *   photo media desc "照片1/3，创作者：…, 14,563次赞, 57条评论" (exact counts), caption = the IgTextLayoutView's
 *   text after the owner's handle. `dumpsys activity top` shows `IgSessionManager.SESSION_TOKEN_KEY=…:<pk>`, the
 *   numeric id of the account logged in on the phone.
 * - comments sheet (after tapping the comment button): rows without resource ids: avatar "前往X的主页" /
 *   "查看X的快拍", author TextView "X ", time "11小时前", text "X表示<text>", "回复" (reply), "N次赞…" (likes),
 *   "查看另外N条回复" (collapsed replies). Composer `#layout_comment_thread_edittext_multiline` (empty: text ==
 *   hint), post button `#layout_comment_thread_post_button_icon`; replying shows "正在回复X" and pre-fills "@X ".
 * English strings are matched too but were not seen live.
 */

// ---------------------------------------------------------------- media ids

const IG_EPOCH_MS = 1314220021721;
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

export function shortcodeOf(pk: string): string {
  let n = BigInt(pk);
  let s = '';
  while (n > 0n) { s = B64[Number(n % 64n)]! + s; n /= 64n; }
  return s;
}
export function pkOfShortcode(code: string): string | null {
  let n = 0n;
  for (const ch of code) { const i = B64.indexOf(ch); if (i < 0) return null; n = n * 64n + BigInt(i); }
  return n > 0n ? n.toString() : null;
}
/** Creation time encoded in a media pk (ms precision). */
export const pkTime = (pk: string) => new Date(Number(BigInt(pk) >> 23n) + IG_EPOCH_MS);
export const permalinkOf = (pk: string) => `https://www.instagram.com/p/${shortcodeOf(pk)}/`;
/** Shortcode of a post link (/p/, /reel/, /tv/), else null. */
export const shortcodeOfUrl = (url: string | null | undefined) => (url ? /instagram\.com\/(?:[\w.]+\/)?(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/.exec(url)?.[1] ?? null : null);

/** Grid media ids from `dumpsys activity top` after a grid item was opened: [{pk, ownerPk}] in grid order. */
export function parseMediaIdList(top: string): { pk: string; ownerPk: string }[] {
  const m = /ARGUMENT_MEDIA_ID_LIST=\[([^\]]*)\]/.exec(top);
  if (!m) return [];
  return m[1]!.split(',').map((s) => s.trim()).map((s) => /^(\d+)_(\d+)$/.exec(s)).filter((x): x is RegExpExecArray => !!x).map((x) => ({ pk: x[1]!, ownerPk: x[2]! }));
}
/** The numeric id of the account logged in on the phone (from the foreground fragment's arguments). */
export const sessionUserPk = (top: string) => /IgSessionManager\.SESSION_TOKEN_KEY=[^,}\s]*:(\d+)/.exec(top)?.[1] ?? null;

// ---------------------------------------------------------------- text helpers

export const normText = (s: string) => s.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
/** Stable comment id (Instagram shows none): post pk + author + normalised text. Two identical comments by one author on one post collapse. */
export const commentKey = (postPk: string, author: string, text: string) =>
  `dev:${createHash('sha256').update(`${postPk}\n${author.toLowerCase()}\n${normText(text)}`).digest('hex').slice(0, 32)}`;

const REL = /^(\d+)\s*(秒|分钟|分鐘|小时|小時|天|周|週|s|m|h|d|w)(?:前| ago)?$/i;
/** "11小时前" / "3天前" / "2w" → approximate time; absolute dates ("10月27日") → that day (current or last year); else null. */
export function parseRelativeTime(label: string, now = new Date()): Date | null {
  const s = label.trim();
  const m = REL.exec(s);
  if (m) {
    const n = Number(m[1]);
    const unit = m[2]!.toLowerCase();
    const sec = unit === '秒' || unit === 's' ? 1 : unit.startsWith('分') || unit === 'm' ? 60 : unit.startsWith('小') || unit === 'h' ? 3600 : unit === '天' || unit === 'd' ? 86_400 : 7 * 86_400;
    return new Date(now.getTime() - n * sec * 1000);
  }
  const d = /^(?:(\d{4})年)?(\d{1,2})月(\d{1,2})日$/.exec(s);
  if (d) {
    const y = d[1] ? Number(d[1]) : now.getUTCFullYear();
    let t = new Date(Date.UTC(y, Number(d[2]) - 1, Number(d[3])));
    if (!d[1] && t > now) t = new Date(Date.UTC(y - 1, Number(d[2]) - 1, Number(d[3])));
    return t;
  }
  return null;
}
const isTimeLabel = (s: string) => REL.test(s.trim()) || /^(?:\d{4}年)?\d{1,2}月\d{1,2}日$/.test(s.trim());

const center = (n: UiNode) => (n.bounds ? { x: Math.round((n.bounds[0] + n.bounds[2]) / 2), y: Math.round((n.bounds[1] + n.bounds[3]) / 2) } : null);
const byRid = (nodes: UiNode[], suffix: string) => nodes.find((n) => n.rid === ID + suffix);

// ---------------------------------------------------------------- profile grid

/** First grid item (to open the contextual feed), null when the grid shows no post. */
export function firstGridItem(nodes: UiNode[]): UiNode | null {
  return nodes.find((n) => n.rid === `${ID}image_button` && n.bounds && n.bounds[3] - n.bounds[1] > 40) ?? null;
}
/**
 * The profile's grid shows no post ("发布你的第一篇帖子" / an empty-state view below the tabs). The own profile's
 * grid is cached: right after publishing (seen 2026-11-18 on bit-ins-02) the header already counted the new post
 * while the grid still showed this empty state (or the old posts) until a pull to refresh.
 */
export const isGridEmpty = (nodes: UiNode[]) => !!byRid(nodes, 'empty_state_view_root') || !!byRid(nodes, 'igds_empty_state_title');
/** Is the opened screen the contextual feed (a post list), i.e. did the grid tap land? */
export const isPostList = (nodes: UiNode[]) => !!byRid(nodes, 'row_feed_view_group_buttons');

// ---------------------------------------------------------------- post screen

export interface PostScreen {
  owner: string | null;
  mediaType: string | null;
  caption: string | null;
  likes: number | null;
  comments: number | null;
  approx: ('likes' | 'comments')[];
  commentButton: { x: number; y: number } | null;
}

/** The first post on screen (a /p/ deep link shows exactly one). null = no post structure. */
export function parsePostScreen(nodes: UiNode[], handle: string | null): PostScreen | null {
  const hi = nodes.findIndex((n) => n.rid === `${ID}row_feed_profile_header`);
  const bi = nodes.findIndex((n, i) => i > hi && n.rid === `${ID}row_feed_view_group_buttons`);
  if (bi < 0) return null;
  // Only this post's nodes: up to the next post header.
  const nextHeader = nodes.findIndex((n, i) => i > bi && n.rid === `${ID}row_feed_profile_header`);
  const post = nodes.slice(Math.max(hi, 0), nextHeader < 0 ? nodes.length : nextHeader);
  const headerDesc = hi >= 0 ? nodes[hi]!.desc : '';
  const mediaType = /发布了\s*(\w+)\s*$/.exec(headerDesc)?.[1]?.toLowerCase() ?? /posted an? (\w+)/i.exec(headerDesc)?.[1]?.toLowerCase() ?? null;
  const owner = byRid(post, 'row_feed_photo_profile_name')?.text.trim().split(/\s+/)[0] ?? null;
  const approx = new Set<'likes' | 'comments'>();
  const countAfter = (rid: string, metric: 'likes' | 'comments') => {
    const i = post.findIndex((n) => n.rid === ID + rid);
    if (i < 0) return null;
    const next = post[i + 1];
    const c = next && !next.rid && next.text ? parseCompactCount(next.text) : null;
    if (c?.approx) approx.add(metric);
    return c ? c.value : null;
  };
  let likes = countAfter('row_feed_button_like', 'likes');
  let comments = countAfter('row_feed_button_comment', 'comments');
  // A photo's media description carries exact counts ("…, 14,563次赞, 57条评论" / "…, 14,563 likes, 57 comments").
  const buttonsAt = post.findIndex((n) => n.rid === `${ID}row_feed_view_group_buttons`);
  for (const n of post.slice(0, buttonsAt)) {
    const l = /(\d[\d,]*)\s*(?:次赞|likes?\b)/.exec(n.desc)?.[1];
    const c = /(\d[\d,]*)\s*(?:条评论|comments?\b)/.exec(n.desc)?.[1];
    if (l) { likes = Number(l.replace(/,/g, '')); approx.delete('likes'); }
    if (c) { comments = Number(c.replace(/,/g, '')); approx.delete('comments'); }
    if (l || c) break;
  }
  const capNode = post.find((n) => n.cls.endsWith('IgTextLayoutView') && n.text.trim());
  let caption = capNode?.text.trim() ?? null;
  const who = handle ?? owner;
  if (caption && who && caption.toLowerCase().startsWith(`${who.toLowerCase()} `)) caption = caption.slice(who.length + 1).trim();
  // A collapsed caption ends with the app's "… 展开" / "… more" link (the /p/ page shows it in full).
  if (caption) caption = caption.replace(/(…|\.\.\.)\s*(展开|更多|more)$/i, '…').trim();
  const cb = byRid(post, 'row_feed_button_comment');
  return { owner, mediaType, caption: caption || null, likes, comments, approx: [...approx], commentButton: cb ? center(cb) : null };
}

// ---------------------------------------------------------------- comments sheet

export interface CommentRow {
  author: string;
  text: string;
  timeLabel: string | null;
  likes: number | null;
  replyCount: number | null;
  /** Centre of its "回复" button (null when cut off at the edge of the list). */
  replyButton: { x: number; y: number } | null;
  top: number;
}

const AVATAR = /^(?:前往(.+?)的主页|查看(.+?)的快拍|Go to (.+?)'s profile|View (.+?)'s story)$/;
const SAYS = /^(?:表示|說|说|said:?)\s?/;
const REPLY_BTN = /^(回复|回覆|Reply)$/;
const MORE_REPLIES = /^(?:查看另外\s*(\d+)\s*条回复|View (\d+) more repl(?:y|ies))$/;

/** Is the comments sheet open? (title "评论" / "Comments" and its list) */
export const isCommentsSheet = (nodes: UiNode[]) => !!byRid(nodes, 'layout_comment_thread_edittext_multiline') && nodes.some((n) => n.rid === `${ID}title_text_view` && /^(评论|評論|Comments)$/.test(n.text.trim()));

/** Comment rows visible in the open comments sheet, top to bottom. */
export function parseCommentRows(nodes: UiNode[]): CommentRow[] {
  const listIdx = nodes.findIndex((n) => n.rid === `${ID}sticky_header_list` && nodes.some((p) => p.rid === `${ID}bottom_sheet_container`));
  if (listIdx < 0) return [];
  const listDepth = nodes[listIdx]!.depth;
  const rows: CommentRow[] = [];
  let cur: (CommentRow & { textDone: boolean }) | null = null;
  const flush = () => { if (cur && cur.textDone && cur.text) rows.push({ author: cur.author, text: cur.text, timeLabel: cur.timeLabel, likes: cur.likes, replyCount: cur.replyCount, replyButton: cur.replyButton, top: cur.top }); };
  for (let i = listIdx + 1; i < nodes.length && nodes[i]!.depth > listDepth; i++) {
    const n = nodes[i]!;
    const av = AVATAR.exec(n.desc.trim());
    if (av) {
      flush();
      const author = (av[1] ?? av[2] ?? av[3] ?? av[4])!.trim();
      cur = { author, text: '', timeLabel: null, likes: null, replyCount: null, replyButton: null, top: n.bounds?.[1] ?? 0, textDone: false };
      continue;
    }
    if (!cur) continue;
    const label = (n.text || n.desc).trim();
    if (!cur.textDone && label && isTimeLabel(label)) { cur.timeLabel = label; continue; }
    const said = n.desc || n.text;
    if (!cur.textDone && said.startsWith(cur.author) && said.length > cur.author.length && SAYS.test(said.slice(cur.author.length))) {
      cur.text = said.slice(cur.author.length).replace(SAYS, '').trim();
      cur.textDone = true;
      continue;
    }
    if (REPLY_BTN.test(label) && n.clickable) { cur.replyButton = center(n); continue; }
    const lk = /^(\d[\d,.]*\s*[万萬千KkMm]?)\s*(?:次赞|likes?)/.exec(n.desc.trim());
    if (lk) { cur.likes = parseCompactCount(lk[1]!)?.value ?? null; continue; }
    if (n.desc.trim() === '赞' || /^like$/i.test(n.desc.trim())) { cur.likes ??= 0; continue; }
    const more = MORE_REPLIES.exec(label);
    if (more) { cur.replyCount = Number(more[1] ?? more[2]); continue; }
  }
  flush();
  return rows;
}

/** The scrollable comment list's bounds (for swipes). */
export function commentListBounds(nodes: UiNode[]): [number, number, number, number] | null {
  return nodes.find((n) => n.rid === `${ID}sticky_header_list` && n.bounds && n.bounds[1] > 200 && nodes.some((p) => p.rid === `${ID}bottom_sheet_container`))?.bounds ?? null;
}

export interface Composer { text: string; empty: boolean; replyingTo: string | null; field: { x: number; y: number } | null; postButton: { x: number; y: number } | null; cancelReply: { x: number; y: number } | null }

export function parseComposer(nodes: UiNode[]): Composer | null {
  const f = byRid(nodes, 'layout_comment_thread_edittext_multiline');
  if (!f) return null;
  const text = f.text;
  const empty = !text.trim() || (!!f.hint && text === f.hint);
  const rep = nodes.map((n) => /^(?:正在回复|正在回覆|Replying to)\s*(.+)$/.exec((n.text || n.desc).trim())).find(Boolean);
  const cancel = nodes.find((n) => /^(取消回复|取消回覆|Cancel reply)$/i.test(n.desc.trim()));
  const pb = byRid(nodes, 'layout_comment_thread_post_button_icon');
  return { text: empty ? '' : text, empty, replyingTo: rep?.[1]?.trim() ?? null, field: center(f), postButton: pb ? center(pb) : null, cancelReply: cancel ? center(cancel) : null };
}

// ---------------------------------------------------------------- screen session

/**
 * One series of screens on the phone inside a withDevice operation. Every dump goes to a random file under
 * /data/local/tmp that is read and deleted in the same shell call; `close()` goes HOME and removes it again.
 */
export class IgScreenSession {
  readonly file = `/data/local/tmp/cp-ig-${randomBytes(6).toString('hex')}.xml`;
  /** Screens opened (deep links + grid taps), for the logs and the visit budget. */
  screens = 0;
  constructor(readonly dev: CollectorDevice, readonly signal?: AbortSignal) {}

  sh(cmd: string, timeoutMs = 20_000) { return adb.shell(this.dev.adbPort, cmd, timeoutMs); }

  async open(url: string): Promise<void> {
    const out = await this.sh(`am start -a android.intent.action.VIEW -d '${url.replace(/'/g, '')}' -p ${PKG}`);
    if (/Error:|Exception/.test(out)) throw Object.assign(new Error(`open failed: ${out.trim().slice(0, 150)}`), { code: 'feed.open_failed' });
    this.screens++;
  }

  async dump(): Promise<UiNode[]> {
    this.signal?.throwIfAborted();
    return parseUiDump(await this.sh(`uiautomator dump ${this.file} >/dev/null 2>&1; cat ${this.file} 2>/dev/null; rm -f ${this.file}`));
  }

  /** Dumps until `ok(nodes)` or the deadline; returns the last dump. */
  async waitFor(ok: (nodes: UiNode[]) => boolean, ms = 15_000, firstDelayMs = 2000): Promise<{ nodes: UiNode[]; ok: boolean }> {
    const deadline = Date.now() + ms;
    await sleep(firstDelayMs, undefined, { signal: this.signal });
    for (;;) {
      const nodes = await this.dump();
      if (ok(nodes)) return { nodes, ok: true };
      if (Date.now() >= deadline) return { nodes, ok: false };
      await sleep(1200, undefined, { signal: this.signal });
    }
  }

  async tap(p: { x: number; y: number }): Promise<void> { await this.sh(`input tap ${p.x} ${p.y}`); }
  /** Vertical swipe inside `b` (list bounds) moving the content up by ~60 % of its height. */
  async scrollUp(b: [number, number, number, number]): Promise<void> {
    const x = Math.round((b[0] + b[2]) / 2);
    const h = b[3] - b[1];
    await this.sh(`input swipe ${x} ${Math.round(b[3] - h * 0.15)} ${x} ${Math.round(b[1] + h * 0.25)} 450`);
  }
  /** Pull to refresh: a downward swipe from the profile header (coordinates verified on bit-ins-02's 1080×2374 screen). */
  async pullToRefresh(): Promise<void> { await this.sh('input swipe 540 900 540 1900 400'); }
  async keys(...codes: number[]): Promise<void> { if (codes.length) await this.sh(`input keyevent ${codes.join(' ')}`); }
  /** Clears the focused text field: cursor to the end, then delete `n` characters. */
  async clearField(n: number): Promise<void> { await this.keys(123); await this.keys(...Array.from({ length: Math.min(Math.max(n, 1), 400) }, () => 67)); }
  async activityTop(): Promise<string> { return this.sh('dumpsys activity top', 30_000); }
  async screenshot(): Promise<Buffer> { return adb.screenshot(this.dev.adbPort); }
  /** Back to the launcher, no dump file left. Never throws. */
  async close(): Promise<void> { await this.sh(`input keyevent 3; rm -f ${this.file}`, 10_000).catch(() => undefined); }
}
