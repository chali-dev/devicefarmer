import { createRouter, createWebHistory } from 'vue-router'
import { useAuthStore } from '../stores/auth'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/login', name: 'login', component: () => import('../views/LoginView.vue'), meta: { public: true } },
    {
      path: '/',
      component: () => import('../views/AppLayout.vue'),
      children: [
        { path: '', redirect: '/dashboard' },
        { path: 'dashboard', name: 'dashboard', component: () => import('../views/DashboardView.vue') },
        { path: 'instances', name: 'instances', component: () => import('../views/InstancesView.vue') },
        { path: 'instances/:id', name: 'instance', component: () => import('../views/InstanceDetailView.vue'), props: true },
        { path: 'library', name: 'library', component: () => import('../views/LibraryView.vue'), meta: { admin: true } },
        { path: 'media', name: 'media', component: () => import('../views/MediaView.vue') },
        { path: 'social', name: 'social', component: () => import('../views/SocialAccountsView.vue') },
        // 媒体管理 (owner's menu list, 2026-11-18): 追踪号 and 回文日志 are tabs of /social; old links keep their filters.
        { path: 'tracked', redirect: (to) => ({ path: '/social', query: { ...to.query, tab: 'tracked' } }) },
        { path: 'analytics', name: 'analytics', component: () => import('../views/AnalyticsView.vue') },
        { path: 'content', name: 'content', component: () => import('../views/ContentView.vue') },
        { path: 'publish', name: 'publish', component: () => import('../views/PublishView.vue') },
        // /comments?tab=queue|history|comments → /social?tab=replies&view=… (the comments page's own tabs became views).
        { path: 'comments', redirect: (to) => ({ path: '/social', query: { ...to.query, tab: 'replies', view: typeof to.query.tab === 'string' ? to.query.tab : undefined } }) },
        { path: 'personas', name: 'personas', component: () => import('../views/PersonasView.vue') },
        // 话术库 removed (owner decision 2026-11-18): templates are the 范例 in the persona form.
        { path: 'scripts', redirect: '/personas' },
        { path: 'trending', name: 'trending', component: () => import('../views/TrendingView.vue') },
        { path: 'notifications', name: 'notifications', component: () => import('../views/NotificationsView.vue') },
        { path: 'tasks', name: 'tasks', component: () => import('../views/TasksView.vue') },
        { path: 'settings', name: 'settings', component: () => import('../views/SettingsView.vue'), meta: { admin: true } },
        // Platform integrations (official APIs) were removed on 2026-11-18; old links land on Settings.
        { path: 'platforms', redirect: '/settings' },
        { path: 'alert-channels', name: 'alert-channels', component: () => import('../views/AlertChannelsView.vue'), meta: { admin: true } },
        { path: 'risk', name: 'risk', component: () => import('../views/RiskView.vue'), meta: { admin: true } },
        { path: 'proxies', name: 'proxies', component: () => import('../views/ProxiesView.vue'), meta: { admin: true } },
        { path: 'users', name: 'users', component: () => import('../views/UsersView.vue'), meta: { admin: true } },
        // 权限管理 = 角色菜单权限 (owner 2026-11-18; device assignment is 我的云机 → 分配).
        { path: 'permissions', name: 'permissions', component: () => import('../views/PermissionsView.vue'), meta: { admin: true } },
        { path: 'audit', name: 'audit', component: () => import('../views/AuditView.vue'), meta: { admin: true } },
        { path: 'connections', name: 'connections', component: () => import('../views/ConnectionsView.vue'), meta: { admin: true } },
        { path: 'risk-events', name: 'risk-events', component: () => import('../views/RiskEventsView.vue'), meta: { admin: true } },
        { path: 'logs', name: 'logs', component: () => import('../views/LogsView.vue'), meta: { admin: true } },
        // 系统维护 dissolved (owner 2026-11-18): backups → 系统配置 备份与保留, logs → 系统日志.
        { path: 'system', redirect: (to) => (to.query.tab === 'logs' ? { path: '/logs' } : { path: '/settings', query: { tab: 'backup' } }) },
      ],
    },
    { path: '/:pathMatch(.*)*', redirect: '/dashboard' },
  ],
})

router.beforeEach(async (to) => {
  const auth = useAuthStore()
  if (to.meta.public) return true
  if (!auth.user && !(await auth.loadMe())) return { name: 'login', query: { redirect: to.fullPath } }
  if (to.meta.admin && !auth.isAdmin) return { name: 'dashboard' }
  // 角色菜单权限: a menu switched off for the user role (its first path segment) leads to the dashboard.
  const top = to.path.split('/')[1] ?? ''
  if (!auth.menuAllowed(top)) return { name: 'dashboard' }
  return true
})

export default router
