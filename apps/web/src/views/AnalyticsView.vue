<script setup lang="ts">
import { dateLocale } from '../i18n'
import { message } from 'ant-design-vue'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { api, codeText, errorText } from '../api/client'
import {
  compactNumber, dayTs,
  type AnalyticsAccount, type AnalyticsSeries, type AnalyticsSummary, type ManagedUser,
} from '../api/types'
import PageContainer from '../components/common/PageContainer.vue'
import SearchBar from '../components/common/SearchBar.vue'
import StatusTag from '../components/common/StatusTag.vue'
import { actionColumn, DRAWER_WIDTH, pagination, TABLE_SIZE } from '../components/common/ui'
import PlatformTag from '../components/social/PlatformTag.vue'
import TrendCharts from '../components/analytics/TrendCharts.vue'
import AccountPosts from '../components/analytics/AccountPosts.vue'
import { useAuthStore } from '../stores/auth'
import { usePlatformsStore } from '../stores/platforms'

/**
 * 账号分析: followers gained, views, likes, comments and shares per day (+ per-post counters) of the operator's own social accounts
 * (official APIs of connected accounts; manual entry was removed, older entered rows are still shown). Days are UTC.
 */
const { t } = useI18n()
const auth = useAuthStore()
const RANGES = [7, 30, 90] as const
const platforms = usePlatformsStore()

const range = ref<number>(7)
const ownerId = ref<string | undefined>()
const platform = ref<string | undefined>()
const users = ref<ManagedUser[]>([])
const data = ref<AnalyticsSummary | null>(null)
const loading = ref(false)

async function load(quiet = false) {
  if (!quiet) loading.value = true
  try {
    const p = new URLSearchParams({ days: String(range.value) })
    if (ownerId.value) p.set('ownerId', ownerId.value)
    if (platform.value) p.set('platform', platform.value)
    data.value = await api<AnalyticsSummary>('GET', `/api/analytics/summary?${p}`)
    if (detail.value) void loadDetail(detail.value.account.id, true)
    schedulePoll()
  } catch (e) { if (!quiet) message.error(errorText(e)) }
  finally { loading.value = false }
}
watch([range, ownerId, platform], () => void load())
onMounted(async () => {
  void load()
  if (auth.isAdmin) { try { users.value = (await api<{ users: ManagedUser[] }>('GET', '/api/users')).users } catch { /* filter only */ } }
})

// Poll while stats tasks are queued/running.
let pollTimer: ReturnType<typeof setTimeout> | null = null
const busy = (a: AnalyticsAccount) => ['pending', 'running'].includes(a.lastRun?.status ?? '')
function schedulePoll() {
  if (pollTimer) clearTimeout(pollTimer)
  pollTimer = data.value?.accounts.some(busy) ? setTimeout(() => void load(true), 2000) : null
}
onBeforeUnmount(() => { if (pollTimer) clearTimeout(pollTimer) })

const fmtDay = (d: string) => new Date(dayTs(d)).toLocaleDateString(dateLocale())
const signed = (n: number | null | undefined) => (n === null || n === undefined ? '—' : `${n > 0 ? '+' : ''}${compactNumber(n)}`)
const canRefresh = (a: AnalyticsAccount) => a.connection !== null && platforms.statsPlatforms.includes(a.platform)
const handle = (a: { handle: string; displayName: string | null }) => a.displayName || `@${a.handle}`

async function refresh(a: AnalyticsAccount) {
  try {
    await api('POST', `/api/analytics/accounts/${a.id}/refresh`)
    message.info(t('analytics.refreshQueued'))
    await load(true)
  } catch (e) { message.error(errorText(e)) }
}

const columns = computed(() => [
  { title: t('analytics.colAccount'), key: 'account', width: 240 },
  ...(auth.isAdmin ? [{ title: t('analytics.owner'), key: 'owner', width: 110 }] : []),
  { title: t('analytics.metrics.followers'), key: 'followers', width: 110, align: 'right' as const },
  { title: t('analytics.gained'), key: 'gained', width: 110, align: 'right' as const },
  { title: t('analytics.metrics.views'), key: 'views', width: 100, align: 'right' as const },
  { title: t('analytics.metrics.likes'), key: 'likes', width: 100, align: 'right' as const },
  { title: t('analytics.metrics.comments'), key: 'comments', width: 100, align: 'right' as const },
  { title: t('analytics.metrics.shares'), key: 'shares', width: 100, align: 'right' as const },
  { title: t('analytics.colSource'), key: 'source', width: 200 },
  actionColumn(200),
])

// ---- detail (one account)
const detailOpen = ref(false)
const detail = ref<AnalyticsSeries | null>(null)
async function loadDetail(id: string, quiet = false) {
  try { detail.value = await api<AnalyticsSeries>('GET', `/api/analytics/accounts/${id}?days=${range.value}`) } catch (e) { if (!quiet) message.error(errorText(e)) }
}
const detailTab = ref<'days' | 'posts'>('days')
async function openDetail(a: AnalyticsAccount) { detail.value = null; detailTab.value = 'days'; detailOpen.value = true; await loadDetail(a.id) }
const detailRows = computed(() => [...(detail.value?.days ?? [])].reverse().filter((d) => d.source !== null))
const userOptions = computed(() => users.value.map((u) => ({ value: u.id, label: u.username })))
const totalStats = computed(() => {
  const x = data.value?.totals
  if (!x) return []
  const gained = x.followersGained ?? 0
  return [
    { key: 'accounts', title: t('analytics.accounts'), value: String(x.accounts) },
    { key: 'followers', title: t('analytics.metrics.followers'), value: compactNumber(x.followers) },
    { key: 'gained', title: t('analytics.gained'), value: signed(x.followersGained), tone: gained > 0 ? 'var(--cp-success)' : undefined },
    { key: 'views', title: t('analytics.metrics.views'), value: compactNumber(x.views) },
    { key: 'shares', title: t('analytics.metrics.shares'), value: compactNumber(x.shares) },
    { key: 'likes', title: t('analytics.metrics.likes'), value: compactNumber(x.likes) },
    { key: 'comments', title: t('analytics.metrics.comments'), value: compactNumber(x.comments) },
  ]
})
const sourceTip = (a: AnalyticsAccount, apiStats: boolean) => (a.connection ? undefined : apiStats ? t('analytics.manualHintConnect') : t('analytics.manualHintNoApi'))
</script>

<template>
  <PageContainer :title="t('analytics.title')" :subtitle="data ? t('analytics.rangeHint', { from: fmtDay(data.from), to: fmtDay(data.to) }) : undefined">
    <a-card :bordered="false">
      <SearchBar :loading="loading" @refresh="load()">
        <a-radio-group v-model:value="range" button-style="solid">
          <a-radio-button v-for="r in RANGES" :key="r" :value="r">{{ t('analytics.lastDays', { n: r }) }}</a-radio-button>
        </a-radio-group>
        <a-select v-model:value="platform" :placeholder="t('analytics.platform')" allow-clear style="width: 140px">
          <a-select-option v-for="p in platforms.scope.enabled" :key="p.id" :value="p.id"><PlatformTag :platform="p.id" /></a-select-option>
        </a-select>
        <a-select v-if="auth.isAdmin" v-model:value="ownerId" :placeholder="t('analytics.owner')" allow-clear show-search option-filter-prop="label" style="width: 160px" :options="userOptions" />
      </SearchBar>
      <a-row v-if="data" :gutter="[16, 16]">
        <a-col v-for="s in totalStats" :key="s.key" flex="1 0 120px">
          <a-statistic :title="s.title" :value="s.value" :value-style="s.tone ? { color: s.tone } : undefined" />
        </a-col>
      </a-row>
      <a-skeleton v-else-if="loading" active :paragraph="{ rows: 1 }" />
    </a-card>

    <template v-if="data">
      <a-card :bordered="false" :title="t('analytics.trendAll')">
        <TrendCharts :days="data.days" />
      </a-card>

      <a-card :bordered="false">
        <a-table :data-source="data.accounts" :columns="columns" row-key="id" :size="TABLE_SIZE" :scroll="{ x: 1370 }" :loading="loading"
          :pagination="pagination({ hideOnSinglePage: true })" :locale="{ emptyText: t('analytics.empty') }">
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'account'">
              <a-space :size="6">
                <PlatformTag :platform="record.platform" />
                <a @click="openDetail(record as AnalyticsAccount)">{{ handle(record as AnalyticsAccount) }}</a>
              </a-space>
            </template>
            <template v-else-if="column.key === 'owner'">{{ record.ownerName ?? '—' }}</template>
            <template v-else-if="column.key === 'followers'">
              <a-tooltip :title="record.latest ? t('analytics.asOf', { day: fmtDay(record.latest.day) }) : undefined">
                <span class="num">{{ compactNumber(record.latest?.followers) }}</span>
              </a-tooltip>
            </template>
            <template v-else-if="column.key === 'gained'">
              <span :class="['num', (record.range.followersGained ?? 0) > 0 ? 'up' : (record.range.followersGained ?? 0) < 0 ? 'down' : '']">{{ signed(record.range.followersGained) }}</span>
            </template>
            <template v-else-if="column.key === 'views'"><span class="num">{{ compactNumber(record.range.views) }}</span></template>
            <template v-else-if="column.key === 'likes'"><span class="num">{{ compactNumber(record.range.likes) }}</span></template>
            <template v-else-if="column.key === 'comments'"><span class="num">{{ compactNumber(record.range.comments) }}</span></template>
            <template v-else-if="column.key === 'shares'"><span class="num">{{ compactNumber(record.range.shares) }}</span></template>
            <template v-else-if="column.key === 'source'">
              <a-tag v-if="record.connection === 'connected'" color="success">{{ t('analytics.sourceApi') }}</a-tag>
              <a-tag v-else-if="record.connection" color="warning">{{ t('analytics.sourceExpired') }}</a-tag>
              <a-tag v-else>{{ t('analytics.sourceManual') }}</a-tag>
              <a-tooltip v-if="record.missing.length" :title="t('analytics.missingHint', { metrics: record.missing.map((m: string) => t(`analytics.metrics.${m}`)).join(', ') })">
                <a-tag color="orange">{{ t('analytics.scopeMissing') }}</a-tag>
              </a-tooltip>
              <div v-if="record.lastRun" class="small">
                <a-tooltip :title="record.lastRun.status === 'failed' ? codeText(record.lastRun.errorCode, undefined, record.lastRun.error ?? '') : undefined">
                  <StatusTag kind="task" :status="record.lastRun.status" />
                </a-tooltip>
                <span class="muted">{{ new Date(record.lastRun.finishedAt ?? record.lastRun.createdAt).toLocaleString(dateLocale()) }}</span>
              </div>
            </template>
            <template v-else-if="column.key === 'ops'">
              <a-space :size="0">
                <a-button size="small" type="link" @click="openDetail(record as AnalyticsAccount)">{{ t('common.view') }}</a-button>
                <a-button v-if="canRefresh(record as AnalyticsAccount)" size="small" type="link" :loading="busy(record as AnalyticsAccount)" @click="refresh(record as AnalyticsAccount)">{{ t('analytics.refreshNow') }}</a-button>
              </a-space>
            </template>
          </template>
        </a-table>
      </a-card>
    </template>
  </PageContainer>

  <a-drawer v-model:open="detailOpen" :title="detail ? handle(detail.account) : ''" :width="DRAWER_WIDTH.lg" destroy-on-close>
    <template v-if="detail" #extra>
      <a-space>
        <a-button v-if="canRefresh(detail.account)" :loading="busy(detail.account)" @click="refresh(detail.account)">{{ t('analytics.refreshNow') }}</a-button>
      </a-space>
    </template>
    <template v-if="detail">
      <div class="drawer-head">
        <a-space wrap>
          <PlatformTag :platform="detail.account.platform" />
          <a-tooltip :title="sourceTip(detail.account, detail.apiStats)">
            <a-tag v-if="detail.account.connection === 'connected'" color="success">{{ t('analytics.sourceApi') }}</a-tag>
            <a-tag v-else-if="detail.account.connection" color="warning">{{ t('analytics.sourceExpired') }}</a-tag>
            <a-tag v-else>{{ t('analytics.sourceManual') }}</a-tag>
          </a-tooltip>
          <span class="muted">{{ t('analytics.rangeHint', { from: fmtDay(detail.from), to: fmtDay(detail.to) }) }}</span>
        </a-space>
      </div>
      <a-alert v-if="detail.account.missing.length" type="warning" show-icon class="drawer-head"
        :message="t('analytics.missingHint', { metrics: detail.account.missing.map((m) => t(`analytics.metrics.${m}`)).join(', ') })" />
      <TrendCharts :days="detail.days" :height="140" />
      <a-tabs v-model:active-key="detailTab">
        <a-tab-pane key="days" :tab="t('analytics.dayRows')" />
        <a-tab-pane key="posts" :tab="t('analytics.tabPosts')" />
      </a-tabs>
      <AccountPosts v-if="detailTab === 'posts'" :account-id="detail.account.id" :connected="detail.account.connection === 'connected'"
        :reload-key="detail.account.lastRun?.finishedAt" />
      <a-table v-else :data-source="detailRows" row-key="day" size="small" :pagination="false" :scroll="{ x: 700 }" :locale="{ emptyText: t('analytics.noRows') }"
        :columns="[
          { title: t('analytics.day'), key: 'day', width: 110 },
          { title: t('analytics.metrics.followers'), key: 'followers', align: 'right' },
          { title: t('analytics.gained'), key: 'followersGained', align: 'right' },
          { title: t('analytics.metrics.views'), key: 'views', align: 'right' },
          { title: t('analytics.metrics.likes'), key: 'likes', align: 'right' },
          { title: t('analytics.metrics.shares'), key: 'shares', align: 'right' },
          { title: t('analytics.metrics.comments'), key: 'comments', align: 'right' },
          { title: t('analytics.colSource'), key: 'source', width: 80 },
        ]">
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'day'">{{ fmtDay(record.day) }}</template>
          <template v-else-if="column.key === 'followersGained'">{{ signed(record.followersGained) }}</template>
          <template v-else-if="column.key === 'source'">{{ t(`analytics.sources.${record.source}`) }}</template>
          <template v-else>{{ record[column.key as string] === null || record[column.key as string] === undefined ? '—' : Number(record[column.key as string]).toLocaleString(dateLocale()) }}</template>
        </template>
      </a-table>
    </template>
    <a-skeleton v-else active />
  </a-drawer>

</template>

<style scoped>
.drawer-head { margin-bottom: 12px; }
.num { font-variant-numeric: tabular-nums; }
.up { color: var(--cp-success); }
.down { color: var(--cp-error); }
</style>

