<script setup lang="ts">
import { message } from 'ant-design-vue'
import { computed, onMounted, ref, watch } from 'vue'
import { api } from '../api/client'
import type { ManagedUser } from '../api/types'
import { useInstancesStore } from '../stores/instances'

const store = useInstancesStore()
const users = ref<ManagedUser[]>([])
const loading = ref(false)
const tab = ref<'user' | 'device'>('user')

/** Only role `user` needs grants; admins see every device. */
const grantable = computed(() => users.value.filter((u) => u.role === 'user'))
const userLabel = (u: ManagedUser) => (u.displayName ? `${u.displayName}（${u.username}）` : u.username)

async function load() {
  loading.value = true
  try { users.value = (await api<{ users: ManagedUser[] }>('GET', '/api/users')).users }
  catch (e) { message.error((e as Error).message) }
  finally { loading.value = false }
}
onMounted(() => { void load(); void store.refresh() })

// ---- 按用户
const search = ref('')
const selectedUserId = ref<string | null>(null)
const targetKeys = ref<string[]>([])
const savingUser = ref(false)
const filteredUsers = computed(() => {
  const q = search.value.trim().toLowerCase()
  return grantable.value.filter((u) => !q || u.username.toLowerCase().includes(q) || (u.displayName ?? '').toLowerCase().includes(q))
})
const selectedUser = computed(() => grantable.value.find((u) => u.id === selectedUserId.value) ?? null)
const deviceItems = computed(() => store.list.map((i) => ({ key: i.id, title: i.name })))
const userDirty = computed(() => !!selectedUser.value && !sameSet(selectedUser.value.instanceIds, targetKeys.value))

function selectUser(u: ManagedUser) {
  selectedUserId.value = u.id
  targetKeys.value = [...u.instanceIds]
}
async function saveUserGrants() {
  if (!selectedUser.value) return
  savingUser.value = true
  try {
    await api('PUT', `/api/users/${selectedUser.value.id}/grants`, { instanceIds: targetKeys.value })
    message.success('授权已保存')
    await load()
  } catch (e) { message.error((e as Error).message) }
  finally { savingUser.value = false }
}

// ---- 按设备
const selectedDeviceId = ref<string | null>(null)
const deviceUserIds = ref<string[]>([])
const savingDevice = ref(false)
const grantedUserIds = (instanceId: string) => grantable.value.filter((u) => u.instanceIds.includes(instanceId)).map((u) => u.id)
const deviceDirty = computed(() => !!selectedDeviceId.value && !sameSet(grantedUserIds(selectedDeviceId.value), deviceUserIds.value))

watch(selectedDeviceId, (id) => { deviceUserIds.value = id ? grantedUserIds(id) : [] })
async function saveDeviceGrants() {
  if (!selectedDeviceId.value) return
  savingDevice.value = true
  try {
    await api('PUT', `/api/instances/${selectedDeviceId.value}/grants`, { userIds: deviceUserIds.value })
    message.success('授权已保存')
    await load()
  } catch (e) { message.error((e as Error).message) }
  finally { savingDevice.value = false }
}

function sameSet(a: string[], b: string[]) {
  return a.length === b.length && a.every((x) => b.includes(x))
}

// Keep the editors in sync after a reload (other tab's save, refresh).
watch(users, () => {
  if (selectedUser.value) targetKeys.value = [...selectedUser.value.instanceIds]
  else selectedUserId.value = null
  if (selectedDeviceId.value) deviceUserIds.value = grantedUserIds(selectedDeviceId.value)
})
</script>

<template>
  <a-card title="权限管理" size="small">
    <template #extra><a-button size="small" :loading="loading" @click="load(); store.refresh()">刷新</a-button></template>
    <a-alert
      type="info" show-icon style="margin-bottom: 12px"
      message="管理员可访问全部设备，无需授权；这里只列出角色为「用户」的账号。用户只能看到并操作被授权的设备。"
    />
    <a-tabs v-model:active-key="tab">
      <a-tab-pane key="user" tab="按用户">
        <a-row :gutter="[16, 16]">
          <a-col :xs="24" :md="8">
            <a-input-search v-model:value="search" placeholder="搜索用户名或显示名称" allow-clear style="margin-bottom: 8px" />
            <a-spin :spinning="loading">
              <a-empty v-if="!filteredUsers.length" description="没有角色为「用户」的账号" />
              <div class="user-list">
                <div
                  v-for="u in filteredUsers" :key="u.id" class="user-item" :class="{ active: u.id === selectedUserId }"
                  role="button" tabindex="0" @click="selectUser(u)" @keydown.enter="selectUser(u)"
                >
                  <div class="user-name">
                    {{ userLabel(u) }}
                    <a-tag v-if="u.disabled" color="red" style="margin-left: 4px">已禁用</a-tag>
                  </div>
                  <div class="hint">已授权 {{ u.instanceIds.length }} 台设备</div>
                </div>
              </div>
            </a-spin>
          </a-col>
          <a-col :xs="24" :md="16">
            <a-empty v-if="!selectedUser" description="请在左侧选择用户" />
            <template v-else>
              <div class="editor-head">
                <span>为 <b>{{ userLabel(selectedUser) }}</b> 授权设备</span>
                <a-button type="primary" size="small" :loading="savingUser" :disabled="!userDirty" @click="saveUserGrants">保存</a-button>
              </div>
              <a-transfer
                v-model:target-keys="targetKeys"
                :data-source="deviceItems"
                :titles="['可分配设备', '已授权设备']"
                :render="(item: any) => item.title"
                :list-style="{ width: '100%', height: '360px' }"
                :locale="{ itemUnit: '台', itemsUnit: '台', searchPlaceholder: '搜索设备', notFoundContent: '无' }"
                show-search
                class="transfer"
              />
            </template>
          </a-col>
        </a-row>
      </a-tab-pane>

      <a-tab-pane key="device" tab="按设备">
        <a-form layout="vertical" style="max-width: 640px">
          <a-form-item label="设备">
            <a-select
              v-model:value="selectedDeviceId" show-search placeholder="选择设备" option-filter-prop="label"
              :options="store.list.map((i) => ({ value: i.id, label: i.name }))"
            />
          </a-form-item>
          <a-form-item v-if="selectedDeviceId" label="可访问该设备的用户">
            <a-select
              v-model:value="deviceUserIds" mode="multiple" show-search option-filter-prop="label" placeholder="选择用户（为空表示仅管理员可访问）"
              :options="grantable.map((u) => ({ value: u.id, label: userLabel(u) }))"
            />
          </a-form-item>
          <a-button v-if="selectedDeviceId" type="primary" :loading="savingDevice" :disabled="!deviceDirty" @click="saveDeviceGrants">保存</a-button>
        </a-form>
      </a-tab-pane>
    </a-tabs>
  </a-card>
</template>

<style scoped>
.user-list { max-height: 420px; overflow-y: auto; border: 1px solid #f0f0f0; border-radius: 6px; }
.user-item { padding: 8px 12px; cursor: pointer; border-bottom: 1px solid #f0f0f0; }
.user-item:last-child { border-bottom: none; }
.user-item:hover { background: #fafafa; }
.user-item.active { background: #e6f4ff; }
.user-name { font-weight: 500; }
.hint { color: #8c8c8c; font-size: 12px; }
.editor-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; gap: 8px; }
.transfer :deep(.ant-transfer-list) { flex: 1; min-width: 0; }
</style>
