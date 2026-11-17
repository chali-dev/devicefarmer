<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, type Component } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { message } from 'ant-design-vue'
import type { FormInstance } from 'ant-design-vue'
import type { Rule } from 'ant-design-vue/es/form'
import {
  AppstoreOutlined, EyeOutlined, ClusterOutlined, CheckOutlined, FileSearchOutlined, GlobalOutlined, LockOutlined, LogoutOutlined, MobileOutlined, PictureOutlined, ScheduleOutlined,
  SafetyOutlined, TeamOutlined, UserOutlined, FileTextOutlined, CalendarOutlined, DashboardOutlined, SettingOutlined, ControlOutlined, CommentOutlined, WarningOutlined, ApiOutlined, DatabaseOutlined, BookOutlined, RiseOutlined,
  CloudOutlined, ShareAltOutlined, ReadOutlined, FireOutlined,
} from '@ant-design/icons-vue'
import { useI18n } from 'vue-i18n'
import { errorText } from '../api/client'
import NotificationBell from '../components/notify/NotificationBell.vue'
import { roleText } from '../api/types'
import { LOCALES, locale, setLocale, type Locale } from '../i18n'
import { isDark, setThemeMode } from '../theme'
import { useAuthStore } from '../stores/auth'
import { useInstancesStore } from '../stores/instances'

const auth = useAuthStore()
const store = useInstancesStore()
const route = useRoute()
const router = useRouter()
const { t } = useI18n()

/** Flips the effective theme; until the first click the preference stays 'system' and follows the OS. */
const themeToggleLabel = computed(() => (isDark.value ? t('prefs.toLight') : t('prefs.toDark')))
function toggleTheme() { setThemeMode(isDark.value ? 'light' : 'dark') }

const collapsed = ref(false)
/**
 * Sidebar: dashboard on top, then the product's four modules. An item key is also its route path
 * and its `nav.<key>` label; admin-only items follow the route's `meta.admin`.
 */
const MENU_GROUPS: { key: 'devices' | 'matrix' | 'content' | 'system'; icon: Component; items: { key: string; icon: Component }[] }[] = [
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
/** Groups with only the items this user may open; a group left empty is dropped (no bare header). */
const visibleGroups = computed(() => MENU_GROUPS
  .map((g) => ({ ...g, items: g.items.filter((it) => auth.isAdmin || !router.resolve(`/${it.key}`).meta.admin) }))
  .filter((g) => g.items.length > 0))
const MENU_KEYS = ['dashboard', ...MENU_GROUPS.flatMap((g) => g.items.map((it) => it.key))]
const selected = computed(() => [MENU_KEYS.find((k) => route.path.startsWith(`/${k}`)) ?? 'dashboard'])
/** All module groups start open (sub-menu keys are prefixed: 'content' and 'system' are also item keys). */
const openKeys = ref<string[]>(MENU_GROUPS.map((g) => `group-${g.key}`))

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
      <a-menu v-model:open-keys="openKeys" theme="dark" mode="inline" :inline-indent="16" :selected-keys="selected">
        <a-menu-item key="dashboard" @click="router.push('/dashboard')">
          <DashboardOutlined />
          <span>{{ t('nav.dashboard') }}</span>
        </a-menu-item>
        <a-sub-menu v-for="g in visibleGroups" :key="`group-${g.key}`">
          <template #icon><component :is="g.icon" /></template>
          <template #title>{{ t(`nav.group.${g.key}`) }}</template>
          <a-menu-item v-for="it in g.items" :key="it.key" @click="router.push(`/${it.key}`)">
            <component :is="it.icon" />
            <span>{{ t(`nav.${it.key}`) }}</span>
          </a-menu-item>
        </a-sub-menu>
      </a-menu>
    </a-layout-sider>
    <a-layout>
      <a-layout-header class="header">
        <a-tooltip v-if="!store.connected" :title="t('header.disconnected')">
          <WarningOutlined class="conn-lost" role="status" :aria-label="t('header.disconnected')" />
        </a-tooltip>
        <NotificationBell />
        <a-tooltip :title="themeToggleLabel">
          <a-button type="text" class="pref-btn" :aria-label="themeToggleLabel" @click="toggleTheme">
            <span class="anticon" aria-hidden="true">
              <!-- Moon while dark, sun while light (icons-vue has neither). -->
              <svg v-if="isDark" viewBox="0 0 24 24" width="1em" height="1em" fill="currentColor"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" /></svg>
              <svg v-else viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4.5" /><path d="M12 1.5v2.5M12 20v2.5M1.5 12H4M20 12h2.5M4.6 4.6l1.8 1.8M17.6 17.6l1.8 1.8M4.6 19.4l1.8-1.8M17.6 6.4l1.8-1.8" /></svg>
            </span>
          </a-button>
        </a-tooltip>
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
.conn-lost { color: var(--cp-warning); font-size: 16px; }
.avatar { background: var(--cp-primary); flex: none; }
.who { font-size: 13px; }
.content { padding: 24px; }
@media (max-width: 640px) {
  .header { padding: 0 12px; }
  .who { display: none; }
  .content { padding: 12px; }
}
</style>
