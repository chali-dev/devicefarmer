import { computed, type Component } from 'vue'
import { useRoute } from 'vue-router'
import {
  ApiOutlined, AppstoreOutlined, BookOutlined, CalendarOutlined, CloudOutlined, ClusterOutlined, CommentOutlined, ControlOutlined, DatabaseOutlined,
  EyeOutlined, FileSearchOutlined, FileTextOutlined, FireOutlined, MobileOutlined, PictureOutlined, ReadOutlined, RiseOutlined, SafetyOutlined,
  ScheduleOutlined, SettingOutlined, ShareAltOutlined, TeamOutlined, UserOutlined,
} from '@ant-design/icons-vue'
import { t } from '../../i18n'

export type MenuGroupKey = 'devices' | 'matrix' | 'content' | 'system'
export interface MenuItem { key: string; icon: Component }
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
    { key: 'social', icon: TeamOutlined }, { key: 'analytics', icon: RiseOutlined },
    { key: 'tracked', icon: EyeOutlined }, { key: 'comments', icon: CommentOutlined },
  ] },
  { key: 'content', icon: ReadOutlined, items: [
    { key: 'media', icon: PictureOutlined }, { key: 'scripts', icon: BookOutlined }, { key: 'trending', icon: FireOutlined },
    { key: 'content', icon: FileTextOutlined }, { key: 'publish', icon: CalendarOutlined },
  ] },
  { key: 'system', icon: ControlOutlined, items: [
    { key: 'users', icon: UserOutlined }, { key: 'permissions', icon: SafetyOutlined }, { key: 'audit', icon: FileSearchOutlined },
    { key: 'system', icon: DatabaseOutlined }, { key: 'settings', icon: SettingOutlined }, { key: 'tasks', icon: ScheduleOutlined },
  ] },
]

export const MENU_KEYS = ['dashboard', ...MENU_GROUPS.flatMap((g) => g.items.map((it) => it.key))]

/** Menu position of the current route: `/instances/abc` → group devices, item instances (null = dashboard / unknown). */
export function useMenuLocation() {
  const route = useRoute()
  const itemKey = computed(() => MENU_KEYS.find((k) => route.path === `/${k}` || route.path.startsWith(`/${k}/`)) ?? 'dashboard')
  const group = computed(() => MENU_GROUPS.find((g) => g.items.some((it) => it.key === itemKey.value)) ?? null)
  /** Default page title: the menu label of the current item. */
  const title = computed(() => t(`nav.${itemKey.value}`))
  return { itemKey, group, title }
}
