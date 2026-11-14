<script setup lang="ts">
import { message } from 'ant-design-vue'
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { api, errorText } from '../api/client'
import type { ManagedUser } from '../api/types'
import { useInstancesStore } from '../stores/instances'

const store = useInstancesStore()
const { t } = useI18n()
const users = ref<ManagedUser[]>([])
const loading = ref(false)
const tab = ref<'user' | 'device'>('user')

/** Only role `user` needs grants; admins see every device. */
const grantable = computed(() => users.value.filter((u) => u.role === 'user'))
const userLabel = (u: ManagedUser) => (u.displayName ? t('permissions.userLabel', { display: u.displayName, username: u.username }) : u.username)

async function load() {
  loading.value = true
  try { users.value = (await api<{ users: ManagedUser[] }>('GET', '/api/users')).users }
  catch (e) { message.error(errorText(e)) }
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
    message.success(t('permissions.saved'))
    await load()
  } catch (e) { message.error(errorText(e)) }
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
    message.success(t('permissions.saved'))
    await load()
  } catch (e) { message.error(errorText(e)) }
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
  <a-card :title="t('permissions.title')" size="small">
    <template #extra><a-button size="small" :loading="loading" @click="load(); store.refresh()">{{ t('common.refresh') }}</a-button></template>
    <a-alert
      type="info" show-icon style="margin-bottom: 12px"
      :message="t('permissions.info')"
    />
    <a-tabs v-model:active-key="tab">
      <a-tab-pane key="user" :tab="t('permissions.byUser')">
        <a-row :gutter="[16, 16]">
          <a-col :xs="24" :md="8">
            <a-input-search v-model:value="search" :placeholder="t('permissions.searchUser')" allow-clear style="margin-bottom: 8px" />
            <a-spin :spinning="loading">
              <a-empty v-if="!filteredUsers.length" :description="t('permissions.noUsers')" />
              <div class="user-list">
                <div
                  v-for="u in filteredUsers" :key="u.id" class="user-item" :class="{ active: u.id === selectedUserId }"
                  role="button" tabindex="0" @click="selectUser(u)" @keydown.enter="selectUser(u)"
                >
                  <div class="user-name">
                    {{ userLabel(u) }}
                    <a-tag v-if="u.disabled" color="red" style="margin-left: 4px">{{ t('permissions.disabled') }}</a-tag>
                  </div>
                  <div class="hint">{{ t('permissions.grantedCount', { n: u.instanceIds.length }) }}</div>
                </div>
              </div>
            </a-spin>
          </a-col>
          <a-col :xs="24" :md="16">
            <a-empty v-if="!selectedUser" :description="t('permissions.pickUser')" />
            <template v-else>
              <div class="editor-head">
                <i18n-t keypath="permissions.grantFor" tag="span"><template #name><b>{{ userLabel(selectedUser) }}</b></template></i18n-t>
                <a-button type="primary" size="small" :loading="savingUser" :disabled="!userDirty" @click="saveUserGrants">{{ t('common.save') }}</a-button>
              </div>
              <a-transfer
                v-model:target-keys="targetKeys"
                :data-source="deviceItems"
                :titles="[t('permissions.available'), t('permissions.granted')]"
                :render="(item: any) => item.title"
                :list-style="{ width: '100%', height: '360px' }"
                :locale="{ itemUnit: t('permissions.unit'), itemsUnit: t('permissions.unit'), searchPlaceholder: t('permissions.searchDevice'), notFoundContent: t('common.none') }"
                show-search
                class="transfer"
              />
            </template>
          </a-col>
        </a-row>
      </a-tab-pane>

      <a-tab-pane key="device" :tab="t('permissions.byDevice')">
        <a-form layout="vertical" style="max-width: 640px">
          <a-form-item :label="t('common.device')">
            <a-select
              v-model:value="selectedDeviceId" show-search :placeholder="t('permissions.pickDevice')" option-filter-prop="label"
              :options="store.list.map((i) => ({ value: i.id, label: i.name }))"
            />
          </a-form-item>
          <a-form-item v-if="selectedDeviceId" :label="t('permissions.usersOfDevice')">
            <a-select
              v-model:value="deviceUserIds" mode="multiple" show-search option-filter-prop="label" :placeholder="t('permissions.pickUsers')"
              :options="grantable.map((u) => ({ value: u.id, label: userLabel(u) }))"
            />
          </a-form-item>
          <a-button v-if="selectedDeviceId" type="primary" :loading="savingDevice" :disabled="!deviceDirty" @click="saveDeviceGrants">{{ t('common.save') }}</a-button>
        </a-form>
      </a-tab-pane>
    </a-tabs>
  </a-card>
</template>

<style scoped>
.user-list { max-height: 420px; overflow-y: auto; border: 1px solid var(--cp-border-secondary); border-radius: 6px; }
.user-item { padding: 8px 12px; cursor: pointer; border-bottom: 1px solid var(--cp-border-secondary); }
.user-item:last-child { border-bottom: none; }
.user-item:hover { background: var(--cp-bg-hover); }
.user-item.active { background: var(--cp-primary-bg); }
.user-name { font-weight: 500; }
.hint { color: var(--cp-text-tertiary); font-size: 12px; }
.editor-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; gap: 8px; }
.transfer :deep(.ant-transfer-list) { flex: 1; min-width: 0; }
</style>
