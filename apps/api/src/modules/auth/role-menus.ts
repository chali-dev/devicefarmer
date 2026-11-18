import { eq } from 'drizzle-orm';
import { db, schema } from '../../db/index.js';
import { badRequest, forbidden } from '../../lib/errors.js';
import { isAdmin, type AuthUser } from './rbac.js';

/**
 * 权限管理 (角色菜单权限, owner decision 2026-11-18): the roles stay fixed (admin / user); an admin ticks which
 * business menus the `user` role sees (settings key `rbac.userMenus` = `{ menus: string[] }`). Admins always see
 * everything. The default is exactly what users saw before (every grantable menu), so nothing changes until edited.
 *
 * Enforced in the web (sidebar + router guard) and here: `assertMenuAllowed` runs in a global onRequest hook of the
 * auth plugin (before body validation) for every path a MENU_API rule matches, so a disabled menu's own endpoints answer 403 `rbac.menu_disabled` for
 * users. `MENU_API` lists, per endpoint pattern, every menu whose page uses it: the request is refused only when the
 * user has none of them, so endpoints shared across pages (the content editor reads social accounts, personas and
 * media; the 媒体管理 page shows publish runs) keep working as long as one of their pages is on. Endpoints not listed
 * (lists every page needs: GET /api/instances, /api/tasks, /api/social/accounts, /api/personas, /api/media, …) are
 * never blocked by this switch; their own RBAC is unchanged.
 */
const KEY = 'rbac.userMenus';
const CACHE_MS = 5_000;

/** Business menus users can have; the order is the sidebar's. */
export const GRANTABLE_MENUS = ['instances', 'personas', 'social', 'analytics', 'media', 'trending', 'content', 'publish', 'tasks'] as const;
export type GrantableMenu = (typeof GRANTABLE_MENUS)[number];
/** Every other sidebar key: always on (dashboard) or admin only. Known so that a PUT can tell "not grantable" from "unknown". */
export const FIXED_MENUS = {
  always: ['dashboard'],
  adminOnly: ['connections', 'library', 'proxies', 'users', 'audit', 'permissions', 'risk-events', 'risk', 'alert-channels', 'logs', 'settings'],
} as const;
export const DEFAULT_USER_MENUS: GrantableMenu[] = [...GRANTABLE_MENUS];

type Methods = 'read' | 'write' | 'all';
interface MenuApiRule { methods: Methods; pattern: RegExp; menus: GrantableMenu[] }
const seg = (p: string) => new RegExp(`^${p}(?:/|$)`);

/** First match wins. Documented in CLAUDE.md (RBAC → 角色菜单权限). */
export const MENU_API: MenuApiRule[] = [
  // 素材库: uploads and new categories also come from the content editor; pushes from publish runs (排程发布 / 媒体管理).
  { methods: 'all', pattern: seg('/api/media/push'), menus: ['media', 'publish', 'social'] },
  { methods: 'write', pattern: /^\/api\/media\/(upload|categories)$/, menus: ['media', 'content'] },
  { methods: 'all', pattern: seg('/api/media/usage'), menus: ['media'] },
  { methods: 'write', pattern: seg('/api/media'), menus: ['media'] },
  { methods: 'all', pattern: seg('/api/analytics'), menus: ['analytics'] },
  { methods: 'all', pattern: seg('/api/trending'), menus: ['trending'] },
  // 媒体管理 (/social): its tabs 追踪号 / 回文日志 and the account feed drawer.
  { methods: 'all', pattern: /^\/api\/(tracked-accounts|comments|comment-replies)(?:\/|$)/, menus: ['social'] },
  { methods: 'all', pattern: /^\/api\/social\/accounts\/[^/]+\/(feed|logs|ai-drafts|posts|collect|check)(?:\/|$)/, menus: ['social'] },
  { methods: 'write', pattern: seg('/api/social'), menus: ['social'] },
  // 人设管理: the 范例 are edited in the persona form only; reading personas is shared (accounts, editor, comment drawer).
  { methods: 'all', pattern: seg('/api/comment-templates'), menus: ['personas'] },
  { methods: 'write', pattern: seg('/api/personas'), menus: ['personas'] },
  // 内容管理: reading contents is shared (account AI drafts, 配置语系).
  { methods: 'write', pattern: seg('/api/contents'), menus: ['content'] },
  { methods: 'all', pattern: seg('/api/content-categories'), menus: ['content'] },
  // 排程发布: publish runs are also listed on 媒体管理 (发文日志).
  { methods: 'all', pattern: seg('/api/publish/tasks'), menus: ['publish', 'social'] },
  // 任务中心: the list and a task's detail are read by many pages (live task list, sync dialogs, device logs).
  { methods: 'all', pattern: seg('/api/tasks/stats'), menus: ['tasks'] },
  { methods: 'write', pattern: seg('/api/tasks'), menus: ['tasks'] },
  // 我的云机: device actions and per-device reads (the list, a device's row and /automation stay shared).
  { methods: 'all', pattern: seg('/api/instances/actions'), menus: ['instances'] },
  { methods: 'all', pattern: /^\/api\/instances\/[^/]+\/(screenshot|files|apk|logcat|settings|apps|google|platforms|proxy\/check)(?:\/|$)/, menus: ['instances'] },
  { methods: 'all', pattern: seg('/api/apps'), menus: ['instances'] },
];

const isRead = (m: string) => m === 'GET' || m === 'HEAD' || m === 'OPTIONS';

let cache: { at: number; menus: GrantableMenu[]; updatedAt: string | null } | null = null;

export async function getUserMenus(fresh = false): Promise<{ menus: GrantableMenu[]; updatedAt: string | null }> {
  if (!fresh && cache && Date.now() - cache.at < CACHE_MS) return cache;
  const [row] = await db.select().from(schema.settings).where(eq(schema.settings.key, KEY));
  const stored = (row?.value as { menus?: unknown } | undefined)?.menus;
  // An unreadable stored value falls back to the default; unknown keys (e.g. a menu removed later) are dropped.
  const menus = Array.isArray(stored) ? GRANTABLE_MENUS.filter((k) => stored.includes(k)) : DEFAULT_USER_MENUS;
  cache = { at: Date.now(), menus, updatedAt: row?.updatedAt.toISOString() ?? null };
  return cache;
}

/** Validates (unknown key → rbac.menu_unknown, dashboard / admin-only key → rbac.menu_not_grantable) and stores. */
export async function saveUserMenus(input: string[]) {
  const fixed: string[] = [...FIXED_MENUS.always, ...FIXED_MENUS.adminOnly];
  for (const k of input) {
    if (fixed.includes(k)) throw badRequest(`菜单「${k}」不能分配给用户角色`, 'rbac.menu_not_grantable', { menu: k });
    if (!(GRANTABLE_MENUS as readonly string[]).includes(k)) throw badRequest(`未知菜单：${k}`, 'rbac.menu_unknown', { menu: k });
  }
  const menus = GRANTABLE_MENUS.filter((k) => input.includes(k));
  await db.insert(schema.settings).values({ key: KEY, value: { menus } })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value: { menus }, updatedAt: new Date() } });
  cache = null;
  return getUserMenus(true);
}

/** Menu keys the user may open: admins every key, users dashboard + the enabled grantable menus. */
export async function effectiveMenus(user: AuthUser): Promise<string[]> {
  if (isAdmin(user)) return [...FIXED_MENUS.always, ...GRANTABLE_MENUS, ...FIXED_MENUS.adminOnly];
  return [...FIXED_MENUS.always, ...(await getUserMenus()).menus];
}

export async function menuEnabled(user: AuthUser, menu: GrantableMenu): Promise<boolean> {
  return isAdmin(user) || (await getUserMenus()).menus.includes(menu);
}

/** The MENU_API rule of a request (first match), or null when the switch never blocks it. */
export function menuRuleFor(method: string, url: string): MenuApiRule | null {
  const path = url.split('?')[0] ?? url;
  return MENU_API.find((r) => (r.methods === 'all' || (r.methods === 'read') === isRead(method)) && r.pattern.test(path)) ?? null;
}

/** 403 rbac.menu_disabled when every page using this endpoint is switched off for the user role. */
export async function assertMenuAllowed(user: AuthUser, rule: MenuApiRule): Promise<void> {
  if (isAdmin(user)) return;
  const { menus } = await getUserMenus();
  if (!rule.menus.some((m) => menus.includes(m))) {
    throw forbidden('该菜单未对用户角色开放', 'rbac.menu_disabled', { menu: rule.menus[0]! });
  }
}
