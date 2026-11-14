<script setup lang="ts">
import { message, Modal } from 'ant-design-vue'
import { onMounted, reactive, ref } from 'vue'
import { api } from '../api/client'
import { ROLE_TEXT, type ManagedUser, type Role } from '../api/types'
import { useAuthStore } from '../stores/auth'

const auth = useAuthStore()
const users = ref<ManagedUser[]>([])
const loading = ref(false)

const ROLE_HELP: Record<Role, string> = {
  admin: '全部设备；创建/删除设备、用户与权限管理、存储设置、删除应用库/素材库条目',
  user: '仅被授权的设备：远程控制、启停、安装应用、代理与设备设置、推送素材等',
}
const BUILTIN_TIP = '内置管理员不可删除、禁用或修改角色，密码只能由其本人修改'
const SELF_TIP = '不能降级、禁用或删除自己'

async function load() {
  loading.value = true
  try { users.value = (await api<{ users: ManagedUser[] }>('GET', '/api/users')).users }
  catch (e) { message.error((e as Error).message) }
  finally { loading.value = false }
}
onMounted(load)

const columns = [
  { title: '用户名', key: 'username' },
  { title: '显示名称', dataIndex: 'displayName', key: 'displayName' },
  { title: '邮箱', dataIndex: 'email', key: 'email' },
  { title: '角色', key: 'role', width: 130 },
  { title: '启用', key: 'enabled', width: 80 },
  { title: '创建时间', key: 'createdAt', width: 170 },
  { title: '操作', key: 'ops', width: 260 },
]

/** Why the dangerous controls of a row are locked (null = editable). */
const lockReason = (u: ManagedUser) => (u.builtin ? BUILTIN_TIP : u.id === auth.user?.id ? SELF_TIP : null)

async function patch(u: ManagedUser, body: Partial<{ role: Role; disabled: boolean; password: string }>): Promise<boolean> {
  try { await api('PATCH', `/api/users/${u.id}`, body); message.success('已保存'); return true }
  catch (e) { message.error((e as Error).message); return false }
  finally { await load() }
}

function changeRole(u: ManagedUser, role: Role) {
  if (role === u.role) return
  Modal.confirm({
    title: `将 ${u.username} 的角色改为「${ROLE_TEXT[role]}」？`,
    content: role === 'admin' ? '管理员可访问全部设备并管理用户。' : '降级后只能访问已授权的设备。',
    okText: '确定', cancelText: '取消',
    onOk: () => patch(u, { role }),
  })
}

function remove(u: ManagedUser) {
  Modal.confirm({
    title: `删除用户 ${u.username}？`, content: '其设备授权将一并删除，无法恢复。', okType: 'danger', okText: '删除', cancelText: '取消',
    onOk: async () => {
      try { await api('DELETE', `/api/users/${u.id}`); message.success('已删除') }
      catch (e) { message.error((e as Error).message) }
      finally { await load() }
    },
  })
}

// create
const createOpen = ref(false)
const creating = ref(false)
const form = reactive({ username: '', password: '', role: 'user' as Role })
async function create() {
  if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(form.username)) return message.error('用户名需为 3–32 位字母、数字、下划线、点或短横线')
  if (form.password.length < 8) return message.error('初始密码至少 8 位')
  creating.value = true
  try {
    await api('POST', '/api/users', form)
    message.success('已创建')
    createOpen.value = false
    Object.assign(form, { username: '', password: '', role: 'user' })
    await load()
  } catch (e) { message.error((e as Error).message) }
  finally { creating.value = false }
}

// password reset
const pwUser = ref<ManagedUser | null>(null)
const newPw = ref('')
async function savePw() {
  if (!pwUser.value) return
  if (newPw.value.length < 8) return message.error('新密码至少 8 位')
  if (await patch(pwUser.value, { password: newPw.value })) {
    pwUser.value = null
    newPw.value = ''
  }
}
</script>

<template>
  <a-card title="用户管理" size="small">
    <template #extra><a-button type="primary" @click="createOpen = true">新建用户</a-button></template>
    <a-table :data-source="users" :columns="columns" row-key="id" :loading="loading" :pagination="false" size="middle" :scroll="{ x: 980 }">
      <template #bodyCell="{ column, record }">
        <template v-if="column.key === 'username'">
          <a-space :size="4">
            <span>{{ record.username }}</span>
            <a-tag v-if="record.builtin" color="gold">内置</a-tag>
            <a-tag v-if="record.id === auth.user?.id">我</a-tag>
          </a-space>
        </template>
        <template v-else-if="column.key === 'displayName' || column.key === 'email'">
          {{ record[column.key] || '—' }}
        </template>
        <template v-else-if="column.key === 'role'">
          <a-tag :color="record.role === 'admin' ? 'blue' : 'default'">{{ ROLE_TEXT[record.role as Role] }}</a-tag>
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
                <a-select-option v-for="(t, k) in ROLE_TEXT" :key="k" :value="k">{{ t }}</a-select-option>
              </a-select>
            </a-tooltip>
            <a-tooltip :title="record.builtin ? BUILTIN_TIP : null">
              <a-button type="link" size="small" :disabled="record.builtin" @click="pwUser = record; newPw = ''">重置密码</a-button>
            </a-tooltip>
            <a-tooltip :title="lockReason(record)">
              <a-button type="link" size="small" danger :disabled="!!lockReason(record)" @click="remove(record)">删除</a-button>
            </a-tooltip>
          </a-space>
        </template>
      </template>
    </a-table>
  </a-card>

  <a-modal v-model:open="createOpen" title="新建用户" ok-text="创建" cancel-text="取消" :confirm-loading="creating" @ok="create">
    <a-form layout="vertical">
      <a-form-item label="用户名" extra="3–32 位字母、数字、下划线、点或短横线"><a-input v-model:value="form.username" autocomplete="off" /></a-form-item>
      <a-form-item label="初始密码" extra="至少 8 位"><a-input-password v-model:value="form.password" autocomplete="new-password" /></a-form-item>
      <a-form-item label="角色" :extra="ROLE_HELP[form.role]">
        <a-select v-model:value="form.role">
          <a-select-option v-for="(t, k) in ROLE_TEXT" :key="k" :value="k">{{ t }}</a-select-option>
        </a-select>
      </a-form-item>
    </a-form>
    <a-typography-text type="secondary">新用户默认无设备权限，请在「权限管理」中授权设备。</a-typography-text>
  </a-modal>

  <a-modal :open="!!pwUser" :title="`重置密码 · ${pwUser?.username}`" ok-text="保存" cancel-text="取消" @ok="savePw" @cancel="pwUser = null">
    <a-input-password v-model:value="newPw" placeholder="新密码（至少 8 位）" autocomplete="new-password" />
  </a-modal>
</template>
