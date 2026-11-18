import { computed, type Component } from 'vue'
import { useRoute } from 'vue-router'
import {
  AlertOutlined, ApiOutlined, AppstoreOutlined, CalendarOutlined, CloudOutlined, ClusterOutlined, ControlOutlined, DatabaseOutlined,
  FileSearchOutlined, FileTextOutlined, FireOutlined, IdcardOutlined, MobileOutlined, PictureOutlined, ReadOutlined, RiseOutlined, 
  ScheduleOutlined, SecurityScanOutlined, SettingOutlined, ShareAltOutlined, TeamOutlined, UserOutlined,
} from '@ant-design/icons-vue'
import { t } from '../../i18n'

export type MenuGroupKey = 'devices' | 'matrix' | 'content' | 'system'
/** `feature`: shown only while the platform scope offers it (GET /api/platforms → features, stores/platforms.ts). */
export interface MenuItem { key: string; icon: Component; feature?: 'trending' }
/** `flat`: the items sit directly in the sidebar's first level (no group header, no breadcrumb level; owner 2026-11-18). */
export interface MenuGroup { key: MenuGroupKey; icon: Component; items: MenuItem[]; flat?: boolean }

/**
 * Sidebar: dashboard on top, then the product's four modules (menu and roles: owner's list of 2026-11-18, see
 * CLAUDE.md). An item key is also its route path and its `nav.<key>` label; admin-only items (连线监控, 应用库,
 * 代理IP池, the system group) follow the route's `meta.admin`. 追踪号 / 回文日志 are tabs of 媒体管理 (/social).
 * The breadcrumb and the default page title (PageContainer) are derived from this list too.
 */
export const MENU_GROUPS: MenuGroup[] = [
  { key: 'devices', flat: true, icon: CloudOutlined, items: [
    { key: 'instances', icon: MobileOutlined }, { key: 'connections', icon: ApiOutlined },
    { key: 'library', icon: AppstoreOutlined }, { key: 'proxies', icon: ClusterOutlined },
  ] },
  { key: 'matrix', flat: true, icon: ShareAltOutlined, items: [
    { key: 'personas', icon: IdcardOutlined }, { key: 'social', icon: TeamOutlined }, { key: 'analytics', icon: RiseOutlined },
  ] },
  { key: 'content', flat: true, icon: ReadOutlined, items: [
    { key: 'media', icon: PictureOutlined }, { key: 'trending', icon: FireOutlined, feature: 'trending' },
    { key: 'content', icon: FileTextOutlined }, { key: 'publish', icon: CalendarOutlined },
  ] },
  { key: 'system', icon: ControlOutlined, items: [
    { key: 'users', icon: UserOutlined }, { key: 'audit', icon: FileSearchOutlined },
    { key: 'system', icon: DatabaseOutlined }, { key: 'settings', icon: SettingOutlined }, { key: 'risk', icon: SecurityScanOutlined },
    { key: 'alert-channels', icon: AlertOutlined }, { key: 'tasks', icon: ScheduleOutlined },
  ] },
]

export const MENU_KEYS = ['dashboard', ...MENU_GROUPS.flatMap((g) => g.items.map((it) => it.key))]
/** Pages outside the sidebar (opened from the header, e.g. the user menu's 通知中心): own title, no group. */
const PAGE_KEYS = [...MENU_KEYS, 'notifications']

/** Label of a menu item (the same for every role): the sidebar, the breadcrumb and the page title use this. */
export function navLabel(key: string): string {
  return t(`nav.${key}`)
}

/** Menu position of the current route: `/instances/abc` → group devices, item instances (null = dashboard / unknown). */
export function useMenuLocation() {
  const route = useRoute()
  const itemKey = computed(() => PAGE_KEYS.find((k) => route.path === `/${k}` || route.path.startsWith(`/${k}/`)) ?? 'dashboard')
  const group = computed(() => MENU_GROUPS.find((g) => g.items.some((it) => it.key === itemKey.value)) ?? null)
  /** Default page title: the menu label of the current item. */
  const title = computed(() => navLabel(itemKey.value))
  return { itemKey, group, title }
}
