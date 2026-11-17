<script setup lang="ts">
import { dateLocale } from '../i18n'
import { message, Modal } from 'ant-design-vue'
import { ReloadOutlined } from '@ant-design/icons-vue'
import type { Dayjs } from 'dayjs'
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { api, codeText, errorText } from '../api/client'
import {
  compactNumber, dayTs, TASK_STATUS_COLOR, taskStatusText,
  type AnalyticsAccount, type AnalyticsSeries, type AnalyticsSummary, type ManagedUser,
} from '../api/types'
import StatLink from '../components/dashboard/StatLink.vue'
import PlatformTag from '../components/social/PlatformTag.vue'
import TrendCharts from '../components/analytics/TrendCharts.vue'
import { useAuthStore } from '../stores/auth'

/**
 * 账号分析: followers gained, views and shares per day of the operator's own social accounts
 * (official APIs of connected accounts, or numbers entered by hand). Days are UTC.
 */
const { t } = useI18n()
const auth = useAuthStore()
const RANGES = [7, 30, 90] as const
const STATS_PLATFORMS = ['instagram', 'youtube', 'tiktok']

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
const canRefresh = (a: AnalyticsAccount) => a.connection !== null && STATS_PLATFORMS.includes(a.platform)
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
  { title: t('analytics.metrics.shares'), key: 'shares', width: 100, align: 'right' as const },
  { title: t('analytics.colSource'), key: 'source', width: 200 },
  { title: '', key: 'ops', width: 200, align: 'right' as const },
])

// ---- detail (one account)
const detailOpen = ref(false)
const detail = ref<AnalyticsSeries | null>(null)
async function loadDetail(id: string, quiet = false) {
  try { detail.value = await api<AnalyticsSeries>('GET', `/api/analytics/accounts/${id}?days=${range.value}`) } catch (e) { if (!quiet) message.error(errorText(e)) }
}
async function openDetail(a: AnalyticsAccount) { detail.value = null; detailOpen.value = true; await loadDetail(a.id) }
const detailRows = computed(() => [...(detail.value?.days ?? [])].reverse().filter((d) => d.source !== null))
function removeDay(day: string) {
  const id = detail.value?.account.id
  if (!id) return
  Modal.confirm({
    title: t('analytics.deleteDayConfirm', { day: fmtDay(day) }), okType: 'danger', okText: t('common.delete'), cancelText: t('common.cancel'),
    async onOk() {
      try { await api('DELETE', `/api/analytics/accounts/${id}/stats/${day}`); await load(true) } catch (e) { message.error(errorText(e)) }
    },
  })
}

// ---- manual entry
const FIELDS = ['followers', 'following', 'posts', 'views', 'likes', 'shares', 'comments'] as const
const entryOpen = ref(false)
const entrySaving = ref(false)
const entryAccount = ref<AnalyticsAccount | null>(null)
const entry = reactive<{ day: string } & Record<typeof FIELDS[number], number | null>>({
  day: '', followers: null, following: null, posts: null, views: null, likes: null, shares: null, comments: null,
})
const todayUtc = () => new Date().toISOString().slice(0, 10)
function openEntry(a: AnalyticsAccount) {
  entryAccount.value = a
  Object.assign(entry, { day: todayUtc(), ...Object.fromEntries(FIELDS.map((f) => [f, null])) })
  entryOpen.value = true
}
const disabledDate = (d: Dayjs) => d.format('YYYY-MM-DD') > todayUtc()
async function saveEntry() {
  if (!entryAccount.value) return
  if (FIELDS.every((f) => entry[f] === null)) { message.warning(t('errors.analytics.stats_empty')); return }
  entrySaving.value = true
  try {
    await api('POST', `/api/analytics/accounts/${entryAccount.value.id}/stats`, {
      day: entry.day || undefined, ...Object.fromEntries(FIELDS.filter((f) => entry[f] !== null).map((f) => [f, entry[f]])),
    })
    message.success(t('common.saved'))
    entryOpen.value = false
    await load(true)
  } catch (e) { message.error(errorText(e)) }
  finally { entrySaving.value = false }
}
const userOptions = computed(() => users.value.map((u) => ({ value: u.id, label: u.username })))
</script>

<template>
  <a-card :title="t('analytics.title')" size="small">
    <template #extra>
      <a-space wrap>
        <a-radio-group v-model:value="range" button-style="solid" size="small">
          <a-radio-button v-for="r in RANGES" :key="r" :value="r">{{ t('analytics.lastDays', { n: r }) }}</a-radio-button>
        </a-radio-group>
        <a-button size="small" :loading="loading" @click="load()"><ReloadOutlined /> {{ t('common.refresh') }}</a-button>
      </a-space>
    </template>
    <a-space wrap style="margin-bottom: 12px">
      <a-select v-model:value="platform" :placeholder="t('analytics.platform')" allow-clear style="width: 140px">
        <a-select-option v-for="p in ['instagram', 'youtube', 'tiktok', 'facebook']" :key="p" :value="p"><PlatformTag :platform="p" /></a-select-option>
      </a-select>
      <a-select v-if="auth.isAdmin" v-model:value="ownerId" :placeholder="t('analytics.owner')" allow-clear show-search option-filter-prop="label" style="width: 160px" :options="userOptions" />
      <span v-if="data" class="muted small">{{ t('analytics.rangeHint', { from: fmtDay(data.from), to: fmtDay(data.to) }) }}</span>
    </a-space>

    <a-spin :spinning="loading && !data">
      <template v-if="data">
        <div class="stats">
          <StatLink :label="t('analytics.accounts')" :value="data.totals.accounts" />
          <StatLink :label="t('analytics.metrics.followers')" :value="compactNumber(data.totals.followers)" />
          <StatLink :label="t('analytics.gained')" :value="signed(data.totals.followersGained)" :tone="(data.totals.followersGained ?? 0) > 0 ? 'success' : undefined" />
          <StatLink :label="t('analytics.metrics.views')" :value="compactNumber(data.totals.views)" />
          <StatLink :label="t('analytics.metrics.shares')" :value="compactNumber(data.totals.shares)" />
          <StatLink :label="t('analytics.metrics.likes')" :value="compactNumber(data.totals.likes)" />
          <StatLink :label="t('analytics.metrics.comments')" :value="compactNumber(data.totals.comments)" />
        </div>
        <div class="section-title">{{ t('analytics.trendAll') }}</div>
        <TrendCharts :days="data.days" />

        <a-table :data-source="data.accounts" :columns="columns" row-key="id" size="middle" :scroll="{ x: 1100 }" style="margin-top: 16px"
          :pagination="data.accounts.length > 20 ? { pageSize: 20, size: 'small' } : false" :locale="{ emptyText: t('analytics.empty') }">
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'account'">
              <PlatformTag :platform="record.platform" />
              <a class="name" @click="openDetail(record as AnalyticsAccount)">{{ handle(record as AnalyticsAccount) }}</a>
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
                  <a-tag :color="TASK_STATUS_COLOR[record.lastRun.status as keyof typeof TASK_STATUS_COLOR]">{{ taskStatusText(record.lastRun.status) }}</a-tag>
                </a-tooltip>
                <span class="muted">{{ new Date(record.lastRun.finishedAt ?? record.lastRun.createdAt).toLocaleString(dateLocale()) }}</span>
              </div>
            </template>
            <template v-else-if="column.key === 'ops'">
              <a-space :size="0">
                <a-button size="small" type="link" @click="openDetail(record as AnalyticsAccount)">{{ t('common.view') }}</a-button>
                <a-button v-if="canRefresh(record as AnalyticsAccount)" size="small" type="link" :loading="busy(record as AnalyticsAccount)" @click="refresh(record as AnalyticsAccount)">{{ t('analytics.refreshNow') }}</a-button>
                <a-button size="small" type="link" @click="openEntry(record as AnalyticsAccount)">{{ t('analytics.enter') }}</a-button>
              </a-space>
            </template>
          </template>
        </a-table>
      </template>
    </a-spin>
    <div class="faint small" style="margin-top: 8px">{{ t('analytics.hint') }}</div>
  </a-card>

  <a-drawer v-model:open="detailOpen" :title="detail ? handle(detail.account) : ''" :width="760" destroy-on-close>
    <template v-if="detail">
      <a-space wrap style="margin-bottom: 12px">
        <PlatformTag :platform="detail.account.platform" />
        <span class="muted">{{ t('analytics.rangeHint', { from: fmtDay(detail.from), to: fmtDay(detail.to) }) }}</span>
        <a-button v-if="canRefresh(detail.account)" size="small" :loading="busy(detail.account)" @click="refresh(detail.account)">{{ t('analytics.refreshNow') }}</a-button>
        <a-button size="small" @click="openEntry(detail.account)">{{ t('analytics.enter') }}</a-button>
      </a-space>
      <a-alert v-if="detail.account.missing.length" type="warning" show-icon style="margin-bottom: 12px"
        :message="t('analytics.missingHint', { metrics: detail.account.missing.map((m) => t(`analytics.metrics.${m}`)).join(', ') })" />
      <a-alert v-if="!detail.account.connection" type="info" show-icon style="margin-bottom: 12px"
        :message="detail.apiStats ? t('analytics.manualHintConnect') : t('analytics.manualHintNoApi')" />
      <TrendCharts :days="detail.days" :height="140" />
      <div class="section-title">{{ t('analytics.dayRows') }}</div>
      <a-table :data-source="detailRows" row-key="day" size="small" :pagination="false" :scroll="{ x: 700 }" :locale="{ emptyText: t('analytics.noRows') }"
        :columns="[
          { title: t('analytics.day'), key: 'day', width: 110 },
          { title: t('analytics.metrics.followers'), key: 'followers', align: 'right' },
          { title: t('analytics.gained'), key: 'followersGained', align: 'right' },
          { title: t('analytics.metrics.views'), key: 'views', align: 'right' },
          { title: t('analytics.metrics.likes'), key: 'likes', align: 'right' },
          { title: t('analytics.metrics.shares'), key: 'shares', align: 'right' },
          { title: t('analytics.metrics.comments'), key: 'comments', align: 'right' },
          { title: t('analytics.colSource'), key: 'source', width: 80 },
          { title: '', key: 'ops', width: 60 },
        ]">
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'day'">{{ fmtDay(record.day) }}</template>
          <template v-else-if="column.key === 'followersGained'">{{ signed(record.followersGained) }}</template>
          <template v-else-if="column.key === 'source'">{{ t(`analytics.sources.${record.source}`) }}</template>
          <template v-else-if="column.key === 'ops'">
            <a-button size="small" type="link" danger @click="removeDay(record.day)">{{ t('common.delete') }}</a-button>
          </template>
          <template v-else>{{ record[column.key as string] === null || record[column.key as string] === undefined ? '—' : Number(record[column.key as string]).toLocaleString(dateLocale()) }}</template>
        </template>
      </a-table>
    </template>
    <a-skeleton v-else active />
  </a-drawer>

  <a-modal v-model:open="entryOpen" :title="t('analytics.enterTitle', { account: entryAccount ? handle(entryAccount) : '' })" :ok-text="t('common.save')"
    :cancel-text="t('common.cancel')" :confirm-loading="entrySaving" @ok="saveEntry">
    <a-form layout="vertical">
      <a-form-item :label="t('analytics.day')" :extra="t('analytics.dayHint')">
        <a-date-picker v-model:value="entry.day" value-format="YYYY-MM-DD" :disabled-date="disabledDate" :allow-clear="false" />
      </a-form-item>
      <div class="muted small" style="margin-bottom: 8px">{{ t('analytics.countersHint') }}</div>
      <a-row :gutter="12">
        <a-col v-for="f in (['followers', 'following', 'posts'] as const)" :key="f" :span="8">
          <a-form-item :label="t(`analytics.metrics.${f}`)"><a-input-number v-model:value="entry[f]" :min="0" :precision="0" style="width: 100%" /></a-form-item>
        </a-col>
      </a-row>
      <div class="muted small" style="margin-bottom: 8px">{{ t('analytics.activityHint') }}</div>
      <a-row :gutter="12">
        <a-col v-for="f in (['views', 'likes', 'shares', 'comments'] as const)" :key="f" :span="6">
          <a-form-item :label="t(`analytics.metrics.${f}`)"><a-input-number v-model:value="entry[f]" :min="0" :precision="0" style="width: 100%" /></a-form-item>
        </a-col>
      </a-row>
    </a-form>
  </a-modal>
</template>

<style scoped>
.stats { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 4px; margin-bottom: 8px; }
@media (max-width: 900px) { .stats { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
.section-title { margin: 12px 0 6px; font-weight: 600; color: var(--cp-text-secondary); font-size: 13px; }
.name { margin-left: 6px; }
.num { font-variant-numeric: tabular-nums; }
.up { color: var(--cp-success); }
.down { color: var(--cp-error); }
.muted { color: var(--cp-text-tertiary); }
.faint { color: var(--cp-text-quaternary); }
.small { font-size: 12px; }
</style>
