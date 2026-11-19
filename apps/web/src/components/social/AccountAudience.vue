<script setup lang="ts">
import { SyncOutlined } from '@ant-design/icons-vue'
import { message } from 'ant-design-vue'
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { api, codeText, errorText } from '../../api/client'
import { compactNumber, dayTs, type AccountFollowers, type AccountFollowing, type SocialAccount, type Task } from '../../api/types'
import { dateLocale } from '../../i18n'
import { useInstancesStore } from '../../stores/instances'
import { pagination, TABLE_SIZE } from '../common/ui'
import LineChart from '../tracked/LineChart.vue'

/**
 * 我的媒体号 → a row's expansion (owner 2026-11-18, 「移到媒体号下展开」): 粉丝 = the followers count and its changes
 * (readings of the automatic check / 同步, no follower list) and 追踪中 = the accounts this IG account really follows,
 * read from its cloud phone (同步 here; also on a schedule, 风控 → 采集限制).
 */
const props = defineProps<{ account: SocialAccount }>()
const { t } = useI18n()
const store = useInstancesStore()
const tab = ref<'followers' | 'following'>('followers')
const fmt = (d: string | null | undefined) => (d ? new Date(d).toLocaleString(dateLocale()) : '—')
const shortDay = (ts: number) => new Date(ts).toLocaleDateString(dateLocale(), { month: '2-digit', day: '2-digit' })
const signed = (n: number | null) => (n === null ? '—' : `${n > 0 ? '+' : ''}${compactNumber(n)}`)
const tone = (n: number | null) => (n === null || n === 0 ? '' : n > 0 ? 'up' : 'down')

// ---------------------------------------------------------------- 粉丝
const fol = ref<AccountFollowers | null>(null)
const folLoading = ref(false)
async function loadFollowers() {
  folLoading.value = true
  try { fol.value = await api<AccountFollowers>('GET', `/api/social/accounts/${props.account.id}/followers?days=30`) } catch (e) { message.error(errorText(e)) }
  finally { folLoading.value = false }
}
const points = computed(() => (fol.value?.series ?? []).map((d) => ({ t: dayTs(d.day), v: d.followers })))

// ---------------------------------------------------------------- 追踪中
const fw = ref<AccountFollowing | null>(null)
const fwLoading = ref(false)
const q = reactive({ text: '', gone: false })
const page = reactive({ current: 1, pageSize: 20 })
async function loadFollowing() {
  fwLoading.value = true
  try {
    const p = new URLSearchParams({ limit: String(page.pageSize), offset: String((page.current - 1) * page.pageSize) })
    if (q.text.trim()) p.set('q', q.text.trim())
    if (q.gone) p.set('gone', 'true')
    fw.value = await api<AccountFollowing>('GET', `/api/social/accounts/${props.account.id}/following?${p}`)
    if (fw.value.pending && !syncTask.value) syncTask.value = fw.value.pending.taskId
  } catch (e) { message.error(errorText(e)) }
  finally { fwLoading.value = false }
}
function search() { page.current = 1; void loadFollowing() }
function onTable(p: { current?: number; pageSize?: number }) { page.current = p.current ?? 1; page.pageSize = p.pageSize ?? page.pageSize; void loadFollowing() }
const columns = computed(() => [
  { title: t('social.audience.colAccount'), key: 'handle' },
  { title: t('social.audience.colFirstSeen'), key: 'firstSeenAt', width: 180 },
  { title: t('social.audience.colLastSeen'), key: 'lastSeenAt', width: 180 },
])
const unsupportedText = computed(() => (fw.value?.unsupported ? codeText(fw.value.unsupported, {}, fw.value.unsupported) : ''))
const lastRunText = computed(() => {
  const r = fw.value?.last
  if (!r) return t('social.audience.neverSynced')
  if (r.status === 'failed') return t('social.audience.lastFailed', { time: fmt(r.at), msg: codeText(r.errorCode ?? undefined, {}, r.errorCode ?? r.status) })
  const res = r.result ?? {}
  if (res.outcome === 'skipped') return t('social.audience.lastSkipped', { time: fmt(r.at), msg: codeText(String(res.code ?? ''), {}, String(res.code ?? '')) })
  return t(res.complete ? 'social.audience.lastComplete' : res.capped ? 'social.audience.lastCapped' : 'social.audience.lastPartial', { time: fmt(r.at), n: Number(res.seen ?? 0) })
})

/** 同步: queues a read on the account's phone, followed through task events (pace deferrals continue as a new task). */
const syncTask = ref<string | null>(null)
async function sync() {
  try {
    const r = await api<{ task: { id: string } }>('POST', `/api/social/accounts/${props.account.id}/following/sync`)
    syncTask.value = r.task.id
    message.info(t('social.audience.syncQueued'))
  } catch (e) { message.error(errorText(e)) }
}
async function syncEnded(id: string) {
  try {
    const { task } = await api<{ task: Task & { result: Record<string, unknown> | null } }>('GET', `/api/tasks/${id}`)
    const res = task.result ?? {}
    if (task.status === 'success' && res.outcome === 'deferred' && typeof res.taskId === 'string') { syncTask.value = res.taskId; return }
    syncTask.value = null
    if (task.status !== 'success') message.error(t('social.audience.syncFailed', { msg: codeText(task.errorCode ?? undefined, {}, task.error ?? task.status) }))
    else if (res.outcome === 'synced') message.success(t('social.audience.synced', { n: Number(res.seen ?? 0), added: Number(res.added ?? 0), gone: Number(res.gone ?? 0) }))
  } catch (e) { message.error(errorText(e)) }
  void loadFollowing()
}
/**
 * Every account-following task of this account counts, not only the tab's own 同步: step 3 of the row's 同步 button
 * and scheduled reads are queued elsewhere (owner 2026-11-19 「关注有6个 没有数据录入」: the list was stored, the
 * opened tab never reloaded). A queued one is followed like the tab's own; one that ends reloads the list.
 */
const off = store.onTaskEvent((ev) => {
  if (ev.type !== 'task.updated') return
  const ended = ['success', 'failed', 'cancelled'].includes(ev.task.status)
  if (ev.task.id === syncTask.value) { if (ended) void syncEnded(ev.task.id); return }
  if (ev.task.type !== 'account-following' || ev.task.refId !== props.account.id) return
  if (!ended) { if (!syncTask.value) syncTask.value = ev.task.id }
  else if (fw.value) void loadFollowing()
})
onBeforeUnmount(off)

onMounted(() => { void loadFollowers() })
watch(tab, (v) => { if (v === 'following' && !fw.value) void loadFollowing() })
</script>

<template>
  <div class="audience">
    <a-tabs v-model:active-key="tab" size="small">
      <a-tab-pane key="followers" :tab="t('social.audience.followers')">
        <a-spin :spinning="folLoading">
          <a-empty v-if="fol && !fol.current" :description="t('social.audience.followersEmpty')" />
          <template v-else-if="fol?.current">
            <a-row :gutter="[16, 8]" class="stats">
              <a-col :xs="12" :md="6">
                <a-statistic :title="t('social.audience.current')" :value="(fol.current.approx ? '≈ ' : '') + compactNumber(fol.current.followers)" />
              </a-col>
              <a-col v-for="k in (['today', 'd7', 'd30'] as const)" :key="k" :xs="12" :md="6">
                <a-statistic :title="t(`social.audience.change.${k}`)" :value="signed(fol.change[k])" :class="tone(fol.change[k])" />
              </a-col>
            </a-row>
            <LineChart :points="points" :height="150" :format-time="shortDay" :format="compactNumber" :aria-label="t('social.audience.trend')" />
            <div class="muted small">
              {{ t('social.audience.followersSource', { time: fmt(fol.lastCheckedAt ?? fol.current.at) }) }}
            </div>
          </template>
        </a-spin>
      </a-tab-pane>

      <a-tab-pane key="following" :tab="t('social.audience.following')">
        <a-spin :spinning="fwLoading && !fw">
          <div class="bar">
            <a-space wrap>
              <span v-if="fw"><strong>{{ t('social.audience.followingCount', { n: fw.following }) }}</strong></span>
              <span class="muted small">{{ fw ? lastRunText : '' }}</span>
              <a-tag v-if="fw?.halted" color="error">{{ t('social.audience.halted') }}</a-tag>
            </a-space>
            <a-space wrap>
              <a-input-search v-model:value="q.text" :placeholder="t('social.audience.search')" allow-clear size="small" style="width: 200px" @search="search" />
              <a-checkbox v-model:checked="q.gone" @change="search">{{ t('social.audience.showGone', { n: fw?.gone ?? 0 }) }}</a-checkbox>
              <a-tooltip :title="unsupportedText || t('social.audience.syncHint', { max: fw?.settings.max ?? 200 })">
                <a-button size="small" :disabled="!fw || !!fw.unsupported || fw.halted" :loading="!!syncTask" @click="sync">
                  <template #icon><SyncOutlined /></template>{{ t('social.syncNow') }}
                </a-button>
              </a-tooltip>
            </a-space>
          </div>
          <a-alert v-if="fw?.unsupported" type="info" show-icon :message="unsupportedText" class="gap" />
          <a-empty v-if="fw && !fw.total && !q.text && !q.gone" :description="t('social.audience.followingEmpty', { max: fw.settings.max })" />
          <a-table
            v-else-if="fw" :data-source="fw.items" :columns="columns" row-key="id" :size="TABLE_SIZE" :loading="fwLoading"
            :pagination="pagination({ current: page.current, pageSize: page.pageSize, total: fw.total, totalText: (n: number) => t('social.total', { n }) })"
            @change="onTable"
          >
            <template #bodyCell="{ column, record }">
              <template v-if="column.key === 'handle'">
                <a :href="`https://www.instagram.com/${record.handle}/`" target="_blank" rel="noopener noreferrer">{{ '@' + record.handle }}</a>
                <a-tag v-if="record.verified" color="blue" class="ml">{{ t('social.audience.verified') }}</a-tag>
                <a-tag v-if="record.goneAt" class="ml">{{ t('social.audience.gone', { time: fmt(record.goneAt) }) }}</a-tag>
                <div v-if="record.displayName" class="muted small">{{ record.displayName }}</div>
              </template>
              <template v-else-if="column.key === 'firstSeenAt'">{{ fmt(record.firstSeenAt) }}</template>
              <template v-else-if="column.key === 'lastSeenAt'">{{ fmt(record.lastSeenAt) }}</template>
            </template>
          </a-table>
          <div class="muted small">{{ t('social.audience.followingSource') }}</div>
        </a-spin>
      </a-tab-pane>
    </a-tabs>
  </div>
</template>

<style scoped>
.audience { padding: 0 8px 8px; max-width: 1100px; }
.stats { margin-bottom: 8px; }
.bar { display: flex; justify-content: space-between; flex-wrap: wrap; gap: 8px; margin-bottom: 8px; }
.gap { margin-bottom: 8px; }
.ml { margin-left: 6px; }
.up :deep(.ant-statistic-content) { color: var(--cp-success); }
.down :deep(.ant-statistic-content) { color: var(--cp-error); }
</style>
