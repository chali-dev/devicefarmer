<script setup lang="ts">
import { dateLocale } from '../../i18n'
import { computed, ref, watch } from 'vue'
import { message } from 'ant-design-vue'
import { useI18n } from 'vue-i18n'
import { api, codeText, errorText } from '../../api/client'
import {
  compactNumber, trackedHandle,
  type TrackedAccount, type TrackedMetric, type TrackedPlatform, type TrackedPost, type TrackedSnapshot,
} from '../../api/types'
import LineChart from './LineChart.vue'
import StatusTag from '../common/StatusTag.vue'
import PlatformTag from '../social/PlatformTag.vue'
import { confirmDanger, DRAWER_WIDTH, pagination } from '../common/ui'

/** Detail of one tracked account: follower history chart + table, public posts, refresh (manual entry was removed). */
const open = defineModel<boolean>('open', { required: true })
const props = defineProps<{ account: TrackedAccount | null; platforms: TrackedPlatform[] }>()
const emit = defineEmits<{ changed: [TrackedAccount]; edit: [TrackedAccount]; refresh: [TrackedAccount] }>()
const { t } = useI18n()

const acc = computed(() => props.account)
const platform = computed(() => props.platforms.find((p) => p.id === acc.value?.platform) ?? null)
const metrics = computed<TrackedMetric[]>(() => platform.value?.metrics ?? ['followers'])
const tab = ref('history')

const snapshots = ref<TrackedSnapshot[]>([])
const posts = ref<TrackedPost[]>([])
const postsTotal = ref(0)
const postsPage = ref(1)
const loading = ref(false)

async function loadSnapshots() {
  if (!acc.value) return
  snapshots.value = (await api<{ snapshots: TrackedSnapshot[] }>('GET', `/api/tracked-accounts/${acc.value.id}/snapshots?limit=1000`)).snapshots
}
async function loadPosts() {
  if (!acc.value) return
  const r = await api<{ posts: TrackedPost[]; total: number }>('GET', `/api/tracked-accounts/${acc.value.id}/posts?page=${postsPage.value}&pageSize=20`)
  posts.value = r.posts
  postsTotal.value = r.total
}
async function loadAll() {
  loading.value = true
  try { await Promise.all([loadSnapshots(), loadPosts()]) } catch (e) { message.error(errorText(e)) }
  finally { loading.value = false }
}
async function reloadAccount() {
  if (!acc.value) return
  try { emit('changed', (await api<{ account: TrackedAccount }>('GET', `/api/tracked-accounts/${acc.value.id}`)).account) } catch { /* list refresh shows it */ }
}
watch(() => [open.value, acc.value?.id], ([o], prev) => {
  if (o && acc.value && (prev?.[1] !== acc.value.id || !prev?.[0])) { postsPage.value = 1; tab.value = 'history'; void loadAll() }
})
// A finished refresh brings new data.
watch(() => acc.value?.lastRefresh?.status, (s, old) => { if (open.value && s && s !== old && (s === 'success' || s === 'failed')) void loadAll() })

// ---- chart
const metric = ref<TrackedMetric>('followers')
const metricText = (m: TrackedMetric) => t(`tracked.metrics.${m}`)
const series = computed(() => snapshots.value.filter((s) => s[metric.value] !== null).map((s) => ({ t: new Date(s.capturedAt).getTime(), v: s[metric.value]! })))
const fmtFull = (n: number | null) => (n === null ? '—' : n.toLocaleString(dateLocale()))
/** Metrics the app abbreviated (e.g. "3.2万") are approximate: shown with 约 / ≈ in front. */
const isApprox = (approx: string[] | null | undefined, m: string) => !!approx?.includes(m)
const approxText = (approx: string[] | null | undefined, m: string) => (isApprox(approx, m) ? `${t('tracked.approx')} ` : '')

const snapColumns = computed(() => [
  { title: t('tracked.capturedAt'), key: 'capturedAt', width: 170 },
  ...metrics.value.map((m) => ({ title: metricText(m), key: m, align: 'right' as const })),
  { title: t('tracked.source'), key: 'source', width: 90 },
  { title: t('common.action'), key: 'ops', width: 70 },
])
const snapRows = computed(() => [...snapshots.value].reverse())

function removeSnap(s: TrackedSnapshot) {
  confirmDanger({
    title: t('tracked.confirmDeleteSnapshot'),
    onOk: async () => {
      try {
        await api('DELETE', `/api/tracked-accounts/${acc.value!.id}/snapshots/${s.id}`)
        await loadSnapshots()
        await reloadAccount()
      } catch (e) { message.error(errorText(e)) }
    },
  })
}

// ---- posts
const postColumns = computed(() => [
  { title: t('tracked.postTitle'), key: 'title' },
  { title: t('tracked.publishedAt'), key: 'publishedAt', width: 150 },
  { title: t('tracked.firstSeen'), key: 'firstSeenAt', width: 150 },
  { title: t('tracked.postMetrics'), key: 'metrics', width: 170 },
  { title: t('common.action'), key: 'ops', width: 70 },
])
function removePost(p: TrackedPost) {
  confirmDanger({
    title: t('tracked.confirmDeletePost'),
    onOk: async () => {
      try { await api('DELETE', `/api/tracked-accounts/${acc.value!.id}/posts/${p.id}`); await loadPosts() } catch (e) { message.error(errorText(e)) }
    },
  })
}
const isHttp = (u: string | null) => !!u && /^https?:\/\//i.test(u)
const when = (s: string | null) => (s ? new Date(s).toLocaleString(dateLocale()) : '—')
</script>

<template>
  <a-drawer v-model:open="open" :width="DRAWER_WIDTH.lg" :title="acc ? (acc.displayName || trackedHandle(acc)) : ''" destroy-on-close>
    <template v-if="acc" #extra>
      <a-space>
        <a-button @click="emit('edit', acc)">{{ t('common.edit') }}</a-button>
        <a-button v-if="acc.dataMode !== 'manual_only'" type="primary" :disabled="acc.status === 'paused' || acc.dataMode.endsWith('_unconfigured')"
          :loading="['pending', 'scheduled', 'running'].includes(acc.lastRefresh?.status ?? '')" @click="emit('refresh', acc)">
          {{ t('tracked.refreshNow') }}
        </a-button>
      </a-space>
    </template>
    <template v-if="acc">
      <div class="head">
        <a-avatar v-if="acc.avatarUrl" :src="acc.avatarUrl" :size="56" referrerpolicy="no-referrer" />
        <a-avatar v-else :size="56">{{ (acc.displayName || acc.handle).charAt(0).toUpperCase() }}</a-avatar>
        <div class="who">
          <a-space wrap :size="6">
            <PlatformTag :platform="acc.platform" :name="platform?.label" />
            <a :href="acc.profileUrl" target="_blank" rel="noopener noreferrer">{{ trackedHandle(acc) }}</a>
            <StatusTag kind="tracked" :status="acc.status" />
            <a-tag v-if="acc.verified" color="blue">{{ t('tracked.verified') }}</a-tag>
            <a-tag v-if="acc.dataMode === 'manual_only'">{{ t(`tracked.dataModes.${acc.dataMode}`) }}</a-tag>
          </a-space>
          <div class="muted small">
            {{ acc.category || t('tracked.uncategorized') }}
            <a-tag v-for="tg in acc.tags" :key="tg" class="small-tag">{{ tg }}</a-tag>
          </div>
          <div class="muted small">{{ t('tracked.lastChecked') }}: {{ when(acc.lastCheckedAt) }}{{ acc.lastSource ? ` · ${t(`tracked.sources.${acc.lastSource}`)}` : '' }}</div>
          <div v-if="acc.bio" class="bio">{{ acc.bio }}</div>
        </div>
      </div>

      <a-alert v-if="acc.status === 'error' && acc.lastError" type="error" show-icon class="note"
        :message="codeText(acc.lastErrorCode, undefined, acc.lastError)" />
      <a-alert v-if="acc.dataMode === 'api_unconfigured'" type="warning" show-icon class="note" :message="t('tracked.apiUnconfiguredHint')" />
      <a-alert v-if="acc.dataMode === 'device_unconfigured'" type="warning" show-icon class="note" :message="t('tracked.deviceUnconfiguredHint')" />

      <a-row :gutter="12" class="stats">
        <a-col v-for="m in metrics" :key="m" :xs="12" :sm="6">
          <a-statistic :title="metricText(m)" :value="acc.latest?.[m] ?? undefined" :formatter="({ value }: any) => approxText(acc?.latest?.approx, m) + fmtFull(value ?? null)" />
          <div v-if="m === 'followers' && acc.followersDelta !== null" :class="['delta', acc.followersDelta >= 0 ? 'up' : 'down']">
            {{ acc.followersDelta >= 0 ? '+' : '' }}{{ acc.followersDelta.toLocaleString(dateLocale()) }}
          </div>
        </a-col>
      </a-row>

      <a-tabs v-model:active-key="tab">
        <a-tab-pane key="history" :tab="t('tracked.history')">
          <a-space style="margin-bottom: 8px" wrap>
            <a-radio-group v-model:value="metric" size="small" button-style="solid">
              <a-radio-button v-for="m in metrics" :key="m" :value="m">{{ metricText(m) }}</a-radio-button>
            </a-radio-group>
          </a-space>
          <a-spin :spinning="loading">
            <LineChart v-if="series.length" :points="series" :format="(v: number) => compactNumber(v)" :aria-label="metricText(metric)" />
            <a-empty v-else :description="t('tracked.noHistory')" />
          </a-spin>
          <a-table :data-source="snapRows" :columns="snapColumns" row-key="id" size="small" style="margin-top: 12px"
            :pagination="pagination({ defaultPageSize: 10, hideOnSinglePage: true })">
            <template #bodyCell="{ column, record }">
              <template v-if="column.key === 'capturedAt'">{{ when(record.capturedAt) }}</template>
              <template v-else-if="column.key === 'source'"><a-tag>{{ t(`tracked.sources.${record.source}`) }}</a-tag></template>
              <template v-else-if="column.key === 'ops'">
                <a-button size="small" type="link" danger @click="removeSnap(record as TrackedSnapshot)">{{ t('common.delete') }}</a-button>
              </template>
              <template v-else>
                <a-tooltip v-if="isApprox(record.approx, column.key as string)" :title="t('tracked.approxHint')">{{ t('tracked.approx') }} {{ fmtFull(record[column.key as TrackedMetric]) }}</a-tooltip>
                <template v-else>{{ fmtFull(record[column.key as TrackedMetric]) }}</template>
              </template>
            </template>
          </a-table>
        </a-tab-pane>

        <a-tab-pane key="posts" :tab="`${t('tracked.posts')} (${postsTotal})`">
          <a-table :data-source="posts" :columns="postColumns" row-key="id" size="small" :loading="loading"
            :pagination="pagination({ current: postsPage, pageSize: 20, total: postsTotal, showSizeChanger: false, hideOnSinglePage: true, onChange: (p: number) => { postsPage = p; loadPosts() } })">
            <template #bodyCell="{ column, record }">
              <template v-if="column.key === 'title'">
                <a v-if="isHttp(record.url)" :href="record.url" target="_blank" rel="noopener noreferrer">{{ record.title || record.externalId }}</a>
                <span v-else>{{ record.title || record.externalId }}</span>
                <a-tag v-if="record.source === 'manual'" class="small-tag">{{ t('tracked.sources.manual') }}</a-tag>
              </template>
              <template v-else-if="column.key === 'publishedAt'">{{ when(record.publishedAt) }}</template>
              <template v-else-if="column.key === 'firstSeenAt'">{{ when(record.firstSeenAt) }}</template>
              <template v-else-if="column.key === 'metrics'">
                <span class="small">{{ t('tracked.postMetricsText', { views: compactNumber(record.views), likes: compactNumber(record.likes), comments: compactNumber(record.comments) }) }}</span>
              </template>
              <template v-else-if="column.key === 'ops'">
                <a-button size="small" type="link" danger @click="removePost(record as TrackedPost)">{{ t('common.delete') }}</a-button>
              </template>
            </template>
          </a-table>
        </a-tab-pane>
      </a-tabs>
    </template>
  </a-drawer>

</template>

<style scoped>
.head { display: flex; gap: 16px; align-items: flex-start; margin-bottom: 12px; }
.who { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.bio { color: var(--cp-text-secondary); font-size: 13px; white-space: pre-line; max-height: 4.5em; overflow: hidden; }
.note { margin-bottom: 12px; }
.stats { margin-bottom: 8px; }
.delta { font-size: 12px; }
.delta.up { color: var(--cp-primary); }
.delta.down { color: var(--cp-error); }
.small-tag { margin-left: 4px; font-size: 11px; }
</style>
