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
        { path: 'library', name: 'library', component: () => import('../views/LibraryView.vue') },
        { path: 'media', name: 'media', component: () => import('../views/MediaView.vue') },
        { path: 'social', name: 'social', component: () => import('../views/SocialAccountsView.vue') },
        { path: 'tracked', name: 'tracked', component: () => import('../views/TrackedAccountsView.vue') },
        { path: 'analytics', name: 'analytics', component: () => import('../views/AnalyticsView.vue') },
        { path: 'content', name: 'content', component: () => import('../views/ContentView.vue') },
        { path: 'publish', name: 'publish', component: () => import('../views/PublishView.vue') },
        { path: 'comments', name: 'comments', component: () => import('../views/CommentsView.vue') },
        { path: 'scripts', name: 'scripts', component: () => import('../views/ScriptsView.vue') },
        { path: 'trending', name: 'trending', component: () => import('../views/TrendingView.vue') },
        { path: 'tasks', name: 'tasks', component: () => import('../views/TasksView.vue') },
        { path: 'settings', name: 'settings', component: () => import('../views/SettingsView.vue'), meta: { admin: true } },
        // Platform integrations (official APIs) were removed on 2026-11-18; old links land on Settings.
        { path: 'platforms', redirect: '/settings' },
        { path: 'alert-channels', name: 'alert-channels', component: () => import('../views/AlertChannelsView.vue'), meta: { admin: true } },
        { path: 'risk', name: 'risk', component: () => import('../views/RiskView.vue'), meta: { admin: true } },
        { path: 'proxies', name: 'proxies', component: () => import('../views/ProxiesView.vue'), meta: { admin: true } },
        { path: 'users', name: 'users', component: () => import('../views/UsersView.vue'), meta: { admin: true } },
        { path: 'permissions', name: 'permissions', component: () => import('../views/PermissionsView.vue'), meta: { admin: true } },
        { path: 'audit', name: 'audit', component: () => import('../views/AuditView.vue'), meta: { admin: true } },
        { path: 'connections', name: 'connections', component: () => import('../views/ConnectionsView.vue') },
        { path: 'system', name: 'system', component: () => import('../views/SystemView.vue'), meta: { admin: true } },
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
  return true
})

export default router
