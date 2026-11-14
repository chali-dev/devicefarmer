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
        { path: '', redirect: '/instances' },
        { path: 'instances', name: 'instances', component: () => import('../views/InstancesView.vue') },
        { path: 'instances/:id', name: 'instance', component: () => import('../views/InstanceDetailView.vue'), props: true },
        { path: 'library', name: 'library', component: () => import('../views/LibraryView.vue') },
        { path: 'assets', name: 'assets', component: () => import('../views/AssetsView.vue') },
        { path: 'users', name: 'users', component: () => import('../views/UsersView.vue'), meta: { admin: true } },
        { path: 'permissions', name: 'permissions', component: () => import('../views/PermissionsView.vue'), meta: { admin: true } },
        { path: 'audit', name: 'audit', component: () => import('../views/AuditView.vue'), meta: { admin: true } },
      ],
    },
    { path: '/:pathMatch(.*)*', redirect: '/instances' },
  ],
})

router.beforeEach(async (to) => {
  const auth = useAuthStore()
  if (to.meta.public) return true
  if (!auth.user && !(await auth.loadMe())) return { name: 'login', query: { redirect: to.fullPath } }
  if (to.meta.admin && !auth.isAdmin) return { name: 'instances' }
  return true
})

export default router
