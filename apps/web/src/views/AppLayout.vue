<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { message } from 'ant-design-vue'
import type { FormInstance } from 'ant-design-vue'
import type { Rule } from 'ant-design-vue/es/form'
import {
  AppstoreOutlined, FileSearchOutlined, LockOutlined, LogoutOutlined, MobileOutlined, PictureOutlined, SafetyOutlined, UserOutlined,
} from '@ant-design/icons-vue'
import { ROLE_TEXT } from '../api/types'
import { useAuthStore } from '../stores/auth'
import { useInstancesStore } from '../stores/instances'

const auth = useAuthStore()
const store = useInstancesStore()
const route = useRoute()
const router = useRouter()

const collapsed = ref(false)
const MENU_KEYS = ['users', 'permissions', 'audit', 'library', 'assets'] as const
const selected = computed(() => [MENU_KEYS.find((k) => route.path.startsWith(`/${k}`)) ?? 'instances'])

onMounted(() => { store.connect(); void store.refresh() })
onBeforeUnmount(() => store.disconnect())

function logout() {
  store.disconnect()
  auth.logout()
  void router.push({ name: 'login' })
}

const shownName = computed(() => auth.user?.displayName || auth.user?.username || '')
const avatarText = computed(() => shownName.value.charAt(0).toUpperCase())
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e))

function onMenu({ key }: { key: string | number }) {
  if (key === 'profile') openProfile()
  else if (key === 'password') openPassword()
  else if (key === 'logout') logout()
}

// 个人信息
const profileOpen = ref(false)
const profileSaving = ref(false)
const profileFormRef = ref<FormInstance>()
const profileForm = reactive({ displayName: '', email: '' })
const profileRules: Record<string, Rule[]> = {
  displayName: [{ max: 40, message: '最多 40 个字符' }],
  email: [{ type: 'email', message: '邮箱格式不正确', trigger: 'blur' }],
}
function openProfile() {
  profileForm.displayName = auth.user?.displayName ?? ''
  profileForm.email = auth.user?.email ?? ''
  profileOpen.value = true
}
async function saveProfile() {
  try { await profileFormRef.value?.validate() } catch { return }
  profileSaving.value = true
  try {
    await auth.updateProfile({ displayName: profileForm.displayName.trim(), email: profileForm.email.trim() })
    message.success('已保存')
    profileOpen.value = false
  } catch (e) {
    message.error(errMsg(e))
  } finally {
    profileSaving.value = false
  }
}

// 修改密码
const pwOpen = ref(false)
const pwSaving = ref(false)
const pwFormRef = ref<FormInstance>()
const pwForm = reactive({ currentPassword: '', newPassword: '', confirmPassword: '' })
const pwRules: Record<string, Rule[]> = {
  currentPassword: [{ required: true, message: '请输入当前密码' }],
  newPassword: [
    { required: true, message: '请输入新密码' },
    { min: 8, message: '至少 8 位' },
    { max: 128, message: '最多 128 位' },
  ],
  confirmPassword: [
    { required: true, message: '请再次输入新密码' },
    {
      validator: async (_rule: Rule, value: string) => {
        if (value && value !== pwForm.newPassword) throw new Error('两次输入的新密码不一致')
      },
    },
  ],
}
function openPassword() {
  pwForm.currentPassword = ''
  pwForm.newPassword = ''
  pwForm.confirmPassword = ''
  pwFormRef.value?.clearValidate()
  pwOpen.value = true
}
async function savePassword() {
  try { await pwFormRef.value?.validate() } catch { return }
  pwSaving.value = true
  try {
    await auth.changePassword(pwForm.currentPassword, pwForm.newPassword)
    pwOpen.value = false
    message.success('密码已修改，请重新登录')
    logout()
  } catch (e) {
    message.error(errMsg(e))
  } finally {
    pwSaving.value = false
  }
}
</script>

<template>
  <a-layout style="min-height: 100vh">
    <a-layout-sider v-model:collapsed="collapsed" collapsible breakpoint="lg" :collapsed-width="64" theme="dark">
      <div class="brand">{{ collapsed ? '云' : '云手机管理平台' }}</div>
      <a-menu theme="dark" mode="inline" :selected-keys="selected">
        <a-menu-item key="instances" @click="router.push('/instances')">
          <MobileOutlined />
          <span>设备管理</span>
        </a-menu-item>
        <a-menu-item key="library" @click="router.push('/library')">
          <AppstoreOutlined />
          <span>应用库</span>
        </a-menu-item>
        <a-menu-item key="assets" @click="router.push('/assets')">
          <PictureOutlined />
          <span>素材库</span>
        </a-menu-item>
        <template v-if="auth.isAdmin">
          <a-menu-item key="users" @click="router.push('/users')">
            <UserOutlined />
            <span>用户管理</span>
          </a-menu-item>
          <a-menu-item key="permissions" @click="router.push('/permissions')">
            <SafetyOutlined />
            <span>权限管理</span>
          </a-menu-item>
          <a-menu-item key="audit" @click="router.push('/audit')">
            <FileSearchOutlined />
            <span>操作日志</span>
          </a-menu-item>
        </template>
      </a-menu>
    </a-layout-sider>
    <a-layout>
      <a-layout-header class="header">
        <a-tooltip :title="store.connected ? '实时连接正常' : '实时连接已断开，正在重连'">
          <a-badge :status="store.connected ? 'success' : 'error'" />
        </a-tooltip>
        <a-dropdown :trigger="['click']" placement="bottomRight">
          <a class="user-trigger" role="button" tabindex="0" @click.prevent>
            <a-avatar size="small" class="avatar">{{ avatarText }}</a-avatar>
            <span class="who">{{ shownName }} · {{ auth.user ? ROLE_TEXT[auth.user.role] : '' }}</span>
          </a>
          <template #overlay>
            <a-menu @click="onMenu">
              <a-menu-item key="profile"><UserOutlined /> 个人信息</a-menu-item>
              <a-menu-item key="password"><LockOutlined /> 修改密码</a-menu-item>
              <a-menu-divider />
              <a-menu-item key="logout"><LogoutOutlined /> 退出登录</a-menu-item>
            </a-menu>
          </template>
        </a-dropdown>
      </a-layout-header>
      <a-layout-content class="content">
        <router-view />
      </a-layout-content>
    </a-layout>
  </a-layout>

  <a-modal v-model:open="profileOpen" title="个人信息" ok-text="保存" :confirm-loading="profileSaving" @ok="saveProfile">
    <a-form ref="profileFormRef" :model="profileForm" :rules="profileRules" layout="vertical">
      <a-form-item label="用户名"><a-input :value="auth.user?.username" disabled /></a-form-item>
      <a-form-item label="角色">{{ auth.user ? ROLE_TEXT[auth.user.role] : '' }}</a-form-item>
      <a-form-item label="显示名称" name="displayName">
        <a-input v-model:value="profileForm.displayName" :maxlength="40" placeholder="留空则显示用户名" autocomplete="nickname" />
      </a-form-item>
      <a-form-item label="邮箱" name="email">
        <a-input v-model:value="profileForm.email" placeholder="可选" autocomplete="email" />
      </a-form-item>
    </a-form>
  </a-modal>

  <a-modal v-model:open="pwOpen" title="修改密码" ok-text="修改" :confirm-loading="pwSaving" @ok="savePassword">
    <a-form ref="pwFormRef" :model="pwForm" :rules="pwRules" layout="vertical">
      <input type="text" name="username" :value="auth.user?.username" autocomplete="username" hidden readonly />
      <a-form-item label="当前密码" name="currentPassword">
        <a-input-password v-model:value="pwForm.currentPassword" autocomplete="current-password" />
      </a-form-item>
      <a-form-item label="新密码" name="newPassword" extra="至少 8 位">
        <a-input-password v-model:value="pwForm.newPassword" autocomplete="new-password" />
      </a-form-item>
      <a-form-item label="确认新密码" name="confirmPassword">
        <a-input-password v-model:value="pwForm.confirmPassword" autocomplete="new-password" />
      </a-form-item>
    </a-form>
  </a-modal>
</template>

<style scoped>
.brand {
  height: 64px; display: flex; align-items: center; justify-content: center;
  color: #fff; font-weight: 600; font-size: 16px; white-space: nowrap; overflow: hidden; padding: 0 12px;
}
.header {
  display: flex; align-items: center; justify-content: flex-end; gap: 12px;
  padding: 0 24px; background: #fff; white-space: nowrap;
}
.user-trigger {
  display: inline-flex; align-items: center; gap: 8px; color: inherit; cursor: pointer;
  padding: 0 8px; border-radius: 6px; line-height: 32px;
}
.user-trigger:hover { background: rgba(0, 0, 0, 0.04); }
.avatar { background: #1677ff; flex: none; }
.who { font-size: 13px; }
.content { padding: 24px; }
@media (max-width: 640px) {
  .header { padding: 0 12px; }
  .who { display: none; }
  .content { padding: 12px; }
}
</style>
