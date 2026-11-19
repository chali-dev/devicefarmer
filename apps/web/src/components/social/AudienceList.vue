<script setup lang="ts">
import { ExportOutlined, InfoCircleOutlined, LockOutlined, SyncOutlined } from '@ant-design/icons-vue'
import { message } from 'ant-design-vue'
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { api, codeText, errorText } from '../../api/client'
import { compactNumber, type AccountFollowing, type FollowingEntry, type Task } from '../../api/types'
import { dateLocale } from '../../i18n'
import { useInstancesStore } from '../../stores/instances'
import { pagination } from '../common/ui'
import InitialAvatar from './InitialAvatar.vue'

/**
 * One list of the account's 关注 / 粉丝 page (owner 2026-11-19): `following` = the accounts it follows
 * (GET …/following, search / state / paging), `followers` = its current newest ≤ 20 followers only (GET …/followers/list,
 * owner 2026-11-19 「粉丝页只列出前20笔粉丝」: one line with the account's own follower count `count`, no filters, no
 * paging, no gone rows). Every row shows the listed account's 粉丝数 / 关注数 and 不公开, read from its profile by the
 * same task (≤ 30 profiles per run, again after 7 days). Both lists are read by the same device
 * task (account-following): 同步更新 queues one (POST …/following/sync); every account-following task of this account
 * (also step 3 of the row's 同步 button and scheduled reads) is followed and reloads the list when it ends.
 * Read only: no follow / unfollow / remove, no tags or notes (owner: 「不作这功能先」「都不要」).
 */
const props = defineProps<{ accountId: string; kind: 'following' | 'followers'; /** followers: the account's own follower count (formatted) */ count?: string }>()
const emit = defineEmits<{ loaded: [data: AccountFollowing] }>()
const { t } = useI18n()
const store = useInstancesStore()
const fmt = (d: string | null | undefined) => (d ? new Date(d).toLocaleString(dateLocale()) : '—')
const isFollowers = computed(() => props.kind === 'followers')

const data = ref<AccountFollowing | null>(null)
const loading = ref(false)
const q = reactive({ text: '', state: 'current' as 'all' | 'current' | 'gone' })
const page = reactive({ current: 1, pageSize: 20 })
async function load() {
  loading.value = true
  try {
    const p = isFollowers.value
      ? new URLSearchParams({ limit: '20', offset: '0', state: 'current' })
      : new URLSearchParams({ limit: String(page.pageSize), offset: String((page.current - 1) * page.pageSize), state: q.state })
    if (!isFollowers.value && q.text.trim()) p.set('q', q.text.trim())
    const path = isFollowers.value ? 'followers/list' : 'following'
    data.value = await api<AccountFollowing>('GET', `/api/social/accounts/${props.accountId}/${path}?${p}`)
    if (data.value.pending && !syncTask.value) syncTask.value = data.value.pending.taskId
    emit('loaded', data.value)
  } catch (e) { message.error(errorText(e)) }
  finally { loading.value = false }
}
function search() { page.current = 1; void load() }
function onTable(p: { current?: number; pageSize?: number }) { page.current = p.current ?? 1; page.pageSize = p.pageSize ?? page.pageSize; void load() }
defineExpose({ load })

const stateOptions = computed(() => [
  { value: 'all', label: t('social.audience.stateAll') },
  { value: 'current', label: t(isFollowers.value ? 'social.audience.stateCurrentFollowers' : 'social.audience.stateCurrentFollowing') },
  { value: 'gone', label: t('social.audience.stateGone') },
])
const columns = computed(() => [
  { title: t('social.audience.colAccount'), key: 'handle', width: 240, ellipsis: true },
  { title: t('social.audience.colName'), key: 'displayName', width: 180, ellipsis: true },
  { title: t('social.audience.colFollowers'), key: 'followers', width: 90, align: 'center' as const },
  { title: t('social.audience.colFollowing'), key: 'following', width: 90, align: 'center' as const },
  ...(isFollowers.value
    ? [{ title: t('social.audience.colFirstSeen'), key: 'firstSeenAt', width: 180 }]
    : [{ title: t('social.audience.colLastSeen'), key: 'lastSeenAt', width: 180 }, { title: t('social.audience.colStatus'), key: 'status', width: 120 }]),
  { title: '', key: 'open', width: 56, align: 'center' as const },
])
/** A listed account's counter as read from its profile: ≈ when the app abbreviated it, — when unknown. */
const countText = (r: FollowingEntry, k: 'followers' | 'following') => (r[k] === null ? '—' : `${r.approx.includes(k) ? '≈' : ''}${compactNumber(r[k])}`)
const countTip = (r: FollowingEntry) => (r.profileCode === 'not_found' ? t('social.audience.profileNotFound', { time: fmt(r.profileCheckedAt) })
  : r.profileCheckedAt ? t('social.audience.profileReadAt', { time: fmt(r.profileCheckedAt) }) : t('social.audience.profileNotRead'))
const max = computed(() => data.value?.settings.max ?? (isFollowers.value ? 20 : 200))
const unsupportedText = computed(() => (data.value?.unsupported ? codeText(data.value.unsupported, {}, data.value.unsupported) : ''))
/** Last run of the device task, as this list saw it (the followers part has its own result inside it). */
const lastRunText = computed(() => {
  const r = data.value?.last
  if (!r) return t('social.audience.neverSynced')
  if (r.status === 'failed') return t('social.audience.lastFailed', { time: fmt(r.at), msg: codeText(r.errorCode ?? undefined, {}, r.errorCode ?? r.status) })
  const all = r.result ?? {}
  if (all.outcome === 'skipped') return t('social.audience.lastSkipped', { time: fmt(r.at), msg: codeText(String(all.code ?? ''), {}, String(all.code ?? '')) })
  if (!isFollowers.value) return t(all.complete ? 'social.audience.lastComplete' : all.capped ? 'social.audience.lastCapped' : 'social.audience.lastPartial', { time: fmt(r.at), n: Number(all.seen ?? 0) })
  const res = (all.followers ?? null) as Record<string, unknown> | null
  if (!res) return t('social.audience.neverSynced')
  if (typeof res.code === 'string') return t('social.audience.followersLastSkipped', { time: fmt(r.at), msg: codeText(res.code, {}, res.code) })
  return t(res.complete ? 'social.audience.followersLastComplete' : res.capped ? 'social.audience.followersLastCapped' : 'social.audience.followersLastPartial', { time: fmt(r.at), n: Number(res.seen ?? 0) })
})

/** 同步更新: queues a read on the account's phone (both lists), followed through task events. */
const syncTask = ref<string | null>(null)
/** The followed task was queued by this list's own button (only then a message: the other tab reloads quietly). */
const own = ref(false)
async function sync() {
  try {
    const r = await api<{ task: { id: string } }>('POST', `/api/social/accounts/${props.accountId}/following/sync`)
    syncTask.value = r.task.id
    own.value = true
    message.info(t('social.audience.syncQueued'))
  } catch (e) { message.error(errorText(e)) }
}
async function syncEnded(id: string) {
  try {
    const { task } = await api<{ task: Task & { result: Record<string, unknown> | null } }>('GET', `/api/tasks/${id}`)
    const res = task.result ?? {}
    if (task.status === 'success' && res.outcome === 'deferred' && typeof res.taskId === 'string') { syncTask.value = res.taskId; return }
    syncTask.value = null
    const mine = own.value
    own.value = false
    if (!mine) { /* queued elsewhere: just reload */ } else if (task.status !== 'success') message.error(t('social.audience.syncFailed', { msg: codeText(task.errorCode ?? undefined, {}, task.error ?? task.status) }))
    else if (res.outcome === 'synced') {
      const f = (res.followers ?? {}) as Record<string, unknown>
      const extra = typeof f.seen === 'number' ? ` · ${t('social.audience.syncedFollowers', { n: f.seen, added: Number(f.added ?? 0) })}` : ''
      message.success(t('social.audience.synced', { n: Number(res.seen ?? 0), added: Number(res.added ?? 0), gone: Number(res.gone ?? 0) }) + extra)
    }
  } catch (e) { message.error(errorText(e)) }
  void load()
}
/** Every account-following task of this account counts (step 3 of 同步, scheduled reads), not only this list's own. */
const off = store.onTaskEvent((ev) => {
  if (ev.type !== 'task.updated') return
  const ended = ['success', 'failed', 'cancelled'].includes(ev.task.status)
  if (ev.task.id === syncTask.value) { if (ended) void syncEnded(ev.task.id); return }
  if (ev.task.type !== 'account-following' || ev.task.refId !== props.accountId) return
  if (!ended) { if (!syncTask.value) syncTask.value = ev.task.id }
  else void load()
})
onBeforeUnmount(off)
onMounted(() => { void load() })
</script>

<template>
  <div class="audience-list">
    <div class="bar">
      <a-space v-if="isFollowers" wrap :size="[12, 4]">
        <strong>{{ t('social.audience.followersCount', { n: count ?? '—' }) }}</strong>
      </a-space>
      <a-space v-else wrap :size="[12, 4]">
        <strong v-if="data">{{ t('social.audience.totalFollowing', { n: data.current }) }}</strong>
        <a-input-search v-model:value="q.text" :placeholder="t('social.audience.search')" allow-clear class="search" @search="search" />
        <a-select v-model:value="q.state" :options="stateOptions" class="state" @change="search" />
      </a-space>
      <a-space wrap :size="[8, 4]">
        <span class="muted small">{{ data ? lastRunText : '' }}</span>
        <a-tag v-if="data?.halted" color="error">{{ t('social.audience.halted') }}</a-tag>
        <a-tooltip :title="unsupportedText || t('social.audience.syncListsHint', { following: 200, followers: 20 })">
          <a-button :disabled="!data || !!data.unsupported || data.halted" :loading="!!syncTask" @click="sync">
            <template #icon><SyncOutlined /></template>{{ t('social.audience.syncUpdate') }}
          </a-button>
        </a-tooltip>
      </a-space>
    </div>
    <a-alert v-if="data?.unsupported && !isFollowers" type="info" show-icon :message="unsupportedText" class="gap" />
    <a-empty v-if="data && !data.total && (isFollowers || (!q.text && q.state !== 'gone' && !data.gone))"
      :description="isFollowers ? t('social.audience.followersListEmpty', { max }) : t('social.audience.followingEmpty', { max })" />
    <a-table
      v-else :data-source="data?.items ?? []" :columns="columns" row-key="id" size="middle" :loading="loading" :scroll="{ x: 640 }"
      :pagination="isFollowers ? false : pagination({ current: page.current, pageSize: page.pageSize, total: data?.total ?? 0, totalText: (n: number) => t('social.total', { n }) })"
      @change="onTable"
    >
      <template #headerCell="{ column }">
        <template v-if="column.key === 'firstSeenAt'">
          {{ column.title }}
          <a-tooltip :title="t('social.audience.firstSeenHint', { max })"><InfoCircleOutlined class="muted" /></a-tooltip>
        </template>
      </template>
      <template #bodyCell="{ column, record }">
        <template v-if="column.key === 'handle'">
          <span class="who">
            <InitialAvatar :name="record.displayName" :handle="record.handle" :size="28" />
            <a :href="`https://www.instagram.com/${record.handle}/`" target="_blank" rel="noopener noreferrer">{{ '@' + record.handle }}</a>
            <a-tag v-if="record.verified" color="blue">{{ t('social.audience.verified') }}</a-tag>
            <a-tooltip v-if="record.private" :title="t('social.audience.privateHint')">
              <a-tag class="private"><LockOutlined /> {{ t('social.audience.private') }}</a-tag>
            </a-tooltip>
          </span>
        </template>
        <template v-else-if="column.key === 'followers' || column.key === 'following'">
          <a-tooltip :title="countTip(record)">
            <span :class="{ muted: record[column.key] === null }">{{ countText(record, column.key) }}</span>
          </a-tooltip>
        </template>
        <template v-else-if="column.key === 'displayName'"><span v-if="record.displayName">{{ record.displayName }}</span><span v-else class="muted">—</span></template>
        <template v-else-if="column.key === 'lastSeenAt'">{{ fmt(record.lastSeenAt) }}</template>
        <template v-else-if="column.key === 'firstSeenAt'">{{ fmt(record.firstSeenAt) }}</template>
        <template v-else-if="column.key === 'status'">
          <a-tag v-if="record.goneAt">{{ t('social.audience.gone', { time: fmt(record.goneAt) }) }}</a-tag>
          <a-tag v-else color="success">{{ t(isFollowers ? 'social.audience.stateCurrentFollowers' : 'social.audience.stateCurrentFollowing') }}</a-tag>
        </template>
        <template v-else-if="column.key === 'open'">
          <a-tooltip :title="t('social.audience.openInstagram')">
            <a :href="`https://www.instagram.com/${record.handle}/`" target="_blank" rel="noopener noreferrer" :aria-label="t('social.audience.openInstagram')"><ExportOutlined /></a>
          </a-tooltip>
        </template>
      </template>
    </a-table>
    <div class="muted small">{{ isFollowers ? t('social.audience.followersListHint', { max }) : t('social.audience.followingSource') }} {{ t('social.audience.profilesHint', { n: 30 }) }}</div>
  </div>
</template>

<style scoped>
.audience-list { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.bar { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px; }
.search { width: 220px; max-width: 100%; }
.state { width: 170px; }
.who { display: inline-flex; align-items: center; gap: 8px; min-width: 0; }
.who .ant-tag { margin-inline-end: 0; }
.private { color: var(--cp-text-secondary); }
.gap { margin-bottom: 0; }
</style>
