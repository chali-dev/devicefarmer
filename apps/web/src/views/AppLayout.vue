<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { message } from 'ant-design-vue'
import type { FormInstance } from 'ant-design-vue'
import type { Rule } from 'ant-design-vue/es/form'
import {
  AppstoreOutlined, BulbOutlined, EyeOutlined, ClusterOutlined, CheckOutlined, FileSearchOutlined, GlobalOutlined, LockOutlined, LogoutOutlined, MobileOutlined, PictureOutlined, ScheduleOutlined,
  SafetyOutlined, TeamOutlined, UserOutlined, FileTextOutlined, CalendarOutlined, DashboardOutlined, SettingOutlined, ControlOutlined, CommentOutlined,
} from '@ant-design/icons-vue'
import { useI18n } from 'vue-i18n'
import { errorText } from '../api/client'
import { roleText } from '../api/types'
import { LOCALES, locale, setLocale, type Locale } from '../i18n'
import { setThemeMode, themeMode, type ThemeMode } from '../theme'
import { useAuthStore } from '../stores/auth'
import { useInstancesStore } from '../stores/instances'

const auth = useAuthStore()
const store = useInstancesStore()
const route = useRoute()
const router = useRouter()
const { t } = useI18n()

const THEMES = computed(() => [
  { value: 'system' as ThemeMode, label: t('prefs.themeSystem') },
  { value: 'light' as ThemeMode, label: t('prefs.themeLight') },
  { value: 'dark' as ThemeMode, label: t('prefs.themeDark') },
])

const collapsed = ref(false)
const MENU_KEYS = ['dashboard', 'instances', 'library', 'proxies', 'social', 'tracked', 'media', 'content', 'publish', 'comments', 'tasks', 'settings', 'users', 'permissions', 'audit'] as const
const selected = computed(() => [MENU_KEYS.find((k) => route.path.startsWith(`/${k}`)) ?? 'dashboard'])
/** Sub-menus (cloud devices, administration) start open. */
const openKeys = ref<string[]>(['devices', 'admin'])

onMounted(() => { store.connect(); void store.refresh() })
onBeforeUnmount(() => store.disconnect())

function logout() {
  store.disconnect()
  auth.logout()
  void router.push({ name: 'login' })
}

const shownName = computed(() => auth.user?.displayName || auth.user?.username || '')
const avatarText = computed(() => shownName.value.charAt(0).toUpperCase())

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
const profileRules = computed<Record<string, Rule[]>>(() => ({
  displayName: [{ max: 40, message: t('profile.max40') }],
  email: [{ type: 'email', message: t('profile.badEmail'), trigger: 'blur' }],
}))
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
    message.success(t('common.saved'))
    profileOpen.value = false
  } catch (e) {
    message.error(errorText(e))
  } finally {
    profileSaving.value = false
  }
}

// 修改密码
const pwOpen = ref(false)
const pwSaving = ref(false)
const pwFormRef = ref<FormInstance>()
const pwForm = reactive({ currentPassword: '', newPassword: '', confirmPassword: '' })
const pwRules = computed<Record<string, Rule[]>>(() => ({
  currentPassword: [{ required: true, message: t('password.enterCurrent') }],
  newPassword: [
    { required: true, message: t('password.enterNew') },
    { min: 8, message: t('password.min8') },
    { max: 128, message: t('password.max128') },
  ],
  confirmPassword: [
    { required: true, message: t('password.enterAgain') },
    {
      validator: async (_rule: Rule, value: string) => {
        if (value && value !== pwForm.newPassword) throw new Error(t('password.mismatch'))
      },
    },
  ],
}))
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
    message.success(t('password.changed'))
    logout()
  } catch (e) {
    message.error(errorText(e))
  } finally {
    pwSaving.value = false
  }
}
</script>

<template>
  <a-layout style="min-height: 100vh">
    <a-layout-sider v-model:collapsed="collapsed" collapsible breakpoint="lg" :collapsed-width="64" theme="dark">
      <div class="brand">{{ collapsed ? t('app.short') : t('app.title') }}</div>
      <a-menu v-model:open-keys="openKeys" theme="dark" mode="inline" :selected-keys="selected">
        <a-menu-item key="dashboard" @click="router.push('/dashboard')">
          <DashboardOutlined />
          <span>{{ t('nav.dashboard') }}</span>
        </a-menu-item>
        <a-sub-menu key="devices">
          <template #icon><MobileOutlined /></template>
          <template #title>{{ t('nav.cloudDevices') }}</template>
          <a-menu-item key="instances" @click="router.push('/instances')">
            <MobileOutlined />
            <span>{{ t('nav.instances') }}</span>
          </a-menu-item>
          <a-menu-item key="library" @click="router.push('/library')">
            <AppstoreOutlined />
            <span>{{ t('nav.library') }}</span>
          </a-menu-item>
          <a-menu-item v-if="auth.isAdmin" key="proxies" @click="router.push('/proxies')">
            <ClusterOutlined />
            <span>{{ t('nav.proxies') }}</span>
          </a-menu-item>
        </a-sub-menu>
        <a-menu-item key="social" @click="router.push('/social')">
          <TeamOutlined />
          <span>{{ t('nav.social') }}</span>
        </a-menu-item>
        <a-menu-item key="tracked" @click="router.push('/tracked')">
          <EyeOutlined />
          <span>{{ t('nav.tracked') }}</span>
        </a-menu-item>
        <a-menu-item key="media" @click="router.push('/media')">
          <PictureOutlined />
          <span>{{ t('nav.media') }}</span>
        </a-menu-item>
        <a-menu-item key="content" @click="router.push('/content')">
          <FileTextOutlined />
          <span>{{ t('nav.content') }}</span>
        </a-menu-item>
        <a-menu-item key="publish" @click="router.push('/publish')">
          <CalendarOutlined />
          <span>{{ t('nav.publish') }}</span>
        </a-menu-item>
        <a-menu-item key="comments" @click="router.push('/comments')">
          <CommentOutlined />
          <span>{{ t('nav.comments') }}</span>
        </a-menu-item>
        <a-menu-item key="tasks" @click="router.push('/tasks')">
          <ScheduleOutlined />
          <span>{{ t('nav.tasks') }}</span>
        </a-menu-item>
        <template v-if="auth.isAdmin">
          <a-menu-item key="settings" @click="router.push('/settings')">
            <SettingOutlined />
            <span>{{ t('nav.settings') }}</span>
          </a-menu-item>
          <a-sub-menu key="admin">
            <template #icon><ControlOutlined /></template>
            <template #title>{{ t('nav.admin') }}</template>
            <a-menu-item key="users" @click="router.push('/users')">
              <UserOutlined />
              <span>{{ t('nav.users') }}</span>
            </a-menu-item>
            <a-menu-item key="permissions" @click="router.push('/permissions')">
              <SafetyOutlined />
              <span>{{ t('nav.permissions') }}</span>
            </a-menu-item>
            <a-menu-item key="audit" @click="router.push('/audit')">
              <FileSearchOutlined />
              <span>{{ t('nav.audit') }}</span>
            </a-menu-item>
          </a-sub-menu>
        </template>
      </a-menu>
    </a-layout-sider>
    <a-layout>
      <a-layout-header class="header">
        <a-tooltip :title="store.connected ? t('header.connected') : t('header.disconnected')">
          <a-badge :status="store.connected ? 'success' : 'error'" />
        </a-tooltip>
        <a-dropdown :trigger="['click']" placement="bottomRight">
          <a-button type="text" class="pref-btn" :title="t('prefs.theme')" :aria-label="t('prefs.theme')"><BulbOutlined /></a-button>
          <template #overlay>
            <a-menu :selected-keys="[themeMode]" @click="({ key }: any) => setThemeMode(key as ThemeMode)">
              <a-menu-item v-for="m in THEMES" :key="m.value">
                <CheckOutlined :style="{ visibility: themeMode === m.value ? 'visible' : 'hidden' }" /> {{ m.label }}
              </a-menu-item>
            </a-menu>
          </template>
        </a-dropdown>
        <a-dropdown :trigger="['click']" placement="bottomRight">
          <a-button type="text" class="pref-btn" :title="t('prefs.language')" :aria-label="t('prefs.language')"><GlobalOutlined /></a-button>
          <template #overlay>
            <a-menu :selected-keys="[locale]" @click="({ key }: any) => setLocale(key as Locale)">
              <a-menu-item v-for="l in LOCALES" :key="l.value">
                <CheckOutlined :style="{ visibility: locale === l.value ? 'visible' : 'hidden' }" /> {{ l.label }}
              </a-menu-item>
            </a-menu>
          </template>
        </a-dropdown>
        <a-dropdown :trigger="['click']" placement="bottomRight">
          <a class="user-trigger" role="button" tabindex="0" @click.prevent>
            <a-avatar size="small" class="avatar">{{ avatarText }}</a-avatar>
            <span class="who">{{ shownName }} · {{ auth.user ? roleText(auth.user.role) : '' }}</span>
          </a>
          <template #overlay>
            <a-menu @click="onMenu">
              <a-menu-item key="profile"><UserOutlined /> {{ t('header.profile') }}</a-menu-item>
              <a-menu-item key="password"><LockOutlined /> {{ t('header.changePassword') }}</a-menu-item>
              <a-menu-divider />
              <a-menu-item key="logout"><LogoutOutlined /> {{ t('header.logout') }}</a-menu-item>
            </a-menu>
          </template>
        </a-dropdown>
      </a-layout-header>
      <a-layout-content class="content">
        <router-view />
      </a-layout-content>
    </a-layout>
  </a-layout>

  <a-modal v-model:open="profileOpen" :title="t('header.profile')" :ok-text="t('common.save')" :cancel-text="t('common.cancel')" :confirm-loading="profileSaving" @ok="saveProfile">
    <a-form ref="profileFormRef" :model="profileForm" :rules="profileRules" layout="vertical">
      <a-form-item :label="t('common.username')"><a-input :value="auth.user?.username" disabled /></a-form-item>
      <a-form-item :label="t('common.role')">{{ auth.user ? roleText(auth.user.role) : '' }}</a-form-item>
      <a-form-item :label="t('profile.displayName')" name="displayName">
        <a-input v-model:value="profileForm.displayName" :maxlength="40" :placeholder="t('profile.displayNamePlaceholder')" autocomplete="nickname" />
      </a-form-item>
      <a-form-item :label="t('profile.email')" name="email">
        <a-input v-model:value="profileForm.email" :placeholder="t('common.optional')" autocomplete="email" />
      </a-form-item>
    </a-form>
  </a-modal>

  <a-modal v-model:open="pwOpen" :title="t('header.changePassword')" :ok-text="t('password.change')" :cancel-text="t('common.cancel')" :confirm-loading="pwSaving" @ok="savePassword">
    <a-form ref="pwFormRef" :model="pwForm" :rules="pwRules" layout="vertical">
      <input type="text" name="username" :value="auth.user?.username" autocomplete="username" hidden readonly />
      <a-form-item :label="t('password.current')" name="currentPassword">
        <a-input-password v-model:value="pwForm.currentPassword" autocomplete="current-password" />
      </a-form-item>
      <a-form-item :label="t('password.new')" name="newPassword" :extra="t('password.min8')">
        <a-input-password v-model:value="pwForm.newPassword" autocomplete="new-password" />
      </a-form-item>
      <a-form-item :label="t('password.confirm')" name="confirmPassword">
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
  padding: 0 24px; background: var(--cp-bg-container); white-space: nowrap;
}
.user-trigger {
  display: inline-flex; align-items: center; gap: 8px; color: inherit; cursor: pointer;
  padding: 0 8px; border-radius: 6px; line-height: 32px;
}
.user-trigger:hover { background: var(--cp-bg-hover); }
.pref-btn { color: inherit; }
.avatar { background: var(--cp-primary); flex: none; }
.who { font-size: 13px; }
.content { padding: 24px; }
@media (max-width: 640px) {
  .header { padding: 0 12px; }
  .who { display: none; }
  .content { padding: 12px; }
}
</style>
