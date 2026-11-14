<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAuthStore } from '../stores/auth'
import { useInstancesStore } from '../stores/instances'

const auth = useAuthStore()
const store = useInstancesStore()
const route = useRoute()
const router = useRouter()

const ROLE_TEXT = { admin: '管理员', operator: '运维', viewer: '只读/控制' } as const
const selected = computed(() => [route.path.startsWith('/users') ? 'users' : route.path.startsWith('/library') ? 'library' : 'instances'])

onMounted(() => { store.connect(); void store.refresh() })
onBeforeUnmount(() => store.disconnect())

function logout() {
  store.disconnect()
  auth.logout()
  void router.push({ name: 'login' })
}
</script>

<template>
  <a-layout style="min-height: 100vh">
    <a-layout-header class="header">
      <div class="brand">云手机管理平台</div>
      <a-menu theme="dark" mode="horizontal" :selected-keys="selected" class="menu">
        <a-menu-item key="instances" @click="router.push('/instances')">实例</a-menu-item>
        <a-menu-item key="library" @click="router.push('/library')">应用库</a-menu-item>
        <a-menu-item v-if="auth.isAdmin" key="users" @click="router.push('/users')">用户与权限</a-menu-item>
      </a-menu>
      <div class="right">
        <a-tooltip :title="store.connected ? '实时连接正常' : '实时连接已断开，正在重连'">
          <a-badge :status="store.connected ? 'success' : 'error'" />
        </a-tooltip>
        <span class="who">{{ auth.user?.username }} · {{ auth.user ? ROLE_TEXT[auth.user.role] : '' }}</span>
        <a-button size="small" ghost @click="logout">退出</a-button>
      </div>
    </a-layout-header>
    <a-layout-content class="content">
      <router-view />
    </a-layout-content>
  </a-layout>
</template>

<style scoped>
.header { display: flex; align-items: center; gap: 24px; padding: 0 24px; }
.brand { color: #fff; font-weight: 600; font-size: 16px; white-space: nowrap; }
.menu { flex: 1; min-width: 0; }
.right { display: flex; align-items: center; gap: 12px; color: rgba(255, 255, 255, 0.85); white-space: nowrap; }
.who { font-size: 13px; }
.content { padding: 24px; }
@media (max-width: 640px) {
  .header { padding: 0 12px; gap: 12px; }
  .who { display: none; }
  .content { padding: 12px; }
}
</style>
