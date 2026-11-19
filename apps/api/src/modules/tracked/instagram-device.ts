import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { HttpError } from '../../lib/errors.js';
import { adb } from '../../services.js';
import { recordRiskEvent } from '../risk/events.js';
import { collectorEntry, collectorWorked, deviceHalt, haltCollector, requireCollector, withCollector, type CollectorDevice } from './collector.js';
import type { Metric, ProfileData, SourceContext, TrackedSource } from './platforms.js';

/**
 * Instagram tracked accounts read in the Instagram app on the collector device (owner decision
 * 2026-11-18). Per visit: check the app is installed → open the profile deep link in the app (`am start
 * -p`) → poll `uiautomator dump` (≤ PROFILE_WAIT_MS) until the profile header (or another known screen)
 * shows → parse → HOME → delete the dump. Navigation and reading the screen only: no taps, no typing, no
 * likes/follows/comments, no fingerprint changes, no captcha solving, no account switching, no random
 * "human" behaviour. A challenge / verification / rate-limit screen halts collection (collector.ts) and
 * alerts the admins. Recent posts are not read (v1: opening each post means many more screens).
 *
 * Verified on Instagram 433.0.0.42.68 (Android 16, zh-CN UI): header ids below; a username that does not
 * exist leaves the profile shell empty with a spinner (no text at all), reported as profile_unavailable.
 * The login / challenge / "page not available" texts are matched in zh and en but were not seen live.
 */
export const PKG = 'com.instagram.android';
export const ID = `${PKG}:id/`;
const PROFILE_WAIT_MS = 20_000; // includes a cold start (the app is force-stopped first)
const FIRST_DUMP_DELAY_MS = 2500;
const POLL_GAP_MS = 1200;
const IG_HANDLE = /^[a-z0-9._]{1,30}$/;

// ---------------------------------------------------------------- dump parsing (pure)

export interface UiNode {
  rid: string; text: string; desc: string; pkg: string; depth: number;
  /** [x1, y1, x2, y2] on screen, null when missing. */
  bounds: [number, number, number, number] | null;
  cls: string; hint: string; clickable: boolean; focused: boolean;
  /** `selected` (e.g. the active tab of a tab bar). */
  selected: boolean;
}

const decode = (s: string) => s
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const attr = (tag: string, name: string) => {
  const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return m ? decode(m[1]!) : '';
};

/** uiautomator XML → nodes in document order with their depth (enough to find a node's descendants). */
export function parseUiDump(xml: string): UiNode[] {
  const out: UiNode[] = [];
  let depth = 0;
  for (const m of xml.matchAll(/<node\b[^>]*?(\/?)>|<\/node>/g)) {
    if (m[0] === '</node>') { depth--; continue; }
    const b = /^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/.exec(attr(m[0], 'bounds'));
    out.push({
      rid: attr(m[0], 'resource-id'), text: attr(m[0], 'text'), desc: attr(m[0], 'content-desc'), pkg: attr(m[0], 'package'), depth,
      bounds: b ? [Number(b[1]), Number(b[2]), Number(b[3]), Number(b[4])] : null,
      cls: attr(m[0], 'class'), hint: attr(m[0], 'hint'), clickable: attr(m[0], 'clickable') === 'true', focused: attr(m[0], 'focused') === 'true',
      selected: attr(m[0], 'selected') === 'true',
    });
    if (m[1] !== '/') depth++;
  }
  return out;
}

const MULT: Record<string, number> = { '万': 1e4, '萬': 1e4, '亿': 1e8, '億': 1e8, '千': 1e3, k: 1e3, m: 1e6, b: 1e9 };

/**
 * A counter as the app shows it: "195", "1,234", "3.2万", "2.6亿", "12.5K", "1.2M", "1B", "1,5 M".
 * `approx` = the app abbreviated it (a unit suffix), so the value is rounded by the app.
 */
export function parseCompactCount(raw: string): { value: number; approx: boolean } | null {
  const s = raw.replace(/[\s  ]/g, '').replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  const m = /^(\d[\d.,]*)(万|萬|亿|億|千|[KkMmBb])?$/.exec(s);
  if (!m) return null;
  let num = m[1]!;
  const unit = m[2]?.toLowerCase();
  if (unit) {
    // With a unit the separator is a decimal point ("1,5M" in some locales); thousands groups don't occur.
    if (/^\d+,\d{1,2}$/.test(num)) num = num.replace(',', '.');
    else num = num.replace(/,/g, '');
    if (!/^\d+(\.\d+)?$/.test(num)) return null;
    return { value: Math.round(Number(num) * MULT[unit]!), approx: true };
  }
  if (/^\d{1,3}([,.]\d{3})+$/.test(num)) return { value: Number(num.replace(/[,.]/g, '')), approx: false };
  if (/^\d+$/.test(num)) return { value: Number(num), approx: false };
  return null;
}

export type IgScreen =
  | { kind: 'profile'; handle: string | null; displayName: string | null; bio: string | null; verified: boolean; private: boolean;
      counts: Record<'followers' | 'following' | 'posts', { value: number; approx: boolean } | null>; raw: Record<string, string> }
  | { kind: 'login' | 'challenge' | 'not_found' | 'shell' | 'other' | 'empty' };

const CHALLENGE = /confirm (it's|that it's|that this is) you|help us confirm|suspicious (login|activity)|unusual activity|we (limit|restrict) how often|try again later|temporarily (blocked|locked)|verify (your|it's)|enter the code|security code|are you a robot|确认是你|确认是本人|确认你的身份|帮助我们确认|可疑|异常活动|请稍后(再|重)试|稍后再试|暂时被|已被限制|我们限制|验证你的|输入验证码|安全验证/i;
const NOT_FOUND = /sorry, this page isn'?t available|user not found|page isn'?t available|无法访问此页面|此页面无法访问|页面不可用|用户未找到|找不到用户|该用户不存在|账户不存在/i;
const LOGIN_TEXT = /^(log ?in|登录|登入|create new account|创建新账户|创建新帐户|forgot password\??|忘记密码[？?]?|password|密码)$/i;
const PRIVATE = /this account is private|私密账户|私密帐户|私密账号|帐户为私密|账户为私密/i;

/**
 * A screen that is not the expected one: challenge / verification / rate limit, login, "page not available".
 * Only call it when the expected structure is missing (comment texts could contain such words).
 */
export function screenProblem(nodes: UiNode[]): 'challenge' | 'login' | 'not_found' | null {
  const texts = nodes.flatMap((n) => [n.text, n.desc]).filter(Boolean);
  if (texts.some((t) => CHALLENGE.test(t))) return 'challenge';
  if (texts.some((t) => NOT_FOUND.test(t))) return 'not_found';
  if (nodes.some((n) => n.rid.startsWith(`${ID}login_`)) || texts.filter((t) => LOGIN_TEXT.test(t.trim())).length >= 2) return 'login';
  return null;
}

/**
 * What the current Instagram screen is, for the profile of `handle`; `handle` null = the logged-in account's
 * own profile (instagram://profile), whatever its username (the caller compares it).
 */
export function classifyIgDump(nodes: UiNode[], handle: string | null): IgScreen {
  if (!nodes.length) return { kind: 'empty' };
  if (!nodes.some((n) => n.pkg === PKG)) return { kind: 'other' };
  const byId = (suffix: string) => nodes.find((n) => n.rid === ID + suffix);
  const texts = nodes.flatMap((n) => [n.text, n.desc]).filter(Boolean);
  const followersNode = byId('profile_header_familiar_followers_value');
  if (!followersNode) {
    if (texts.some((t) => CHALLENGE.test(t))) return { kind: 'challenge' };
    if (texts.some((t) => NOT_FOUND.test(t))) return { kind: 'not_found' };
    if (nodes.some((n) => n.rid.startsWith(`${ID}login_`)) || texts.filter((t) => LOGIN_TEXT.test(t.trim())).length >= 2) return { kind: 'login' };
    return byId('profile_action_bar') ? { kind: 'shell' } : { kind: 'other' };
  }
  const title = byId('action_bar_title')?.text.trim() || null;
  // A different profile still on screen (the previous one while the new one loads): keep polling.
  if (title && handle !== null && title.toLowerCase() !== handle.toLowerCase()) return { kind: 'other' };
  /** Value node text, else the stacked container's content-desc without its label ("2.6亿粉丝"). */
  const raw: Record<string, string> = {};
  const count = (metric: 'followers' | 'following' | 'posts', value: string, stacked: string) => {
    let v = byId(value)?.text.trim() ?? '';
    if (!v) v = /^[\d.,\s万萬亿億千KkMmBb]+/.exec(byId(stacked)?.desc ?? '')?.[0]?.trim() ?? '';
    raw[metric] = v;
    return v ? parseCompactCount(v) : null;
  };
  const counts = {
    followers: count('followers', 'profile_header_familiar_followers_value', 'profile_header_followers_stacked_familiar'),
    following: count('following', 'profile_header_familiar_following_value', 'profile_header_following_stacked_familiar'),
    posts: count('posts', 'profile_header_familiar_post_count_value', 'profile_header_post_count_front_familiar'),
  };
  // Bio: the first text inside profile_user_info_compose_view.
  let bio: string | null = null;
  const bi = nodes.findIndex((n) => n.rid === `${ID}profile_user_info_compose_view`);
  if (bi >= 0) {
    for (let i = bi + 1; i < nodes.length && nodes[i]!.depth > nodes[bi]!.depth; i++) {
      if (nodes[i]!.text.trim()) { bio = nodes[i]!.text.trim(); break; }
    }
  }
  return {
    kind: 'profile', handle: title, raw, counts, bio,
    displayName: (byId('profile_header_full_name_above_vanity') ?? byId('profile_header_full_name'))?.text.trim() || null,
    verified: !!byId('action_bar_title_verified_badge'),
    private: texts.some((t) => PRIVATE.test(t)),
  };
}

/** A short, log-safe excerpt of what was on screen (texts only, never the whole dump). */
export function dumpExcerpt(nodes: UiNode[], max = 300): string {
  const ids = [...new Set(nodes.map((n) => n.rid.replace(ID, '')).filter(Boolean))].slice(0, 12).join(',');
  const texts = [...new Set(nodes.flatMap((n) => [n.text, n.desc]).map((t) => t.trim()).filter(Boolean))].join(' | ');
  return `ids: ${ids} · texts: ${texts}`.slice(0, max);
}

// ---------------------------------------------------------------- the visit

const coded = (status: number, message: string, code: string, params?: Record<string, string>) => new HttpError(status, message, code, params);

/** The app must be installed on the device (coded error otherwise). */
export async function requireApp(dev: CollectorDevice, code = 'tracked.collector_app_missing'): Promise<void> {
  if (!(await adb.shell(dev.adbPort, `pm path ${PKG}`, 15_000)).includes('package:')) {
    throw coded(409, `设备 ${dev.inst.name} 未安装 Instagram`, code, { name: dev.inst.name });
  }
}

/**
 * Closes Instagram (`am force-stop`) so the next deep link starts it fresh: with the app left on another screen
 * (a post, the camera, a sheet) `instagram://profile` / a profile link did not switch to the profile (sync
 * timeouts on 2026-11-19). Only at the START of an operation, never after 分享 (the upload runs in the app).
 */
export async function restartIg(port: number, signal?: AbortSignal): Promise<void> {
  await adb.shell(port, `am force-stop ${PKG}`, 15_000);
  await sleep(800, undefined, { signal });
}

/**
 * One visit: closes Instagram, then opens `url` in it (`am start -p`), polls `uiautomator dump` (≤ PROFILE_WAIT_MS)
 * until a known screen shows (profile header, login, challenge, not found) and returns it. Always back to the
 * launcher (HOME) and no dump file left behind, also after a failure or cancel. Navigation + screen reads only.
 */
export async function visitIgScreen(dev: CollectorDevice, url: string, handle: string | null, ctx: SourceContext): Promise<{ screen: IgScreen; nodes: UiNode[] }> {
  const log = ctx.log ?? (async () => undefined);
  const port = dev.adbPort;
  const file = `/data/local/tmp/cp-ig-${randomBytes(6).toString('hex')}.xml`;
  try {
    await restartIg(port, ctx.signal);
    const started = await adb.shell(port, `am start -a android.intent.action.VIEW -d '${url}' -p ${PKG}`, 20_000);
    if (/Error:|Exception/.test(started)) throw coded(502, `无法在设备上打开 Instagram：${started.trim().slice(0, 150)}`, 'tracked.collector_open_failed', { error: started.trim().slice(0, 150) });
    await log('info', 'collector: profile link opened', { url: handle ? url : 'instagram://profile' });
    const deadline = Date.now() + PROFILE_WAIT_MS;
    await sleep(FIRST_DUMP_DELAY_MS, undefined, { signal: ctx.signal });
    let nodes: UiNode[] = [];
    let screen: IgScreen = { kind: 'empty' };
    for (;;) {
      ctx.signal?.throwIfAborted();
      nodes = parseUiDump(await adb.shell(port, `uiautomator dump ${file} >/dev/null 2>&1; cat ${file} 2>/dev/null; rm -f ${file}`, 20_000));
      screen = classifyIgDump(nodes, handle);
      if (screen.kind === 'profile' || screen.kind === 'challenge' || screen.kind === 'login' || screen.kind === 'not_found') break;
      if (Date.now() >= deadline) break;
      await sleep(POLL_GAP_MS, undefined, { signal: ctx.signal });
    }
    return { screen, nodes };
  } finally {
    // Back to the launcher, and no dump left behind (even after a failure or cancel).
    await adb.shell(port, `input keyevent 3; rm -f ${file}`, 10_000).catch(() => undefined);
  }
}

const COUNT_KEYS = ['followers', 'following', 'posts'] as const;
/** Metrics the app abbreviated on this profile screen. */
export const approxOf = (screen: Extract<IgScreen, { kind: 'profile' }>): Metric[] => COUNT_KEYS.filter((k) => screen.counts[k]?.approx);

async function readProfile(dev: CollectorDevice, handle: string, ctx: SourceContext): Promise<ProfileData> {
  const log = ctx.log ?? (async () => undefined);
  const risk = (code: string, detail?: string) => recordRiskEvent({ instance: dev.inst, trackedAccountId: ctx.trackedAccountId ?? null, userId: ctx.userId ?? null, source: 'collector', code, detail: detail ?? `@${handle}` });
  try { await requireApp(dev); } catch (err) { await risk('tracked.collector_app_missing'); throw err; }
  const { screen, nodes } = await visitIgScreen(dev, `https://www.instagram.com/${handle}/`, handle, ctx);
  switch (screen.kind) {
    case 'profile': {
      const missing = COUNT_KEYS.filter((k) => !screen.counts[k]);
      if (screen.counts.followers === null) {
        await log('warn', 'collector: profile header could not be parsed', { excerpt: dumpExcerpt(nodes), raw: screen.raw });
        await risk('tracked.collector_parse_failed');
        throw coded(502, '主页数据解析失败', 'tracked.collector_parse_failed');
      }
      const approx = approxOf(screen);
      await log('info', 'collector: profile read', {
        raw: screen.raw, approx, verified: screen.verified, private: screen.private, ...(missing.length ? { missing } : {}),
      });
      await collectorWorked('instagram', dev.inst);
      return {
        externalId: handle, displayName: screen.displayName, avatarUrl: null, bio: screen.bio,
        followers: screen.counts.followers?.value ?? null, following: screen.counts.following?.value ?? null,
        posts: screen.counts.posts?.value ?? null, views: null, approx, verified: screen.verified, private: screen.private,
      };
    }
    case 'challenge':
      await log('error', 'collector: challenge screen, collection halted', { excerpt: dumpExcerpt(nodes) });
      await risk('tracked.collector_challenge');
      await haltCollector('instagram', dev.inst, 'tracked.collector_challenge', ctx.trackedAccountId ?? null);
      throw coded(409, 'Instagram 显示了验证/限制页面：采集已停止，需人工处理', 'tracked.collector_challenge');
    case 'login':
      await log('warn', 'collector: Instagram is not logged in', { excerpt: dumpExcerpt(nodes) });
      await risk('tracked.collector_logged_out');
      throw coded(409, '采集设备上的 Instagram 未登录', 'tracked.collector_logged_out');
    case 'not_found':
    case 'shell':
      await log('warn', 'collector: profile not available', { excerpt: dumpExcerpt(nodes) });
      throw coded(404, `Instagram 主页 @${handle} 无法显示（账号不存在、已停用或无法加载）`, 'tracked.collector_profile_unavailable', { handle });
    default:
      await log('warn', 'collector: profile did not show in time', { excerpt: dumpExcerpt(nodes) });
      await risk('tracked.collector_timeout');
      throw coded(504, '等待主页超时', 'tracked.collector_timeout');
  }
}

/**
 * The logged-in account's own profile (account check, modules/social/check.ts): app check, then
 * `instagram://profile` (opens the own profile of whoever is logged in). Returns the classified screen.
 */
export async function readOwnIgProfile(dev: CollectorDevice, ctx: SourceContext): Promise<{ screen: IgScreen; nodes: UiNode[] }> {
  await requireApp(dev, 'account_check.app_missing');
  return visitIgScreen(dev, 'instagram://profile', null, ctx);
}

/** Instagram accounts registered in Android's AccountManager (`dumpsys account`): their numeric ids. */
export async function igDeviceAccounts(dev: CollectorDevice): Promise<string[]> {
  const out = await adb.shell(dev.adbPort, 'dumpsys account', 20_000);
  return [...new Set([...out.matchAll(/Account \{name=([^,]+), type=www\.instagram\.com\}/g)].map((m) => m[1]!.trim()))];
}

export const instagramDeviceSource: TrackedSource = {
  kind: 'device',
  capabilities: { profile: true, recentPosts: false, metrics: ['followers', 'following', 'posts'] },
  isConfigured: async () => { const e = await collectorEntry('instagram'); return !!e && !(await deviceHalt(e.instanceId)); },
  requireConfigured: async () => { await requireCollector('instagram'); },
  async fetchProfile(account, ctx = {}) {
    if (!IG_HANDLE.test(account.handle)) throw coded(400, 'Instagram 账号格式不正确', 'tracked.bad_handle', { platform: 'Instagram' });
    return withCollector('instagram', ctx.log ?? (async () => undefined), (dev) => readProfile(dev, account.handle, ctx));
  },
  fetchRecentPosts: async () => [],
};
