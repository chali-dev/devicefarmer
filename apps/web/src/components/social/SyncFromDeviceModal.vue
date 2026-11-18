<script setup lang="ts">
/**
 * 从云手机同步: pick a cloud phone the viewer may operate (admins: any, plus the account owner), queue the
 * account-device-sync task and follow it through the task events until it ends (a pace / busy deferral continues
 * as a new task, which is followed too). The result comes from the task (GET /api/tasks/:id).
 */
import { message } from 'ant-design-vue'
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { api, codeText, errorText } from '../../api/client'
import type { ManagedUser, Task } from '../../api/types'
import { dateLocale } from '../../i18n'
import { useAuthStore } from '../../stores/auth'
import { useInstancesStore } from '../../stores/instances'

const props = defineProps<{ open: boolean; users: ManagedUser[]; instanceId?: string }>()
const emit = defineEmits<{ 'update:open': [boolean]; synced: [accountId: string] }>()
const { t, te } = useI18n()
const auth = useAuthStore()
const store = useInstancesStore()

const deviceId = ref<string | undefined>()
const ownerId = ref<string | undefined>()
const busy = ref(false)
const taskId = ref<string | null>(null)
type SyncTaskResult = {
  outcome?: string; result?: string; code?: string; runAt?: string; taskId?: string; accountId?: string; handle?: string; displayName?: string | null
  counts?: { followers: number | null; following: number | null; posts: number | null; approx: string[] }; linkedElsewhere?: boolean
}
const state = ref<{ phase: 'idle' | 'queued' | 'running' | 'deferred' | 'done' | 'failed'; result?: SyncTaskResult; error?: string }>({ phase: 'idle' })

const devices = computed(() => store.list.map((i) => ({ value: i.id, label: `${i.name}${i.status !== 'running' ? ` (${t(`status.${i.status}`)})` : ''}` })))
watch(() => props.open, (o) => {
  if (!o) return
  deviceId.value = props.instanceId ?? (store.list.length === 1 ? store.list[0]!.id : deviceId.value)
  ownerId.value = undefined
  taskId.value = null
  state.value = { phase: 'idle' }
})

async function start() {
  if (!deviceId.value) return
  busy.value = true
  try {
    const r = await api<{ task: { id: string; status: string } }>('POST', '/api/social/sync-from-device', { instanceId: deviceId.value, ...(ownerId.value ? { ownerId: ownerId.value } : {}) })
    taskId.value = r.task.id
    state.value = { phase: 'queued' }
  } catch (e) { message.error(errorText(e)) }
  finally { busy.value = false }
}

async function finished(id: string) {
  try {
    const { task } = await api<{ task: Task & { result: SyncTaskResult | null } }>('GET', `/api/tasks/${id}`)
    const res = task.result ?? {}
    if (task.status === 'failed' || task.status === 'cancelled') {
      state.value = { phase: 'failed', error: codeText(task.errorCode ?? undefined, {}, task.error ?? task.status) }
    } else if (res.outcome === 'deferred' && res.taskId) {
      taskId.value = res.taskId
      state.value = { phase: 'deferred', result: res }
    } else {
      state.value = { phase: 'done', result: res }
      if (res.accountId && (res.result === 'created' || res.result === 'updated')) emit('synced', res.accountId)
    }
  } catch (e) { state.value = { phase: 'failed', error: errorText(e) } }
}

const off = store.onTaskEvent((ev) => {
  if (ev.type !== 'task.updated' || ev.task.id !== taskId.value) return
  if (ev.task.status === 'running') state.value = { phase: 'running' }
  else if (['success', 'failed', 'cancelled'].includes(ev.task.status)) void finished(ev.task.id)
})
onBeforeUnmount(off)

const r = computed(() => state.value.result)
const resultText = computed(() => {
  const x = r.value
  if (!x) return ''
  if (x.outcome === 'skipped') return t('social.sync.skipped', { msg: codeText(x.code, {}, x.code ?? '') })
  return x.result && te(`social.sync.result.${x.result}`) ? t(`social.sync.result.${x.result}`) : x.result ?? ''
})
const resultType = computed(() => (r.value?.result === 'created' || r.value?.result === 'updated' ? 'success' : r.value?.result === 'not_logged_in' || r.value?.outcome === 'skipped' ? 'info' : 'warning'))
const num = (m: 'followers' | 'following' | 'posts') => {
  const c = r.value?.counts
  const v = c?.[m]
  if (v == null) return '—'
  return `${v.toLocaleString(dateLocale())}${c!.approx.includes(m) ? t('social.sync.approx') : ''}`
}
const deferText = computed(() => {
  const x = r.value
  return x ? t('social.sync.deferred', { msg: codeText(x.code, {}, x.code ?? ''), time: x.runAt ? new Date(x.runAt).toLocaleTimeString(dateLocale()) : '—' }) : ''
})
const waiting = computed(() => ['queued', 'running', 'deferred'].includes(state.value.phase))
const close = () => emit('update:open', false)
</script>

<template>
  <a-modal :open="open" :title="t('social.sync.title')" :footer="null" destroy-on-close @update:open="(v: boolean) => emit('update:open', v)">
    <p class="muted">{{ t('social.sync.intro') }}</p>
    <a-form layout="vertical">
      <a-form-item :label="t('social.sync.device')">
        <a-select v-model:value="deviceId" show-search option-filter-prop="label" :options="devices" :placeholder="t('social.sync.devicePlaceholder')"
          :not-found-content="t('social.sync.noDevices')" :disabled="waiting" />
      </a-form-item>
      <a-form-item v-if="auth.isAdmin" :label="t('social.sync.owner')" :extra="t('social.sync.ownerHint')">
        <a-select v-model:value="ownerId" allow-clear show-search option-filter-prop="label" :placeholder="auth.user?.username" :disabled="waiting"
          :options="users.map((u) => ({ value: u.id, label: u.username }))" />
      </a-form-item>
    </a-form>

    <a-alert v-if="state.phase === 'queued' || state.phase === 'running'" type="info" show-icon :message="t(`social.sync.${state.phase}`)">
      <template #icon><a-spin size="small" /></template>
    </a-alert>
    <a-alert v-else-if="state.phase === 'deferred'" type="info" show-icon :message="deferText" />
    <a-alert v-else-if="state.phase === 'failed'" type="error" show-icon :message="t('social.sync.failed', { msg: state.error })" />
    <a-alert v-else-if="state.phase === 'done' && r" :type="resultType" show-icon :message="resultText">
      <template #description>
        <div v-if="r.handle"><strong>@{{ r.handle }}</strong><span v-if="r.displayName"> · {{ r.displayName }}</span></div>
        <div v-if="r.counts">{{ t('social.sync.counts', { followers: num('followers'), following: num('following'), posts: num('posts') }) }}</div>
        <div v-if="r.linkedElsewhere" class="muted small">{{ t('social.sync.linkedElsewhere') }}</div>
        <router-link v-if="r.result === 'not_logged_in' && deviceId" :to="`/instances/${deviceId}`" @click="close">{{ t('social.sync.openRemote') }}</router-link>
      </template>
    </a-alert>

    <div class="footer">
      <a-button @click="close">{{ t('social.sync.close') }}</a-button>
      <a-button type="primary" :disabled="!deviceId || waiting" :loading="busy" @click="start">
        {{ state.phase === 'idle' ? t('social.sync.start') : t('social.sync.again') }}
      </a-button>
    </div>
  </a-modal>
</template>

<style scoped>
.footer { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; }
</style>
