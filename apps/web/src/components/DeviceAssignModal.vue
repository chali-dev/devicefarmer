<script setup lang="ts">
import { message } from 'ant-design-vue'
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { api, errorText } from '../api/client'
import type { ManagedUser } from '../api/types'
import { MODAL_WIDTH } from './common/ui'
import { useInstancesStore } from '../stores/instances'

/**
 * 分配 (admin, 我的云机): a cloud phone belongs to exactly one user or none (owner decision 2026-11-18).
 * `set` = one device, single select (clear = unassign); `assign` = the selected devices all get the picked user
 * (replacing); `clear` = the selected devices are unassigned (confirmation only). Saving = PUT /api/instances/:id/grants
 * {userIds: [id] | []} per device whose assignment changes; the API moves the device's linked social accounts to the
 * new user (or refuses with instances.assign_account_busy). Older data may have several users on one device: the
 * modal says so and keeps only the picked one. Admins and disabled users are listed but not selectable.
 */
const props = defineProps<{ open: boolean; mode: 'set' | 'assign' | 'clear'; instanceIds: string[] }>()
const emit = defineEmits<{ 'update:open': [boolean] }>()
const { t } = useI18n()
const store = useInstancesStore()

const users = ref<ManagedUser[]>([])
const picked = ref<string | undefined>()
const loading = ref(false)
const saving = ref(false)
const ownersOf = (id: string) => store.byId.get(id)?.owners ?? []
const userLabel = (u: { username: string; displayName?: string | null }) => (u.displayName ? t('permissions.userLabel', { display: u.displayName, username: u.username }) : u.username)
const options = computed(() => users.value.map((u) => ({
  value: u.id, disabled: u.role !== 'user' || u.disabled,
  label: `${userLabel(u)} · ${t(`roles.${u.role}`)}${u.disabled ? ` · ${t('permissions.disabled')}` : ''}`,
})))
const names = computed(() => props.instanceIds.map((id) => store.byId.get(id)?.name ?? id.slice(0, 8)).join(t('common.listSep')))
/** One device with several users (legacy data): their names for the warning. */
const multiNames = computed(() => {
  if (props.mode !== 'set' || !props.instanceIds[0]) return ''
  const o = ownersOf(props.instanceIds[0])
  return o.length > 1 ? o.map(userLabel).join(t('common.listSep')) : ''
})
const multiCount = computed(() => (props.mode === 'assign' ? props.instanceIds.filter((id) => ownersOf(id).length > 1).length : 0))

watch(() => props.open, async (o) => {
  if (!o) return
  // Legacy multi-user device: the first user is preselected and the warning says the others lose access on save.
  picked.value = props.mode === 'set' && props.instanceIds[0] ? ownersOf(props.instanceIds[0])[0]?.id : undefined
  if (props.mode === 'clear') return
  loading.value = true
  try { users.value = (await api<{ users: ManagedUser[] }>('GET', '/api/users')).users } catch (e) { message.error(errorText(e)) }
  finally { loading.value = false }
})

async function save() {
  saving.value = true
  let changed = 0
  let moved = 0
  const failed: string[] = []
  try {
    const next = props.mode === 'clear' ? [] : picked.value ? [picked.value] : []
    for (const id of props.instanceIds) {
      const cur = ownersOf(id).map((o) => o.id)
      if (cur.length === next.length && next.every((u) => cur.includes(u))) continue
      try {
        const r = await api<{ movedAccounts?: { id: string }[] }>('PUT', `/api/instances/${id}/grants`, { userIds: next })
        changed++
        moved += r.movedAccounts?.length ?? 0
      } catch (e) { failed.push(`${store.byId.get(id)?.name ?? id}: ${errorText(e)}`) }
    }
    await store.refresh()
    if (failed.length) message.error(failed.join('；'))
    else {
      message.success(props.mode === 'set' ? t('permissions.saved') : t('permissions.batchDone', { n: changed }))
      if (moved) message.info(t('permissions.movedAccounts', { n: moved }))
      emit('update:open', false)
    }
  } finally { saving.value = false }
}
const title = computed(() => (props.mode === 'set' ? t('permissions.assignTitle', { name: names.value })
  : t(props.mode === 'assign' ? 'permissions.batchAssignTitle' : 'permissions.unassignTitle', { n: props.instanceIds.length })))
</script>

<template>
  <a-modal :open="open" :title="title" :width="MODAL_WIDTH.md" :confirm-loading="saving" :ok-text="mode === 'clear' ? t('permissions.unassignSelected') : t('common.save')"
    :cancel-text="t('common.cancel')" :ok-button-props="{ disabled: mode === 'assign' && !picked, danger: mode === 'clear' }" @ok="save" @cancel="emit('update:open', false)">
    <p v-if="mode !== 'set'" class="muted small">{{ names }}</p>
    <template v-if="mode === 'clear'">
      <p>{{ t('permissions.unassignConfirm') }}</p>
    </template>
    <template v-else>
      <a-alert v-if="multiNames" class="warn" type="warning" show-icon :message="t('permissions.multiWarn', { names: multiNames })" />
      <a-alert v-else-if="multiCount" class="warn" type="warning" show-icon :message="t('permissions.batchMultiWarn', { n: multiCount })" />
      <a-select v-model:value="picked" show-search allow-clear option-filter-prop="label" :loading="loading" style="width: 100%"
        :placeholder="mode === 'set' ? t('permissions.pickUser') : t('permissions.pickUserBatch')" :options="options" />
      <div class="muted small hint">{{ t('permissions.info') }}</div>
      <div class="muted small hint">{{ t('permissions.moveHint') }}</div>
    </template>
  </a-modal>
</template>

<style scoped>
.hint { margin-top: 8px; }
.warn { margin-bottom: 12px; }
</style>
