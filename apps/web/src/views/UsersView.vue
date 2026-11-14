<script setup lang="ts">
import { message, Modal } from 'ant-design-vue'
import { computed, onMounted, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { api, errorText } from '../api/client'
import { ROLES, roleText, type ManagedUser, type Role } from '../api/types'
import { useAuthStore } from '../stores/auth'

const auth = useAuthStore()
const users = ref<ManagedUser[]>([])
const loading = ref(false)

const { t } = useI18n()

const roleHelp = (r: Role) => (r === 'admin' ? t('users.roleHelpAdmin') : t('users.roleHelpUser'))
const builtinTip = () => t('users.builtinTip')

async function load() {
  loading.value = true
  try { users.value = (await api<{ users: ManagedUser[] }>('GET', '/api/users')).users }
  catch (e) { message.error(errorText(e)) }
  finally { loading.value = false }
}
onMounted(load)

const columns = computed(() => [
  { title: t('common.username'), key: 'username' },
  { title: t('profile.displayName'), dataIndex: 'displayName', key: 'displayName' },
  { title: t('profile.email'), dataIndex: 'email', key: 'email' },
  { title: t('common.role'), key: 'role', width: 130 },
  { title: t('users.enabled'), key: 'enabled', width: 80 },
  { title: t('users.createdAt'), key: 'createdAt', width: 170 },
  { title: t('common.action'), key: 'ops', width: 260 },
])

/** Why the dangerous controls of a row are locked (null = editable). */
const lockReason = (u: ManagedUser) => (u.builtin ? t('users.builtinTip') : u.id === auth.user?.id ? t('users.selfTip') : null)

async function patch(u: ManagedUser, body: Partial<{ role: Role; disabled: boolean; password: string }>): Promise<boolean> {
  try { await api('PATCH', `/api/users/${u.id}`, body); message.success(t('common.saved')); return true }
  catch (e) { message.error(errorText(e)); return false }
  finally { await load() }
}

function changeRole(u: ManagedUser, role: Role) {
  if (role === u.role) return
  Modal.confirm({
    title: t('users.confirmRole', { name: u.username, role: roleText(role) }),
    content: role === 'admin' ? t('users.toAdmin') : t('users.toUser'),
    okText: t('common.ok'), cancelText: t('common.cancel'),
    onOk: () => patch(u, { role }),
  })
}

function remove(u: ManagedUser) {
  Modal.confirm({
    title: t('users.confirmDelete', { name: u.username }), content: t('users.deleteContent'), okType: 'danger', okText: t('common.delete'), cancelText: t('common.cancel'),
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
const form = reactive({ username: '', password: '', role: 'user' as Role })
async function create() {
  if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(form.username)) return message.error(t('users.badUsername'))
  if (form.password.length < 8) return message.error(t('users.initialPasswordShort'))
  creating.value = true
  try {
    await api('POST', '/api/users', form)
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
  <a-card :title="t('users.title')" size="small">
    <template #extra><a-button type="primary" @click="createOpen = true">{{ t('users.newUser') }}</a-button></template>
    <a-table :data-source="users" :columns="columns" row-key="id" :loading="loading" :pagination="false" size="middle" :scroll="{ x: 980 }">
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
          <a-tag :color="record.role === 'admin' ? 'blue' : 'default'">{{ roleText(record.role as Role) }}</a-tag>
        </template>
        <template v-else-if="column.key === 'enabled'">
          <a-tooltip :title="lockReason(record)">
            <a-switch :checked="!record.disabled" size="small" :disabled="!!lockReason(record)" @change="(v: any) => patch(record, { disabled: !v })" />
          </a-tooltip>
        </template>
        <template v-else-if="column.key === 'createdAt'">{{ new Date(record.createdAt).toLocaleString() }}</template>
        <template v-else-if="column.key === 'ops'">
          <a-space :size="4">
            <a-tooltip :title="lockReason(record)">
              <a-select
                :value="record.role" size="small" style="width: 96px" :disabled="!!lockReason(record)"
                @change="(v: any) => changeRole(record, v)"
              >
                <a-select-option v-for="r in ROLES" :key="r" :value="r">{{ roleText(r) }}</a-select-option>
              </a-select>
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

  <a-modal v-model:open="createOpen" :title="t('users.newUser')" :ok-text="t('common.create')" :cancel-text="t('common.cancel')" :confirm-loading="creating" @ok="create">
    <a-form layout="vertical">
      <a-form-item :label="t('common.username')" :extra="t('users.usernameHint')"><a-input v-model:value="form.username" autocomplete="off" /></a-form-item>
      <a-form-item :label="t('users.initialPassword')" :extra="t('users.min8')"><a-input-password v-model:value="form.password" autocomplete="new-password" /></a-form-item>
      <a-form-item :label="t('common.role')" :extra="roleHelp(form.role)">
        <a-select v-model:value="form.role">
          <a-select-option v-for="r in ROLES" :key="r" :value="r">{{ roleText(r) }}</a-select-option>
        </a-select>
      </a-form-item>
    </a-form>
    <a-typography-text type="secondary">{{ t('users.noGrantsHint') }}</a-typography-text>
  </a-modal>

  <a-modal :open="!!pwUser" :title="t('users.resetTitle', { name: pwUser?.username ?? '' })" :ok-text="t('common.save')" :cancel-text="t('common.cancel')" @ok="savePw" @cancel="pwUser = null">
    <a-input-password v-model:value="newPw" :placeholder="t('users.newPasswordPlaceholder')" autocomplete="new-password" />
  </a-modal>
</template>
