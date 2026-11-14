<script setup lang="ts">
import { message, Modal } from 'ant-design-vue'
import { onMounted, reactive, ref } from 'vue'
import { api } from '../api/client'
import type { ManagedUser, Role } from '../api/types'
import { useAuthStore } from '../stores/auth'
import { useInstancesStore } from '../stores/instances'

const auth = useAuthStore()
const store = useInstancesStore()
const users = ref<ManagedUser[]>([])
const loading = ref(false)

const ROLE_TEXT: Record<Role, string> = { admin: '管理员', operator: '运维', viewer: '只读/控制' }
const ROLE_HELP: Record<Role, string> = {
  admin: '全部实例与用户管理',
  operator: '创建实例；对授权实例启停、安装 APK、远程控制',
  viewer: '对授权实例查看与远程控制',
}

async function load() {
  loading.value = true
  try { users.value = (await api<{ users: ManagedUser[] }>('GET', '/api/users')).users }
  catch (e) { message.error((e as Error).message) }
  finally { loading.value = false }
}
onMounted(load)

const columns = [
  { title: '用户名', dataIndex: 'username', key: 'username' },
  { title: '角色', key: 'role', width: 160 },
  { title: '可访问实例', key: 'grants' },
  { title: '启用', key: 'enabled', width: 80 },
  { title: '', key: 'ops', width: 170, align: 'right' as const },
]

async function patch(u: ManagedUser, body: Partial<{ role: Role; disabled: boolean; password: string }>) {
  try { await api('PATCH', `/api/users/${u.id}`, body); message.success('已保存'); await load() }
  catch (e) { message.error((e as Error).message) }
}

function remove(u: ManagedUser) {
  Modal.confirm({
    title: `删除用户 ${u.username}？`, okType: 'danger', okText: '删除',
    onOk: async () => {
      try { await api('DELETE', `/api/users/${u.id}`); message.success('已删除'); await load() }
      catch (e) { message.error((e as Error).message) }
    },
  })
}

// create
const createOpen = ref(false)
const form = reactive({ username: '', password: '', role: 'viewer' as Role })
async function create() {
  try {
    await api('POST', '/api/users', form)
    message.success('已创建')
    createOpen.value = false
    Object.assign(form, { username: '', password: '', role: 'viewer' })
    await load()
  } catch (e) { message.error((e as Error).message) }
}

// grants
const grantUser = ref<ManagedUser | null>(null)
const grantIds = ref<string[]>([])
function openGrants(u: ManagedUser) { grantUser.value = u; grantIds.value = [...u.instanceIds] }
async function saveGrants() {
  if (!grantUser.value) return
  try {
    await api('PUT', `/api/users/${grantUser.value.id}/grants`, { instanceIds: grantIds.value })
    message.success('授权已更新')
    grantUser.value = null
    await load()
  } catch (e) { message.error((e as Error).message) }
}

// password reset
const pwUser = ref<ManagedUser | null>(null)
const newPw = ref('')
async function savePw() {
  if (!pwUser.value) return
  await patch(pwUser.value, { password: newPw.value })
  pwUser.value = null
  newPw.value = ''
}

const nameOf = (id: string) => store.byId.get(id)?.name ?? id.slice(0, 8)
</script>

<template>
  <a-card title="用户与权限" size="small">
    <template #extra><a-button type="primary" @click="createOpen = true">新建用户</a-button></template>
    <a-table :data-source="users" :columns="columns" row-key="id" :loading="loading" :pagination="false" size="middle" :scroll="{ x: 720 }">
      <template #bodyCell="{ column, record }">
        <template v-if="column.key === 'role'">
          <a-select
            :value="record.role"
            size="small"
            style="width: 130px"
            :disabled="record.id === auth.user?.id"
            @change="(v: any) => patch(record, { role: v })"
          >
            <a-select-option v-for="(t, k) in ROLE_TEXT" :key="k" :value="k">{{ t }}</a-select-option>
          </a-select>
        </template>
        <template v-else-if="column.key === 'grants'">
          <span v-if="record.role === 'admin'" style="color: #8c8c8c">全部</span>
          <template v-else>
            <a-tag v-for="id in record.instanceIds.slice(0, 6)" :key="id">{{ nameOf(id) }}</a-tag>
            <span v-if="record.instanceIds.length > 6">+{{ record.instanceIds.length - 6 }}</span>
            <span v-if="!record.instanceIds.length" style="color: #bfbfbf">无</span>
          </template>
        </template>
        <template v-else-if="column.key === 'enabled'">
          <a-switch :checked="!record.disabled" size="small" :disabled="record.id === auth.user?.id" @change="(v: any) => patch(record, { disabled: !v })" />
        </template>
        <template v-else-if="column.key === 'ops'">
          <a-space :size="0">
            <a-button v-if="record.role !== 'admin'" type="link" size="small" @click="openGrants(record)">授权</a-button>
            <a-button type="link" size="small" @click="pwUser = record">重置密码</a-button>
            <a-button v-if="record.id !== auth.user?.id" type="link" size="small" danger @click="remove(record)">删除</a-button>
          </a-space>
        </template>
      </template>
    </a-table>
  </a-card>

  <a-modal v-model:open="createOpen" title="新建用户" ok-text="创建" @ok="create">
    <a-form layout="vertical">
      <a-form-item label="用户名" extra="3–32 位字母、数字、下划线、点或短横线"><a-input v-model:value="form.username" autocomplete="off" /></a-form-item>
      <a-form-item label="初始密码" extra="至少 8 位"><a-input-password v-model:value="form.password" autocomplete="new-password" /></a-form-item>
      <a-form-item label="角色" :extra="ROLE_HELP[form.role]">
        <a-select v-model:value="form.role">
          <a-select-option v-for="(t, k) in ROLE_TEXT" :key="k" :value="k">{{ t }}</a-select-option>
        </a-select>
      </a-form-item>
    </a-form>
  </a-modal>

  <a-modal :open="!!grantUser" :title="`授权实例 · ${grantUser?.username}`" ok-text="保存" @ok="saveGrants" @cancel="grantUser = null">
    <a-select v-model:value="grantIds" mode="multiple" style="width: 100%" placeholder="选择可访问的实例" :options="store.list.map((i) => ({ value: i.id, label: i.name }))" />
  </a-modal>

  <a-modal :open="!!pwUser" :title="`重置密码 · ${pwUser?.username}`" ok-text="保存" @ok="savePw" @cancel="pwUser = null">
    <a-input-password v-model:value="newPw" placeholder="新密码（至少 8 位）" autocomplete="new-password" />
  </a-modal>
</template>
