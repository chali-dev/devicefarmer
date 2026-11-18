import { setTimeout as sleep } from 'node:timers/promises';
import type { MediaAsset, PostType } from '../../db/schema.js';
import { HttpError } from '../../lib/errors.js';
import { adb, stf } from '../../services.js';
import { firstGridItem, IgScreenSession, isGridEmpty, normText, parseMediaIdList, permalinkOf, pkTime } from '../feed/ig-ui.js';
import { withMediaFile } from '../media/media.js';
import type { CollectorDevice } from '../tracked/collector.js';
import { classifyIgDump, dumpExcerpt, ID, igDeviceAccounts, PKG, requireApp, screenProblem, type UiNode } from '../tracked/instagram-device.js';

/**
 * 云手机发帖 (owner decision 2026-11-18): one Instagram post (帖子 / Reels / 快拍) published in the Instagram app on
 * the account's cloud phone. Probed on bit-ins-02 on 2026-11-18 (Instagram 433.0.0.42.68, Android 16, zh-CN UI);
 * the probe dumps are the reference for the ids below.
 *
 * Media selection: the files are pushed into the phone's gallery (adb.pushMedia: MediaStore row with is_pending=0,
 * named `cppub-<task>-r<round>-<n>` in publish order) and handed to the app through Instagram's own Android share
 * targets (the documented "share to Instagram" intents: ShareHandlerActivity = 帖子, ReelShareHandlerActivity =
 * Reels, StoryShareHandlerActivity = 快拍) with the exact MediaStore URI, so the right file is used, never a guess
 * from the gallery grid. A carousel adds items 2..N with the tray's "+" in the app's gallery, where the files are
 * the newest ones (stamped at push time; the thumbnails' dates are checked) and are tapped in order.
 *
 * Screens (uiautomator ids; several views live inside Compose interop and are only visible in
 * `dumpsys activity top`, where their bounds are read: `viewBounds`):
 * - 帖子 edit (`quick_edit_fragment`): tray `media_thumbnail_tray` with `plus_image` (add) and
 *   `media_thumbnail_tray_button` (继续) → once a sheet "分享帖子" (button 确定) → caption screen 新帖子
 *   (`share_footer_button` 分享, caption `caption_input_text_view` only in dumpsys).
 * - Reels edit (`clips_right_action_button` 下一步) → once `clips_download_privacy_nux_button` (继续) → 新 Reels
 *   (`share_button` "继续", `save_draft_button`, same caption view).
 * - 快拍 editor (`story_share_controls_action_bar`: "你的快拍" posts at once, "密友", "分享给"); a promo dialog
 *   (`igds_headline_primary_action_button` 确定) may come first. No caption.
 * - Leaving: back → action sheet "重拍？/保存草稿？" (`action_sheet_row_text_view` 重拍 | 保存草稿 | 继续编辑) or a
 *   dialog "放弃照片？" (`igds_alert_dialog_primary_button` 放弃): the flow always picks 重拍 / 放弃 (no draft kept).
 *
 * The caption is pasted through STF's clipboard.paste (any script / emoji) and read back by copying the field
 * (select all + copy) into the cleared clipboard (`service call clipboard`), then the clipboard is cleared again.
 * There is no test mode (removed 2026-11-18): screenshot, then 分享. Taps: only the creation flow's own buttons, the
 * caption field and the share button. Every dump is deleted, HOME at the end.
 */
const SHARE: Record<PostType, string> = {
  feed: 'com.instagram.share.handleractivity.ShareHandlerActivity',
  reel: 'com.instagram.share.handleractivity.ReelShareHandlerActivity',
  story: 'com.instagram.share.handleractivity.StoryShareHandlerActivity',
};
const STEP_GAP_MS = 1500;
const WAIT_MS = 20_000;

/** Coded failure of a device publish. `afterSend` = 分享 was tapped (never retried); `challenge` = halt the device; `retry` = may work later (informational only: publish rounds are never retried automatically since 2026-11-18). */
export class PublishDeviceError extends HttpError {
  constructor(code: string, message: string, readonly opts: { afterSend?: boolean; challenge?: boolean; excerpt?: string; retry?: boolean; shot?: Buffer | null } = {}) { super(409, message, code); }
}
const fail = (code: string, message: string, opts: PublishDeviceError['opts'] = {}) => new PublishDeviceError(code, message, opts);
type Log = (level: 'info' | 'warn' | 'error', message: string, data?: Record<string, unknown>) => Promise<void>;

// ---------------------------------------------------------------- pure helpers (parsers)

const byRid = (nodes: UiNode[], suffix: string) => nodes.find((n) => n.rid === ID + suffix);
const center = (b: [number, number, number, number]) => ({ x: Math.round((b[0] + b[2]) / 2), y: Math.round((b[1] + b[3]) / 2) });
const visible = (n: UiNode | undefined): n is UiNode & { bounds: [number, number, number, number] } => !!n?.bounds && n.bounds[2] > n.bounds[0] && n.bounds[3] > n.bounds[1];

/**
 * Absolute screen bounds of the first visible view with id `app:id/<id>` in the foreground Instagram activity of
 * `dumpsys activity top` (bounds there are relative to the parent; scroll offsets are not shown, so only views of
 * unscrolled screens are reliable). null when missing, gone or zero-sized.
 */
export function viewBounds(top: string, id: string): [number, number, number, number] | null {
  return viewInfo(top, id)?.bounds ?? null;
}
/** viewBounds + the view's numeric id (= EditorInfo.fieldId of a focused text field). */
export function viewInfo(top: string, id: string): { bounds: [number, number, number, number]; num: number } | null {
  const blocks = top.split(/\n(?=\s*ACTIVITY )/).filter((b) => /ACTIVITY com\.instagram\.android\//.test(b));
  const block = blocks.find((b) => /mResumed=true/.test(b)) ?? blocks[blocks.length - 1];
  if (!block) return null;
  const stack: { indent: number; x: number; y: number; vis: boolean }[] = [];
  for (const line of block.split('\n')) {
    const m = /^(\s*)\S+\{[0-9a-f]+ ([VIG])\S* \S+ (-?\d+),(-?\d+)-(-?\d+),(-?\d+)(?: #([0-9a-f]+) ([^\s}]+))?/.exec(line);
    if (!m) continue;
    if (/DecorView/.test(line)) stack.length = 0;
    const indent = m[1]!.length;
    while (stack.length && stack[stack.length - 1]!.indent >= indent) stack.pop();
    const parent = stack[stack.length - 1];
    const [l, t, r, b] = [Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])];
    const x = (parent?.x ?? 0) + l;
    const y = (parent?.y ?? 0) + t;
    const vis = (parent?.vis ?? true) && m[2] === 'V';
    stack.push({ indent, x, y, vis });
    if (vis && m[8] === `app:id/${id}` && r > l && b > t) return { bounds: [x, y, x + (r - l), y + (b - t)], num: parseInt(m[7]!, 16) };
  }
  return null;
}

/** The focused text field of the input method (`dumpsys input_method`): its package + fieldId, null when none. */
export function focusedField(out: string): { pkg: string; fieldId: number } | null {
  const m = /curEditorInfo:[\s\S]*?packageName=(\S+)[^\n]*?fieldId=(-?\d+)/.exec(out);
  return m ? { pkg: m[1]!, fieldId: Number(m[2]) } : null;
}

/** Text of the clipboard from `service call clipboard 4 …` (getPrimaryClip) output; null when there is none. */
export function parseClipParcel(out: string): string | null {
  const ws: string[] = [];
  for (const line of out.split('\n')) {
    const body = line.replace(/^\s*0x[0-9a-f]+:\s*/i, '').replace(/^\s*Result: Parcel\(/, '').replace(/'.*$/, '');
    ws.push(...(body.match(/\b[0-9a-f]{8}\b/gi) ?? []));
  }
  const buf = Buffer.alloc(ws.length * 4);
  ws.forEach((w, i) => buf.writeUInt32LE(parseInt(w, 16) >>> 0, i * 4));
  if (buf.length < 8 || buf.readInt32LE(4) === 0) return null; // no clip
  const dec = new TextDecoder('utf-8', { fatal: true });
  let best: string | null = null;
  for (let o = 4; o + 4 <= buf.length; o += 4) {
    const kind = buf.readInt32LE(o - 4);
    if (kind !== 1 && kind !== 0) continue; // TextUtils.writeToParcel: 1 = plain String, 0 = Spanned (text, then its spans)
    const len = buf.readInt32LE(o);
    if (len <= 0 || len > 100_000 || o + 4 + len >= buf.length || buf[o + 4 + len] !== 0) continue;
    const bytes = buf.subarray(o + 4, o + 4 + len);
    if (bytes.includes(0)) continue;
    // The item's text is the longest string in the parcel (labels, span data are short).
    try { const t = dec.decode(bytes); if (!best || t.length > best.length) best = t; } catch { /* not UTF-8 */ }
  }
  return best;
}

/** Where a read-back caption differs from the intended one (normalised like the comparison): lengths, first differing
 * index, ±40 chars of context on both sides and the code points there. Texts are the user's own caption, no secrets. */
export function captionDiff(want: string, got: string) {
  const a = normText(want), b = normText(got);
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const cp = (x: string) => [...x.slice(i, i + 6)].map((c) => `U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`).join(' ');
  return {
    wantLength: a.length, gotLength: b.length, at: i,
    want: a.slice(Math.max(0, i - 40), i + 40), got: b.slice(Math.max(0, i - 40), i + 40),
    wantCodes: cp(a), gotCodes: cp(b),
  };
}

/** "照片缩略图创建日期：2026年11月18日 13:21" → minutes since epoch in the phone's local time, else null. */
export function thumbLocalMinute(desc: string): number | null {
  const m = /(\d{4})年(\d{1,2})月(\d{1,2})日\s*(\d{1,2}):(\d{2})/.exec(desc);
  return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5])) / 60_000 : null;
}
/** Selection index shown on a gallery thumbnail ("选择的影音内容数量是2 …"), null when not selected. */
export const thumbSelection = (desc: string) => { const m = /(?:选择的影音内容数量是|selected,?\s*)(\d+)/i.exec(desc); return m ? Number(m[1]) : null; };

const CREATION_IDS = ['share_footer_button', 'quick_edit_fragment', 'media_thumbnail_tray', 'clips_right_action_button', 'clips_post_capture_controls', 'save_draft_button',
  'story_share_controls_action_bar', 'post_capture_controls_container', 'gallery_grid_item_thumbnail', 'action_sheet_container', 'igds_alert_dialog_primary_button'];
/** Is any screen of the creation flow (editor, caption, gallery, discard sheet) still showing? */
export const inCreation = (nodes: UiNode[]) => nodes.some((n) => n.pkg === PKG && CREATION_IDS.some((id) => n.rid === ID + id));

const DISCARD = /^(重拍|放弃|捨棄|丢弃|Discard|Start over)$/i;
/** The discard choice of a "保存草稿？/重拍？" sheet or a "放弃照片？" dialog (never 保存草稿). */
export function discardButton(nodes: UiNode[]): { x: number; y: number } | null {
  const n = nodes.find((x) => (x.rid === `${ID}action_sheet_row_text_view` || x.rid === `${ID}igds_alert_dialog_primary_button`) && DISCARD.test(x.text.trim()) && visible(x));
  return n?.bounds ? center(n.bounds) : null;
}

const ACK = /^(确定|知道了|继续|OK|Got it|Continue)$/i;
/** One-time notices (promo dialog, Reels download notice, "分享帖子" sheet): their acknowledge button, else null. */
export function nuxButton(nodes: UiNode[]): { x: number; y: number } | null {
  const promo = byRid(nodes, 'igds_headline_primary_action_button');
  if (visible(promo) && byRid(nodes, 'igds_headline_headline')) return center(promo.bounds);
  const reels = byRid(nodes, 'clips_download_privacy_nux_button');
  if (visible(reels)) return center(reels.bounds);
  // Compose sheet: igds_button > ig_text "确定" inside the bottom sheet (not the share footer).
  if (byRid(nodes, 'bottom_sheet_container_view')) {
    const i = nodes.findIndex((n) => n.rid === 'ig_text' && ACK.test(n.text.trim()));
    const btn = i > 0 && nodes[i - 1]!.rid === 'igds_button' ? nodes[i - 1] : nodes[i];
    if (visible(btn)) return center(btn.bounds);
  }
  return null;
}

export type PublishScreen = 'feed_edit' | 'feed_caption' | 'reel_edit' | 'reel_caption' | 'story_edit' | 'gallery' | null;
export function publishScreen(nodes: UiNode[]): PublishScreen {
  if (byRid(nodes, 'share_footer_button')) return 'feed_caption';
  if (byRid(nodes, 'share_button') && byRid(nodes, 'save_draft_button')) return 'reel_caption';
  if (byRid(nodes, 'story_share_controls_action_bar')) return 'story_edit';
  if (byRid(nodes, 'clips_right_action_button')) return 'reel_edit';
  if (nodes.some((n) => n.rid === `${ID}gallery_grid_item_thumbnail`) && byRid(nodes, 'next_button_textview')) return 'gallery';
  if (byRid(nodes, 'quick_edit_fragment')) return 'feed_edit';
  return null;
}

// ---------------------------------------------------------------- the flow

export interface PublishFlowInput {
  publishTaskId: string;
  round: number;
  postType: PostType;
  /** The account (the logged-in account must be this one). */
  handle: string;
  externalId: string | null;
  /** Ordered, ready. */
  media: MediaAsset[];
  /** Caption + hashtags ('' = none; stories have none). */
  text: string;
  log: Log;
  signal?: AbortSignal;
  /** Diagnostics only (scripts, owner-approved): stop after the caption read-back, never tap 分享; the draft is discarded. */
  probeOnly?: boolean;
  /** Called right before 分享 is tapped (from then on the run counts toward the daily cap / minimum gap). */
  onShare?: () => void;
}
export interface PublishFlowResult {
  outcome: 'published' | 'probe';
  inputText: string;
  excerpt: string;
  screenshot: Buffer | null;
  screens: number;
  /** Live: the new post (media pk) when it was seen on the profile. */
  externalId?: string | null;
  url?: string | null;
  publishedAt?: Date | null;
  /** Files left on the phone (live run whose upload might still need them), else []. */
  keptFiles: string[];
}

interface Pushed { id: string; remote: string; mime: string }
const remoteOf = (task: string, round: number, i: number, a: MediaAsset) =>
  `/sdcard/${a.fileType === 'video' ? 'Movies' : 'Pictures'}/cppub-${task.slice(0, 8)}-r${round}-${i + 1}.${a.fileKey.split('.').pop()!.toLowerCase().replace(/[^a-z0-9]/g, '') || 'bin'}`;
const uriOf = (p: Pushed) => `content://media/external/${p.mime.startsWith('video/') ? 'video' : 'images'}/media/${p.id}`;

/** The phone's clipboard (as shell). */
const clip = {
  clear: (s: IgScreenSession) => s.sh('service call clipboard 3 s16 com.android.shell i32 -1 i32 0 i32 0').catch(() => ''),
  read: async (s: IgScreenSession) => parseClipParcel(await s.sh('service call clipboard 4 s16 com.android.shell i32 -1 i32 0 i32 0')),
};

export async function publishOnIg(dev: CollectorDevice, input: PublishFlowInput): Promise<PublishFlowResult> {
  const { log } = input;
  const s = new IgScreenSession(dev, input.signal);
  const pushed: Pushed[] = [];
  let keep = false;
  let dirtyClip = false;
  const gap = () => sleep(STEP_GAP_MS, undefined, { signal: input.signal });
  /** Waits for `ok`, acknowledging one-time notices on the way; throws coded errors for problem screens. */
  const waitScreen = async (ok: (n: UiNode[]) => boolean, what: string, ms = WAIT_MS) => {
    const deadline = Date.now() + ms;
    for (;;) {
      const r = await s.waitFor((n) => ok(n) || !!nuxButton(n) || !!screenProblem(n), Math.max(1000, deadline - Date.now()), 1500);
      // A notice can sit on top of the expected screen (the "分享帖子" sheet over 新帖子): acknowledge it first.
      const nux = nuxButton(r.nodes);
      if (ok(r.nodes) && !nux) return r.nodes;
      if (nux && Date.now() < deadline) { await log('info', 'publish: one-time notice acknowledged', { excerpt: dumpExcerpt(r.nodes, 160) }); await s.tap(nux); continue; }
      const p = screenProblem(r.nodes);
      if (p === 'challenge') throw fail('publish.device_challenge', 'Instagram 显示了验证/限制页面：设备的自动操作已暂停，需管理员在云机管理的设备卡片上恢复', { challenge: true, excerpt: dumpExcerpt(r.nodes) });
      if (p === 'login') throw fail('publish.device_logged_out', '设备上的 Instagram 未登录');
      throw fail('publish.device_timeout', `等待「${what}」页面超时`, { retry: true, excerpt: dumpExcerpt(r.nodes) });
    }
  };
  const tapView = async (id: string, fallback?: { x: number; y: number }) => {
    const b = viewBounds(await s.activityTop(), id);
    if (!b && !fallback) throw fail('publish.device_timeout', `找不到界面元素 ${id}`, { retry: true });
    await s.tap(b ? center(b) : fallback!);
  };

  try {
    await requireApp(dev, 'publish.device_app_missing');
    // ---- 1. the logged-in account must be this one (like the automatic account check)
    const accounts = await igDeviceAccounts(dev);
    if (!accounts.length) throw fail('publish.device_logged_out', '设备上的 Instagram 未登录');
    if (input.externalId && !accounts.includes(input.externalId)) throw fail('publish.device_wrong_account', `设备上登录的 Instagram 账号（${accounts.join(', ')}）不是 @${input.handle}`);
    if (!input.externalId || accounts.length > 1) {
      await s.open('instagram://profile');
      const { nodes } = await s.waitFor((n) => ['profile', 'challenge', 'login'].includes(classifyIgDump(n, null).kind), 15_000, 2500);
      const own = classifyIgDump(nodes, null);
      if (own.kind === 'challenge') throw fail('publish.device_challenge', 'Instagram 显示了验证/限制页面', { challenge: true, excerpt: dumpExcerpt(nodes) });
      if (own.kind === 'login') throw fail('publish.device_logged_out', '设备上的 Instagram 未登录');
      if (own.kind !== 'profile' || !own.handle) throw fail('publish.device_timeout', '读取设备上登录的账号超时', { retry: true, excerpt: dumpExcerpt(nodes) });
      if (own.handle.toLowerCase() !== input.handle.toLowerCase()) throw fail('publish.device_wrong_account', `设备上登录的是 @${own.handle}，不是 @${input.handle}`);
      await s.keys(3);
      await gap();
    }
    await log('info', 'publish: account on the phone verified', { accounts: accounts.length });

    // ---- 2. media into the gallery, in publish order
    // The phone's clock + zone: the gallery shows local creation times (checked for carousel items 2..N).
    const [epoch, tz, size] = (await s.sh('date +%s; date +%z; wm size')).trim().split('\n');
    const tzm = /^([+-])(\d{2})(\d{2})$/.exec(tz?.trim() ?? '');
    const localStartMin = Math.floor((Number(epoch) || Date.now() / 1000) / 60) + (tzm ? (tzm[1] === '-' ? -1 : 1) * (Number(tzm[2]) * 60 + Number(tzm[3])) : 0);
    const wm = /(\d+)x(\d+)/.exec(size ?? '');
    const screen = { w: wm ? Number(wm[1]) : 1080, h: wm ? Number(wm[2]) : 2374 };
    for (const [i, a] of input.media.entries()) {
      const remote = remoteOf(input.publishTaskId, input.round, i, a);
      try {
        const id = await withMediaFile(a, (local) => adb.pushMedia(dev.adbPort, local, remote));
        pushed.push({ id, remote, mime: a.mimeType });
      } catch (err) {
        throw fail('publish.device_push_failed', `素材「${a.name}」推送到手机失败：${(err as Error).message}`.slice(0, 300), { retry: true });
      }
      if (i < input.media.length - 1) await sleep(1100, undefined, { signal: input.signal }); // distinct timestamps = gallery order
    }
    await log('info', 'publish: media pushed to the phone gallery', { files: pushed.map((p) => p.remote.split('/').pop()) });

    // ---- 3. the app's share target with the first medium
    const first = pushed[0];
    if (!first) throw fail('publish.device_media_not_found', '没有可发布的素材');
    const out = await s.sh(`am start -a android.intent.action.SEND -t ${first.mime} --eu android.intent.extra.STREAM ${uriOf(first)} --grant-read-uri-permission -n ${PKG}/${SHARE[input.postType]}`);
    if (/Error:|Exception/.test(out)) throw fail('publish.device_timeout', `打开 Instagram 发布页失败：${out.trim().slice(0, 150)}`, { retry: true });
    s.screens++;
    await log('info', 'publish: share screen opened', { postType: input.postType });

    let nodes: UiNode[];
    if (input.postType === 'feed') {
      nodes = await waitScreen((n) => publishScreen(n) === 'feed_edit', '帖子编辑');
      if (pushed.length > 1) {
        // Items 2..N: tray "+" → the gallery lists the newest files first → tap them in publish order.
        await gap();
        await tapView('plus_image');
        nodes = await waitScreen((n) => publishScreen(n) === 'gallery', '相册');
        const thumbs = nodes.filter((n) => n.rid === `${ID}gallery_grid_item_thumbnail` && visible(n));
        const need = pushed.length - 1;
        const ours = thumbs.slice(0, need);
        const times = ours.map((n) => thumbLocalMinute(n.desc));
        if (ours.length < need || times.some((t) => t === null || t < localStartMin - 1)) {
          throw fail('publish.device_media_not_found', '在手机相册里找不到刚推送的素材', { excerpt: ours.map((n) => n.desc).join(' | ').slice(0, 300) });
        }
        for (let k = need - 1; k >= 0; k--) { await s.tap(center(ours[k]!.bounds!)); await sleep(700, undefined, { signal: input.signal }); }
        const after = await s.dump();
        const sel = after.filter((n) => n.rid === `${ID}gallery_grid_item_thumbnail` && visible(n)).slice(0, need).map((n) => thumbSelection(n.desc));
        const want = Array.from({ length: need }, (_, k) => need - k);
        if (sel.join(',') !== want.join(',')) throw fail('publish.device_media_not_found', '相册里选中的素材与发布顺序不一致', { excerpt: `selected ${sel.join(',')} want ${want.join(',')}` });
        const next = byRid(after, 'next_button_textview');
        if (!visible(next)) throw fail('publish.device_timeout', '相册的“继续”按钮没有显示', { retry: true });
        await s.tap(center(next.bounds));
        nodes = await waitScreen((n) => publishScreen(n) === 'feed_edit', '帖子编辑');
        await log('info', 'publish: carousel items added in order', { count: pushed.length });
      }
      await gap();
      await tapView('media_thumbnail_tray_button', { x: Math.round(screen.w * 0.878), y: Math.round(screen.h * 0.961) });
      nodes = await waitScreen((n) => publishScreen(n) === 'feed_caption', '新帖子');
    } else if (input.postType === 'reel') {
      nodes = await waitScreen((n) => publishScreen(n) === 'reel_edit', 'Reels 编辑');
      await gap();
      const next = byRid(nodes, 'clips_right_action_button');
      await s.tap(center(next!.bounds!));
      nodes = await waitScreen((n) => publishScreen(n) === 'reel_caption', '新 Reels');
    } else {
      nodes = await waitScreen((n) => publishScreen(n) === 'story_edit', '快拍编辑');
    }
    await log('info', 'publish: last screen before sharing reached', { screen: publishScreen(nodes) });

    // ---- 4. caption (帖子 / Reels)
    let inputText = '';
    let shot: Buffer | null = null;
    if (input.postType !== 'story' && input.text.trim()) {
      await gap();
      // The caption field lives inside Compose interop: bounds + id from dumpsys; focus checked via the input method.
      const field = viewInfo(await s.activityTop(), 'caption_input_text_view');
      if (!field) throw fail('publish.device_timeout', '找不到配文输入框', { retry: true });
      let focus: ReturnType<typeof focusedField> = null;
      for (let i = 0; i < 2; i++) {
        await s.tap(center(field.bounds));
        await sleep(1500, undefined, { signal: input.signal });
        focus = focusedField(await s.sh("dumpsys input_method | grep -A8 'curEditorInfo:'"));
        if (focus?.pkg === PKG && focus.fieldId === field.num) break;
      }
      if (focus?.pkg !== PKG || focus.fieldId !== field.num) throw fail('publish.device_timeout', '配文输入框没有获得焦点', { retry: true, excerpt: `focused ${focus?.pkg ?? '-'}/${focus?.fieldId ?? '-'}, caption ${field.num}` });
      const sd = await stf.getDevice(adb.serialFor(dev.adbPort)).catch(() => null);
      if (!sd?.channel) throw fail('publish.device_input_unavailable', '设备在 STF 中不可用，无法输入文字', { retry: true });
      await stf.claim(sd.serial).catch(() => undefined);
      dirtyClip = true;
      await stf.paste(sd.channel, input.text);
      await sleep(1500, undefined, { signal: input.signal });
      shot = await s.screenshot().catch(() => null);
      // Read back: empty the clipboard, copy the whole field, read the clipboard.
      let raw = '';
      for (let i = 0; i < 3 && !inputText; i++) {
        await clip.clear(s);
        await sleep(300, undefined, { signal: input.signal });
        // select all (ctrl+A; second try: end, then shift+home), then copy (ctrl+C)
        await s.sh(i === 1 ? 'input keyevent 123; input keycombination 59 122' : 'input keycombination 113 29');
        await sleep(600, undefined, { signal: input.signal });
        await s.sh('input keycombination 113 31');
        for (let k = 0; k < 5 && !inputText; k++) {
          await sleep(500, undefined, { signal: input.signal });
          raw = await s.sh('service call clipboard 4 s16 com.android.shell i32 -1 i32 0 i32 0').catch(() => '');
          inputText = parseClipParcel(raw) ?? '';
        }
        if (!inputText) await log('warn', 'publish: caption copy for the read-back gave nothing, trying again', { attempt: i + 1, raw: raw.replace(/\s+/g, ' ').slice(0, 1800) });
      }
      await clip.clear(s);
      dirtyClip = false;
      if (normText(inputText) !== normText(input.text)) {
        const after = await s.screenshot().catch(() => null);
        await log('warn', 'publish: caption read-back differs', captionDiff(input.text, inputText));
        throw fail('publish.device_text_mismatch', '配文输入框里的文字与要发布的文字不一致', { excerpt: `read back: ${inputText}`.slice(0, 200), shot: after ?? shot });
      }
      await log('info', 'publish: caption pasted and read back', { length: inputText.length });
    }
    let screenshot = shot ?? await s.screenshot().catch(() => null);
    const excerpt = `${publishScreen(await s.dump()) ?? '?'} · media ${pushed.length}${inputText ? ` · caption: ${inputText}` : ''}`.slice(0, 300);

    if (input.probeOnly) {
      await log('info', 'publish: probe stopped before 分享', { inputText });
      return { outcome: 'probe', inputText, excerpt, screenshot, screens: s.screens, keptFiles: [] };
    }
    // ---- 5. 分享
    if (inputText) { await s.keys(4); await sleep(1000, undefined, { signal: input.signal }); } // hide the keyboard over the share button
    const now = await s.dump();
    const shareAt = shareButton(input.postType, now);
    if (!shareAt) throw fail('publish.device_timeout', '找不到“分享”按钮', { retry: true, excerpt: dumpExcerpt(now) });
    // Evidence = the screen as it is shared (keyboard hidden), else the one after the paste.
    screenshot = await s.screenshot().catch(() => null) ?? screenshot;
    const sharedAt = new Date();
    keep = true;
    input.onShare?.();
    await s.tap(shareAt);
    await log('info', 'publish: share tapped');
    if (input.postType === 'reel') {
      // The Reels footer says "继续": a further confirmation screen may ask once more (not seen live).
      const more = await s.waitFor((n) => !inCreation(n) || !!confirmShare(n), 8000, 1500);
      const c = confirmShare(more.nodes);
      if (c) { await s.tap(c); await log('info', 'publish: share confirmed on the follow-up screen'); }
    }
    // ---- 6. confirm: the new post on the own profile (media pk), story: the profile shows a story
    const seen = await confirmPublished(s, input.handle, input.postType, sharedAt, log, input.signal);
    if (!seen) throw fail('publish.send_uncertain', '已点“分享”，但没能在主页确认新帖子：请在手机上检查后记录结果', { afterSend: true, shot: screenshot, excerpt });
    keep = false;
    await log('info', 'publish: post seen on the profile', { externalId: seen.externalId, url: seen.url });
    return { outcome: 'published', inputText, excerpt, screenshot, screens: s.screens, externalId: seen.externalId, url: seen.url, publishedAt: seen.publishedAt, keptFiles: [] };
  } finally {
    if (dirtyClip) await clip.clear(s);
    // A failure inside the creation flow: leave it without keeping a draft.
    if (!keep) await discard(s, log).catch(() => undefined);
    await s.close();
    // Pushed files: removed, except after a live share whose upload might still read them.
    if (keep) await log('warn', 'publish: media kept on the phone (upload not confirmed)', { files: pushed.map((p) => p.remote) });
    else for (const p of pushed) await adb.deleteMedia(dev.adbPort, p.id, p.remote);
  }
}

/** Back until no creation screen is left, picking 重拍 / 放弃 on the discard sheet (never 保存草稿). */
async function discard(s: IgScreenSession, log: Log): Promise<void> {
  for (let i = 0; i < 8; i++) {
    const nodes = await s.dump();
    if (!inCreation(nodes)) return;
    const d = discardButton(nodes);
    if (d) { await s.tap(d); await log('info', 'publish: draft discarded'); }
    else {
      const cancel = ['cancel_button', 'gallery_cancel_button'].map((id) => byRid(nodes, id)).find(visible);
      if (cancel?.bounds && !byRid(nodes, 'share_footer_button')) await s.tap(center(cancel.bounds));
      else await s.keys(4);
    }
    await sleep(1800, undefined, { signal: s.signal });
  }
  throw fail('publish.device_discard_failed', '没能退出 Instagram 的发布页面，请在远程控制中检查设备');
}

const SHARE_TEXT = /^(分享|Share)$/i;
function shareButton(postType: PostType, nodes: UiNode[]): { x: number; y: number } | null {
  if (postType === 'feed') { const b = byRid(nodes, 'share_footer_button'); return visible(b) ? center(b.bounds) : null; }
  if (postType === 'reel') { const b = byRid(nodes, 'share_button'); return visible(b) ? center(b.bounds) : null; }
  const bar = nodes.findIndex((n) => n.rid === `${ID}story_share_controls_action_bar`);
  if (bar < 0) return null;
  const own = nodes.slice(bar + 1, bar + 8).find((n) => /^(你的快拍|Your story)$/i.test(n.desc.trim()) && n.clickable);
  return visible(own) ? center(own.bounds) : null;
}
/** A follow-up "分享" button after the Reels footer (ids containing share), else null. */
function confirmShare(nodes: UiNode[]): { x: number; y: number } | null {
  const n = nodes.find((x) => x.clickable && /share/i.test(x.rid) && (SHARE_TEXT.test(x.text.trim()) || SHARE_TEXT.test(x.desc.trim())) && visible(x));
  return n?.bounds ? center(n.bounds) : null;
}

/**
 * How long after 分享 the new post is looked for on the own profile. The upload runs in the background after the tap:
 * on 2026-11-18 (bit-ins-02, one photo) the media was created 127 s after the tap, after the former ~100 s window.
 */
export const CONFIRM_WINDOW_MS = 5 * 60_000;

/**
 * After 分享: the new post must show on the account's own profile. Feed / Reels: the newest media pk of the grid
 * (`dumpsys activity top` after tapping the first grid item, as the feed collection reads it) created after the
 * tap. The own profile's grid is cached (it kept the empty state, header already "1 帖子", minutes after the post
 * was online), so every look pulls to refresh first. Tries at ~15 s, then every ~40 s until CONFIRM_WINDOW_MS
 * (2 screens each). Story: the profile picture is no longer marked "发布快拍" (no story) — a heuristic, not seen live.
 */
async function confirmPublished(s: IgScreenSession, handle: string, postType: PostType, since: Date, log: Log, signal?: AbortSignal):
  Promise<{ externalId: string | null; url: string | null; publishedAt: Date | null } | null> {
  for (let i = 0; i === 0 || Date.now() - since.getTime() < CONFIRM_WINDOW_MS; i++) {
    await sleep(i === 0 ? 15_000 : 40_000, undefined, { signal });
    const attempt = i + 1;
    await s.open(`https://www.instagram.com/${handle}/`);
    const { nodes } = await s.waitFor((n) => classifyIgDump(n, handle).kind === 'profile', 15_000, 2500);
    if (classifyIgDump(nodes, handle).kind !== 'profile') { await log('info', 'publish: own profile not shown yet', { attempt }); continue; }
    if (postType === 'story') {
      if (!nodes.some((n) => n.rid === `${ID}reel_empty_badge`)) return { externalId: null, url: `https://www.instagram.com/stories/${handle}/`, publishedAt: new Date() };
      await log('info', 'publish: new story not on the profile yet', { attempt });
      continue;
    }
    await s.pullToRefresh();
    const g = await s.waitFor((n) => !!firstGridItem(n) || isGridEmpty(n), 10_000, 2500);
    const grid = firstGridItem(g.nodes);
    if (!grid?.bounds) { await log('info', 'publish: new post not on the profile yet', { attempt, grid: isGridEmpty(g.nodes) ? 'empty' : 'not shown' }); continue; }
    await s.tap(center(grid.bounds));
    s.screens++;
    await sleep(3000, undefined, { signal });
    const ids = parseMediaIdList(await s.activityTop());
    const newest = ids.map((x) => x.pk).sort((a, b) => (BigInt(b) > BigInt(a) ? 1 : -1))[0];
    await s.keys(4);
    if (newest && pkTime(newest).getTime() >= since.getTime() - 120_000) return { externalId: newest, url: permalinkOf(newest), publishedAt: pkTime(newest) };
    await log('info', 'publish: new post not on the profile yet', { attempt, newest: newest ? pkTime(newest).toISOString() : null });
  }
  return null;
}
