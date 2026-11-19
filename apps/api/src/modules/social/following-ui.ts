import { ID, type UiNode } from '../tracked/instagram-device.js';

/**
 * 追踪中 (following list) screens of the Instagram app, pure parsers over `uiautomator dump` nodes. Probed on
 * bit-ins-02 on 2026-11-18 (Instagram 433, Android 16, zh-CN UI, account conchadoroperto650 following 6):
 *
 * - own profile: the 关注 counter is `#profile_header_following_stacked_familiar` (clickable, desc "6关注"; the value
 *   node `#profile_header_familiar_following_value` inside it). Tapping it opens UnifiedFollowFragment on the
 *   following tab.
 * - list screen: tab bar `#unified_follow_list_tab_layout` with `#title` buttons "粉丝 (0)" / "关注 (6)" / "订阅 (0)" /
 *   "已标记"; the active one has selected=true. List `android:id/list` inside `#unified_follow_list_view_pager`:
 *   search field, sort row, then one `#follow_list_container` per account with `#follow_list_username` (full handle,
 *   even when the screen shows it shortened), `#follow_list_subtitle` (display name), optional `#unseen_posts_text`
 *   ("4篇新帖"), and the row's buttons `#follow_list_row_large_follow_button` (发消息 / 关注 / 已关注) and
 *   `#media_option_button` (更多选项), which are NEVER tapped. The end of the list is followed by the suggestions
 *   header `#row_header_textview` "为你推荐" and `#row_recommended_user_*` rows (not part of the list).
 * - the verified badge is drawn inside the username text (not a node), so `verified` is not readable here (null).
 * English strings are matched too but were not seen live.
 *
 * 粉丝 (followers list, owner 2026-11-19, ≤ 20 newest per run): the same UnifiedFollowFragment, tab "粉丝 (N)". It was
 * NOT probed live: the rows are assumed to carry the same ids as the following tab (a 移除 / 回关 button may sit in
 * the row; any clickable node inside a row other than the avatar counts as a button, swipes stay left of them). The
 * reader checks the selected tab title before reading and gives up with a code when anything differs.
 */

export type FollowListKind = 'following' | 'followers';
export interface FollowingRow { handle: string; displayName: string | null; top: number }
export interface FollowingScreen {
  /** The tab of the requested list (关注 / 粉丝) is the selected one. */
  onFollowingTab: boolean;
  /** Count in that tab's title ("关注 (6)"), null when absent. */
  tabCount: number | null;
  rows: FollowingRow[];
  /** The suggestions header below the list is visible = the list ended. */
  end: boolean;
  /** Bounds of the scrollable list (for swipes), null when not found. */
  list: [number, number, number, number] | null;
  /** Left edge of the row buttons (swipes stay left of it). */
  buttonsLeft: number | null;
}

const COUNT = String.raw`\s*(?:[(（]\s*([\d,.]+\s*[万萬千KkMm]?)\s*[)）])?$`;
const TAB: Record<FollowListKind, RegExp> = {
  following: new RegExp(String.raw`^(?:关注|正在关注|追踪中|追蹤中|Following)` + COUNT),
  followers: new RegExp(String.raw`^(?:粉丝|粉絲|Followers)` + COUNT),
};
const END_HEADER = /^(为你推荐|為你推薦|推荐用户|Suggested for you|Suggestions for you)$/i;

const tabCountOf = (raw: string | undefined): number | null => {
  if (!raw) return null;
  const s = raw.replace(/\s/g, '');
  const m = /^([\d.,]+)([万萬千KkMm])?$/.exec(s);
  if (!m) return null;
  const mult = !m[2] ? 1 : /[万萬]/.test(m[2]) ? 1e4 : /千|k/i.test(m[2]) ? 1e3 : 1e6;
  return Math.round(Number(m[2] ? m[1]!.replace(',', '.') : m[1]!.replace(/[,.]/g, '')) * mult);
};

/** Is this the follow-list screen (tab bar present)? */
export const isFollowList = (nodes: UiNode[]) => nodes.some((n) => n.rid === `${ID}unified_follow_list_tab_layout`);

export function parseFollowingScreen(nodes: UiNode[], kind: FollowListKind = 'following'): FollowingScreen {
  const re = TAB[kind];
  const tabs = nodes.filter((n) => n.rid === `${ID}title` && re.test(n.text.trim()));
  const tab = tabs.find((n) => n.selected) ?? null;
  const tabCount = tabCountOf(re.exec((tab ?? tabs[0])?.text.trim() ?? '')?.[1]);
  const rows: FollowingRow[] = [];
  let buttonsLeft: number | null = null;
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i]!;
    if (n.rid === `${ID}follow_list_row_large_follow_button` && n.bounds) buttonsLeft = Math.min(buttonsLeft ?? n.bounds[0], n.bounds[0]);
    if (n.rid !== `${ID}follow_list_container`) continue;
    let handle = '';
    let displayName: string | null = null;
    for (let j = i + 1; j < nodes.length && nodes[j]!.depth > n.depth; j++) {
      const c = nodes[j]!;
      // any other clickable node in the row (发消息 / 关注 / 移除 / 更多…) is a button: swipes stay left of it
      if (c.clickable && c.bounds && c.rid !== `${ID}follow_list_user_imageview` && c.bounds[0] > (n.bounds?.[0] ?? 0) + 200) buttonsLeft = Math.min(buttonsLeft ?? c.bounds[0], c.bounds[0]);
      if (c.rid === `${ID}follow_list_username`) handle = c.text.trim();
      else if (c.rid === `${ID}follow_list_subtitle`) displayName = c.text.trim() || null;
    }
    // Instagram usernames: letters, digits, '.', '_' (≤ 30); anything else is not a list row.
    if (/^[A-Za-z0-9._]{1,30}$/.test(handle)) rows.push({ handle: handle.toLowerCase(), displayName, top: n.bounds?.[1] ?? 0 });
  }
  const end = nodes.some((n) => n.rid === `${ID}row_header_textview` && END_HEADER.test(n.text.trim()))
    || nodes.some((n) => n.rid.startsWith(`${ID}row_recommended_user_`));
  const listNode = nodes.find((n) => n.rid === 'android:id/list' && n.bounds) ?? null;
  return { onFollowingTab: !!tab, tabCount, rows, end, list: listNode?.bounds ?? null, buttonsLeft };
}

/** The 关注 (or 粉丝) counter on the own profile (tap target), null when not on screen. */
export function followingCounter(nodes: UiNode[], kind: FollowListKind = 'following'): { x: number; y: number } | null {
  const n = nodes.find((x) => x.rid === `${ID}profile_header_${kind}_stacked_familiar` && x.bounds)
    ?? nodes.find((x) => x.rid === `${ID}profile_header_familiar_${kind}_value` && x.bounds);
  if (!n?.bounds) return null;
  return { x: Math.round((n.bounds[0] + n.bounds[2]) / 2), y: Math.round((n.bounds[1] + n.bounds[3]) / 2) };
}

/**
 * A vertical swipe that moves the list content up by ~55 % of its height, at an x left of the row buttons
 * (inside the username column, never on a button; a swipe of this length is not a tap).
 */
export function listSwipe(s: Pick<FollowingScreen, 'list' | 'buttonsLeft'>): { x: number; y1: number; y2: number } | null {
  if (!s.list) return null;
  const [l, t, r, b] = s.list;
  const h = b - t;
  if (h < 400) return null;
  const x = Math.round(Math.min(l + (r - l) * 0.4, (s.buttonsLeft ?? r) - 60));
  return { x, y1: Math.round(b - h * 0.2), y2: Math.round(b - h * 0.75) };
}

/** The title of a list's tab in the tab bar (tap target to switch tabs on the same screen), null when not shown. */
export function listTab(nodes: UiNode[], kind: FollowListKind): { x: number; y: number; selected: boolean } | null {
  const n = nodes.find((x) => x.rid === `${ID}title` && x.bounds && TAB[kind].test(x.text.trim()));
  if (!n?.bounds) return null;
  return { x: Math.round((n.bounds[0] + n.bounds[2]) / 2), y: Math.round((n.bounds[1] + n.bounds[3]) / 2), selected: n.selected };
}
