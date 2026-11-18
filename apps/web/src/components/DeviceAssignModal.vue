<script setup lang="ts">
import { message } from 'ant-design-vue'
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { api, errorText } from '../api/client'
import type { ManagedUser } from '../api/types'
import { MODAL_WIDTH } from './common/ui'
import { useInstancesStore } from '../stores/instances'

/**
 * 分配 (admin, 我的云机; moved from the former 权限管理 page, 2026-11-18): which users (role `user`) may use devices.
 * `set` = one device, its granted users preselected, saving replaces them (PUT /api/instances/:id/grants);
 * `add` / `remove` = the selected devices, the picked users are added to / removed from each device's current grants
 * (same endpoint per device, only devices whose set changes). Admins see every device and are listed only for
 * reference (disabled). The device list is reloaded afterwards, so the cards' 已分配用户 follow.
 */
const props = defineProps<{ open: boolean; mode: 'set' | 'add' | 'remove'; instanceIds: string[] }>()
const emit = defineEmits<{ 'update:open': [boolean] }>()
const { t } = useI18n()
const store = useInstancesStore()

const users = ref<ManagedUser[]>([])
const picked = ref<string[]>([])
const loading = ref(false)
const saving = ref(false)
const ownersOf = (id: string) => (store.byId.get(id)?.owners ?? []).map((o) => o.id)
const userLabel = (u: ManagedUser) => (u.displayName ? t('permissions.userLabel', { display: u.displayName, username: u.username }) : u.username)
const options = computed(() => users.value.map((u) => ({
  value: u.id, disabled: u.role !== 'user',
  label: `${userLabel(u)} · ${t(`roles.${u.role}`)}${u.disabled ? ` · ${t('permissions.disabled')}` : ''}`,
})))
const names = computed(() => props.instanceIds.map((id) => store.byId.get(id)?.name ?? id.slice(0, 8)).join(t('common.listSep')))

watch(() => props.open, async (o) => {
  if (!o) return
  picked.value = props.mode === 'set' && props.instanceIds[0] ? ownersOf(props.instanceIds[0]) : []
  loading.value = true
  try { users.value = (await api<{ users: ManagedUser[] }>('GET', '/api/users')).users } catch (e) { message.error(errorText(e)) }
  finally { loading.value = false }
})

async function save() {
  saving.value = true
  let changed = 0
  const failed: string[] = []
  try {
    for (const id of props.instanceIds) {
      const cur = ownersOf(id)
      const next = props.mode === 'set' ? picked.value
        : props.mode === 'add' ? [...new Set([...cur, ...picked.value])] : cur.filter((u) => !picked.value.includes(u))
      if (next.length === cur.length && next.every((u) => cur.includes(u))) continue
      try { await api('PUT', `/api/instances/${id}/grants`, { userIds: next }); changed++ }
      catch (e) { failed.push(`${store.byId.get(id)?.name ?? id}: ${errorText(e)}`) }
    }
    await store.refresh()
    if (failed.length) message.error(failed.join('；'))
    else message.success(props.mode === 'set' ? t('permissions.saved') : t('permissions.batchDone', { n: changed }))
    if (!failed.length) emit('update:open', false)
  } finally { saving.value = false }
}
const title = computed(() => (props.mode === 'set' ? t('permissions.assignTitle', { name: names.value })
  : t(props.mode === 'add' ? 'permissions.addTitle' : 'permissions.removeTitle', { n: props.instanceIds.length })))
</script>

<template>
  <a-modal :open="open" :title="title" :width="MODAL_WIDTH.md" :confirm-loading="saving" :ok-text="t('common.save')" :cancel-text="t('common.cancel')"
    :ok-button-props="{ disabled: mode !== 'set' && !picked.length }" @ok="save" @cancel="emit('update:open', false)">
    <p v-if="mode !== 'set'" class="muted small">{{ names }}</p>
    <a-select v-model:value="picked" mode="multiple" show-search option-filter-prop="label" :loading="loading" style="width: 100%"
      :placeholder="mode === 'set' ? t('permissions.pickUsers') : t('permissions.pickUsersBatch')" :options="options" />
    <div class="muted small hint">{{ t('permissions.info') }}</div>
  </a-modal>
</template>

<style scoped>
.hint { margin-top: 8px; }
</style>
