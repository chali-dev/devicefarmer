import { computed, type Component } from 'vue'
import { useRoute } from 'vue-router'
import {
  AlertOutlined, ApiOutlined, AppstoreOutlined, CalendarOutlined, CloudOutlined, ClusterOutlined, CommentOutlined, ControlOutlined, DatabaseOutlined,
  EyeOutlined, FileSearchOutlined, FileTextOutlined, FireOutlined, IdcardOutlined, MobileOutlined, PictureOutlined, ReadOutlined, RiseOutlined, SafetyOutlined,
  ScheduleOutlined, SecurityScanOutlined, SettingOutlined, ShareAltOutlined, TeamOutlined, UserOutlined,
} from '@ant-design/icons-vue'
import { t } from '../../i18n'
import { useAuthStore } from '../../stores/auth'

export type MenuGroupKey = 'devices' | 'matrix' | 'content' | 'system'
/** `feature`: shown only while the platform scope offers it (GET /api/platforms → features, stores/platforms.ts). */
export interface MenuItem { key: string; icon: Component; feature?: 'trending' }
export interface MenuGroup { key: MenuGroupKey; icon: Component; items: MenuItem[] }

/**
 * Sidebar: dashboard on top, then the product's four modules. An item key is also its route path
 * and its `nav.<key>` label; admin-only items follow the route's `meta.admin`.
 * The breadcrumb and the default page title (PageContainer) are derived from this list too.
 */
export const MENU_GROUPS: MenuGroup[] = [
  { key: 'devices', icon: CloudOutlined, items: [
    { key: 'instances', icon: MobileOutlined }, { key: 'connections', icon: ApiOutlined },
    { key: 'library', icon: AppstoreOutlined }, { key: 'proxies', icon: ClusterOutlined },
  ] },
  { key: 'matrix', icon: ShareAltOutlined, items: [
    { key: 'personas', icon: IdcardOutlined }, { key: 'social', icon: TeamOutlined }, { key: 'analytics', icon: RiseOutlined },
    { key: 'tracked', icon: EyeOutlined }, { key: 'comments', icon: CommentOutlined },
  ] },
  { key: 'content', icon: ReadOutlined, items: [
    { key: 'media', icon: PictureOutlined }, { key: 'trending', icon: FireOutlined, feature: 'trending' },
    { key: 'content', icon: FileTextOutlined }, { key: 'publish', icon: CalendarOutlined },
  ] },
  { key: 'system', icon: ControlOutlined, items: [
    { key: 'users', icon: UserOutlined }, { key: 'permissions', icon: SafetyOutlined }, { key: 'audit', icon: FileSearchOutlined },
    { key: 'system', icon: DatabaseOutlined }, { key: 'settings', icon: SettingOutlined }, { key: 'risk', icon: SecurityScanOutlined },
    { key: 'alert-channels', icon: AlertOutlined }, { key: 'tasks', icon: ScheduleOutlined },
  ] },
]

export const MENU_KEYS = ['dashboard', ...MENU_GROUPS.flatMap((g) => g.items.map((it) => it.key))]
/** Pages outside the sidebar (opened from the header, e.g. the user menu's 通知中心): own title, no group. */
const PAGE_KEYS = [...MENU_KEYS, 'notifications']

/**
 * Label of a menu item. 云机管理 is 「我的云手机」 for non-admins (same route /instances, owner decision 2026-11-18): the
 * sidebar, the breadcrumb and the page title use this.
 */
export function navLabel(key: string, admin: boolean): string {
  return key === 'instances' && !admin ? t('nav.myInstances') : t(`nav.${key}`)
}

/** Menu position of the current route: `/instances/abc` → group devices, item instances (null = dashboard / unknown). */
export function useMenuLocation() {
  const route = useRoute()
  const auth = useAuthStore()
  const itemKey = computed(() => PAGE_KEYS.find((k) => route.path === `/${k}` || route.path.startsWith(`/${k}/`)) ?? 'dashboard')
  const group = computed(() => MENU_GROUPS.find((g) => g.items.some((it) => it.key === itemKey.value)) ?? null)
  /** Default page title: the menu label of the current item. */
  const title = computed(() => navLabel(itemKey.value, auth.isAdmin))
  return { itemKey, group, title }
}
