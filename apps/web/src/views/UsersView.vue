<script setup lang="ts">
import { fmtDateTime } from '../i18n'
import { PlusOutlined } from '@ant-design/icons-vue'
import { message } from 'ant-design-vue'
import { computed, onMounted, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { api, errorText } from '../api/client'
import type { CustomRole, ManagedUser, Role } from '../api/types'
import PageContainer from '../components/common/PageContainer.vue'
import { actionColumn, confirmAction, confirmDanger, MODAL_WIDTH, pagination, TABLE_SIZE } from '../components/common/ui'
import { useAuthStore } from '../stores/auth'

const auth = useAuthStore()
const users = ref<ManagedUser[]>([])
const roles = ref<CustomRole[]>([])
const loading = ref(false)

const { t } = useI18n()

/**
 * Role choice = 'admin' | 'user' (普通用户) | a 自定义角色 id (权限管理). A custom role is a variant of the user role
 * (same data scope, own menus), so it is sent as { role: 'user', roleId }.
 */
type RoleKey = string
const roleKey = (u: { role: Role; roleId: string | null }): RoleKey => (u.role === 'admin' ? 'admin' : u.roleId ?? 'user')
const roleLabel = (k: RoleKey, fallback?: string | null) => (k === 'admin' ? t('roleMenus.roleAdmin') : k === 'user' ? t('roleMenus.roleUser')
  : roles.value.find((r) => r.id === k)?.name ?? fallback ?? k)
const roleBody = (k: RoleKey) => (k === 'admin' ? { role: 'admin' as Role } : { role: 'user' as Role, roleId: k === 'user' ? null : k })
const roleOptions = computed(() => [
  { value: 'admin', label: t('roleMenus.roleAdmin') },
  { value: 'user', label: t('roleMenus.roleUser') },
  ...roles.value.map((r) => ({ value: r.id, label: r.name })),
])
const roleHelp = (k: RoleKey) => (k === 'admin' ? t('users.roleHelpAdmin') : k === 'user' ? t('users.roleHelpUser') : t('users.roleHelpCustom'))
const builtinTip = () => t('users.builtinTip')
const roleFilter = ref<RoleKey | undefined>(undefined)
const shown = computed(() => (roleFilter.value ? users.value.filter((u) => roleKey(u) === roleFilter.value) : users.value))

async function load() {
  loading.value = true
  try {
    const [u, r] = await Promise.all([
      api<{ users: ManagedUser[] }>('GET', '/api/users'),
      api<{ roles: CustomRole[] }>('GET', '/api/roles'),
    ])
    users.value = u.users
    roles.value = r.roles
  } catch (e) { message.error(errorText(e)) }
  finally { loading.value = false }
}
onMounted(load)

const columns = computed(() => [
  { title: t('common.username'), key: 'username', width: 200 },
  { title: t('profile.displayName'), dataIndex: 'displayName', key: 'displayName', width: 160, ellipsis: true },
  { title: t('profile.email'), dataIndex: 'email', key: 'email', width: 200, ellipsis: true },
  { title: t('common.role'), key: 'role', width: 140 },
  { title: t('users.enabled'), key: 'enabled', width: 80 },
  { title: t('users.createdAt'), key: 'createdAt', width: 180 },
  actionColumn(320),
])

/** Why the dangerous controls of a row are locked (null = editable). */
const lockReason = (u: ManagedUser) => (u.builtin ? t('users.builtinTip') : u.id === auth.user?.id ? t('users.selfTip') : null)

async function patch(u: ManagedUser, body: Partial<{ role: Role; roleId: string | null; disabled: boolean; password: string }>): Promise<boolean> {
  try { await api('PATCH', `/api/users/${u.id}`, body); message.success(t('common.saved')); return true }
  catch (e) { message.error(errorText(e)); return false }
  finally { await load() }
}

function changeRole(u: ManagedUser, k: RoleKey) {
  if (k === roleKey(u)) return
  confirmAction({
    title: t('users.confirmRole', { name: u.username, role: roleLabel(k) }),
    content: k === 'admin' ? t('users.toAdmin') : u.role === 'admin' ? t('users.toUser') : k === 'user' ? undefined : t('users.toCustom'),
    onOk: () => patch(u, roleBody(k)),
  })
}

function remove(u: ManagedUser) {
  confirmDanger({
    title: t('users.confirmDelete', { name: u.username }), content: t('users.deleteContent'),
    onOk: async () => {
      try { await api('DELETE', `/api/users/${u.id}`); message.success(t('common.deleted')) }
      catch (e) { message.error(errorText(e)) }
      finally { await load() }
    },
  })
}

// create
const createOpen = ref(false)
const creating = ref(false)
const form = reactive({ username: '', password: '', role: 'user' as RoleKey })
async function create() {
  if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(form.username)) return message.error(t('users.badUsername'))
  if (form.password.length < 8) return message.error(t('users.initialPasswordShort'))
  creating.value = true
  try {
    await api('POST', '/api/users', { username: form.username, password: form.password, ...roleBody(form.role) })
    message.success(t('common.created'))
    createOpen.value = false
    Object.assign(form, { username: '', password: '', role: 'user' })
    await load()
  } catch (e) { message.error(errorText(e)) }
  finally { creating.value = false }
}

// password reset
const pwUser = ref<ManagedUser | null>(null)
const newPw = ref('')
async function savePw() {
  if (!pwUser.value) return
  if (newPw.value.length < 8) return message.error(t('users.newPasswordShort'))
  if (await patch(pwUser.value, { password: newPw.value })) {
    pwUser.value = null
    newPw.value = ''
  }
}
</script>

<template>
  <PageContainer>
    <template #extra>
      <a-button type="primary" @click="createOpen = true"><template #icon><PlusOutlined /></template>{{ t('users.newUser') }}</a-button>
    </template>
    <a-card :bordered="false">
      <div class="filters">
        <a-select
          v-model:value="roleFilter" allow-clear :placeholder="t('users.filterRole')" :options="roleOptions" style="width: 180px"
          :aria-label="t('users.filterRole')"
        />
      </div>
      <a-table
        :data-source="shown" :columns="columns" row-key="id" :loading="loading" :size="TABLE_SIZE"
        :pagination="pagination({ defaultPageSize: 50, hideOnSinglePage: true })" :scroll="{ x: 1200 }"
      >
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'username'">
            <a-space :size="4">
              <span>{{ record.username }}</span>
              <a-tag v-if="record.builtin" color="gold">{{ t('users.builtin') }}</a-tag>
              <a-tag v-if="record.id === auth.user?.id">{{ t('users.me') }}</a-tag>
            </a-space>
          </template>
          <template v-else-if="column.key === 'displayName' || column.key === 'email'">
            {{ record[column.key] || '—' }}
          </template>
          <template v-else-if="column.key === 'role'">
            <a-tag :color="record.role === 'admin' ? 'blue' : record.roleId ? 'purple' : 'default'">{{ roleLabel(roleKey(record as ManagedUser), record.roleName) }}</a-tag>
          </template>
          <template v-else-if="column.key === 'enabled'">
            <a-tooltip :title="lockReason(record)">
              <a-switch :checked="!record.disabled" size="small" :disabled="!!lockReason(record)" @change="(v: any) => patch(record, { disabled: !v })" />
            </a-tooltip>
          </template>
          <template v-else-if="column.key === 'createdAt'">{{ fmtDateTime(record.createdAt) }}</template>
          <template v-else-if="column.key === 'ops'">
            <a-space :size="0">
              <a-tooltip :title="lockReason(record)">
                <a-select
                  :value="roleKey(record as ManagedUser)" size="small" style="width: 136px; margin-inline-end: 4px" :disabled="!!lockReason(record)"
                  :aria-label="t('common.role')" :options="roleOptions" @change="(v: any) => changeRole(record as ManagedUser, v)"
                />
              </a-tooltip>
              <a-tooltip :title="record.builtin ? builtinTip() : null">
                <a-button type="link" size="small" :disabled="record.builtin" @click="pwUser = record; newPw = ''">{{ t('users.resetPassword') }}</a-button>
              </a-tooltip>
              <a-tooltip :title="lockReason(record)">
                <a-button type="link" size="small" danger :disabled="!!lockReason(record)" @click="remove(record)">{{ t('common.delete') }}</a-button>
              </a-tooltip>
            </a-space>
          </template>
        </template>
      </a-table>
    </a-card>
  </PageContainer>

  <a-modal
    v-model:open="createOpen" :title="t('users.newUser')" :width="MODAL_WIDTH.sm" :ok-text="t('common.create')" :cancel-text="t('common.cancel')"
    :confirm-loading="creating" @ok="create"
  >
    <a-form layout="vertical">
      <a-form-item :label="t('common.username')" required>
        <a-input v-model:value="form.username" autocomplete="off" :placeholder="t('users.usernameHint')" />
      </a-form-item>
      <a-form-item :label="t('users.initialPassword')" required>
        <a-input-password v-model:value="form.password" autocomplete="new-password" :placeholder="t('users.min8')" />
      </a-form-item>
      <a-form-item :label="t('common.role')" :extra="roleHelp(form.role)">
        <a-select v-model:value="form.role" :options="roleOptions" />
      </a-form-item>
    </a-form>
  </a-modal>

  <a-modal
    :open="!!pwUser" :title="t('users.resetTitle', { name: pwUser?.username ?? '' })" :width="MODAL_WIDTH.sm"
    :ok-text="t('common.save')" :cancel-text="t('common.cancel')" @ok="savePw" @cancel="pwUser = null"
  >
    <a-input-password v-model:value="newPw" :placeholder="t('users.newPasswordPlaceholder')" autocomplete="new-password" />
  </a-modal>
</template>

<style scoped>
.filters { margin-bottom: 12px; }
</style>
