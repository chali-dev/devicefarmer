<script setup lang="ts">
import { dateLocale, fmtDateTime } from '../i18n'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ReloadOutlined } from '@ant-design/icons-vue'
import { useI18n } from 'vue-i18n'
import { api, codeText, errorText } from '../api/client'
import { compactNumber, dayTs, type AnalyticsSummary, type DashboardDevices, type DashboardResponse, type ManagedUser } from '../api/types'
import StatLink from '../components/dashboard/StatLink.vue'
import SystemStatus from '../components/dashboard/SystemStatus.vue'
import PageContainer from '../components/common/PageContainer.vue'
import { pagination } from '../components/common/ui'
import PlatformIcon from '../components/social/PlatformIcon.vue'
import LineChart from '../components/tracked/LineChart.vue'
import { useAuthStore } from '../stores/auth'
import { useInstancesStore } from '../stores/instances'

/**
 * Dashboard (仪表板), simplified 2026-11-19 (owner: 「只显示 我的云机状态和媒体号分析数据」), two sections:
 * - 我的云机状态: GET /api/dashboard widget `devices` (RBAC-scoped on the server): the 云机管理 states counted
 *   (正常 / 忙 / 离线 / 未运行 / 风控暂停) and the devices that need attention, each linking to /instances?id=.
 * - 媒体号分析: GET /api/analytics/summary?days=7|30 (the 账号分析 numbers of the visible accounts; admin
 *   「以用户视角查看」 passes ownerId), totals, the per-day follower gain and one row per account → /social/accounts/:id.
 * Each section only shows when its menu (instances / analytics) is on for the viewer. Refreshes on task/device
 * events (debounced) and every 30 s while the tab is visible (and at once when it becomes visible after that).
 * Admins also get the one-line 系统状态 (SystemStatus, own request), hidden while viewing as a user.
 */
const { t, te } = useI18n()
const auth = useAuthStore()
const store = useInstancesStore()

const data = ref<DashboardResponse | null>(null)
const summary = ref<AnalyticsSummary | null>(null)
const loading = ref(false)
const error = ref<string | null>(null)
const users = ref<ManagedUser[]>([])
const asUser = ref<string | undefined>(undefined)
const days = ref<7 | 30>(7)
const tz = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' } catch { return 'UTC' } })()

const showDevices = computed(() => auth.menuAllowed('instances'))
const showAnalytics = computed(() => auth.menuAllowed('analytics'))

let lastLoad = 0
async function load() {
  loading.value = true
  lastLoad = Date.now()
  try {
    const p = new URLSearchParams({ tz })
    if (asUser.value) p.set('userId', asUser.value)
    const q = new URLSearchParams({ days: String(days.value) })
    if (asUser.value) q.set('ownerId', asUser.value)
    const [d, s] = await Promise.all([
      api<DashboardResponse>('GET', `/api/dashboard?${p}`),
      showAnalytics.value ? api<AnalyticsSummary>('GET', `/api/analytics/summary?${q}`) : Promise.resolve(null),
    ])
    data.value = d
    summary.value = s
    error.value = null
  } catch (e) { error.value = errorText(e) }
  finally { loading.value = false }
}
watch([asUser, days], () => void load())

// Live refresh: debounce bursts of events; never more often than every 3 s.
let timer: ReturnType<typeof setTimeout> | null = null
function scheduleLoad() {
  if (timer) return
  const wait = Math.max(800, 3000 - (Date.now() - lastLoad))
  timer = setTimeout(() => { timer = null; void load() }, wait)
}
const off = store.onTaskEvent((ev) => { if (ev.type === 'task.updated') scheduleLoad() })
// Device status changes (instance.updated / deleted) only matter when the state counts change.
const statusSig = computed(() => store.list.map((i) => `${i.id}:${i.status}:${i.adbState}`).join('|'))
watch(statusSig, () => scheduleLoad())
let poll: ReturnType<typeof setInterval> | null = null
const onVisible = () => { if (document.visibilityState === 'visible' && Date.now() - lastLoad > 30_000) void load() }
onMounted(() => {
  void load()
  poll = setInterval(() => { if (document.visibilityState === 'visible') void load() }, 30_000)
  document.addEventListener('visibilitychange', onVisible)
  if (auth.isAdmin) void api<{ users: ManagedUser[] }>('GET', '/api/users').then((r) => { users.value = r.users }).catch(() => undefined)
})
onBeforeUnmount(() => { off(); if (timer) clearTimeout(timer); if (poll) clearInterval(poll); document.removeEventListener('visibilitychange', onVisible) })

const userOptions = computed(() => users.value.map((u) => ({ value: u.id, label: u.username })))
const dev = computed<DashboardDevices | null>(() => (showDevices.value ? data.value?.widgets.devices ?? null : null))

// ---------------------------------------------------------------- 我的云机状态
const STATES = [
  { key: 'ok', tone: 'success' }, { key: 'busy', tone: undefined }, { key: 'offline', tone: 'warning' },
  { key: 'notRunning', tone: undefined }, { key: 'halted', tone: 'error' },
] as const
const stateLabel = (k: typeof STATES[number]['key']) => (k === 'notRunning' ? t('dashboard.dev.notRunning') : t(`devices.state.${k}`))
const REASON_BADGE = { halted: 'error', error: 'error', offline: 'warning', stopped: 'default' } as const
function reasonText(a: DashboardDevices['attention'][number]) {
  if (a.reason === 'halted') return t('devices.state.halted')
  if (a.reason === 'offline') return t('devices.state.offline')
  if (a.reason === 'stopped') return data.value?.scope.admin ? t('dashboard.dev.externalStopped') : t('devices.state.askAdmin')
  return t(`status.${a.status}`)
}

// ---------------------------------------------------------------- 媒体号分析
const signed = (n: number | null | undefined) => (n === null || n === undefined ? '—' : `${n > 0 ? '+' : ''}${compactNumber(n)}`)
const num = (n: number | null | undefined) => (n === null || n === undefined ? '—' : compactNumber(n))
const totals = computed(() => {
  const s = summary.value
  if (!s) return null
  const withPosts = s.accounts.filter((a) => a.latest?.posts !== null && a.latest?.posts !== undefined)
  return {
    followers: s.totals.withData ? s.totals.followers : null,
    gained: s.totals.followersGained,
    posts: withPosts.length ? withPosts.reduce((x, a) => x + (a.latest!.posts ?? 0), 0) : null,
    likes: s.totals.likes, comments: s.totals.comments, views: s.totals.views,
  }
})
const chart = computed(() => (summary.value?.days ?? []).map((d) => ({ t: dayTs(d.day), v: d.followersGained })))
const shortDay = (ts: number) => new Date(ts).toLocaleDateString(dateLocale(), { month: '2-digit', day: '2-digit' })
const showOwner = computed(() => !!data.value?.scope.admin)
const columns = computed(() => [
  { title: t('analytics.colAccount'), key: 'account' },
  ...(showOwner.value ? [{ title: t('analytics.owner'), key: 'owner', width: 120 }] : []),
  { title: t('analytics.metrics.followers'), key: 'followers', align: 'right' as const, width: 110 },
  { title: t('dashboard.an.change', { n: days.value }), key: 'change', align: 'right' as const, width: 110 },
  { title: t('dashboard.an.following'), key: 'following', align: 'right' as const, width: 100 },
  { title: t('dashboard.an.lastCheck'), key: 'check', width: 210 },
])
const CHECK_COLOR: Record<string, string> = { ok: 'success', logged_out: 'error', wrong_account: 'error', challenge: 'error', offline: 'default', timeout: 'warning', app_missing: 'warning' }
const checkText = (code: string | null) => (!code ? '' : te(`social.checkResult.${code}`) ? t(`social.checkResult.${code}`) : code)
const approx = (a: AnalyticsSummary['accounts'][number], k: string) => (a.latest?.approx?.includes(k) ? '≈' : '')
</script>

<template>
  <PageContainer :title="t('dashboard.title')">
    <template #extra>
      <a-select
        v-if="auth.isAdmin" v-model:value="asUser" allow-clear show-search option-filter-prop="label" style="width: 220px"
        :placeholder="t('dashboard.allUsers')" :options="userOptions"
      />
      <span v-if="data" class="muted small">{{ t('dashboard.updatedAt', { at: new Date(data.generatedAt).toLocaleTimeString(dateLocale()) }) }}</span>
      <a-button :loading="loading" @click="load"><template #icon><ReloadOutlined /></template>{{ t('common.refresh') }}</a-button>
    </template>
    <a-alert v-if="asUser && data" type="info" show-icon :message="t('dashboard.viewingAs', { name: data.scope.username })" />
    <a-alert v-if="error" type="error" show-icon :message="error" />
    <a-alert
      v-for="(msg, k) in data?.errors ?? {}" :key="k" type="warning" show-icon
      :message="t('dashboard.widgetFailed', { name: t(`dashboard.w.${k}`) })" :description="msg"
    />

    <a-spin :spinning="loading && !data">
      <a-empty v-if="data && !showDevices && !showAnalytics" :description="t('dashboard.nothing')" />
      <a-row :gutter="[16, 16]">
        <!-- 我的云机状态 -->
        <a-col v-if="dev" :xs="24" :xl="9">
          <a-card size="small" :bordered="false" :title="auth.isAdmin && !asUser ? t('dashboard.w.devicesAll') : t('dashboard.w.devices')" class="card">
            <template #extra><router-link to="/instances">{{ t('dashboard.viewAll') }}</router-link></template>
            <div v-if="!dev.total" class="muted empty">{{ t('dashboard.dev.none') }}</div>
            <template v-else>
              <div class="grid-states">
                <StatLink :label="t('devices.total')" :value="dev.total" to="/instances" />
                <StatLink v-for="s in STATES" :key="s.key" :label="stateLabel(s.key)" :value="dev.byState[s.key]" to="/instances" :tone="s.tone" />
              </div>
              <div class="list-title">
                {{ t('dashboard.dev.attention') }}
                <span v-if="dev.attentionTotal > dev.attention.length" class="muted small">{{ t('dashboard.dev.more', { n: dev.attentionTotal - dev.attention.length }) }}</span>
              </div>
              <div v-if="!dev.attention.length" class="muted small">{{ t('dashboard.dev.allGood') }}</div>
              <router-link v-for="a in dev.attention" :key="a.id" :to="{ path: '/instances', query: { id: a.id } }" class="row link-row">
                <a-badge :status="REASON_BADGE[a.reason]" />
                <span class="ellipsis">{{ a.name }}</span>
                <a-tooltip :title="a.reason === 'halted' && a.code ? `${codeText(a.code, undefined, a.code)}${a.at ? ` · ${fmtDateTime(a.at)}` : ''}` : undefined">
                  <span class="muted small nowrap">{{ reasonText(a) }}</span>
                </a-tooltip>
              </router-link>
            </template>
          </a-card>
        </a-col>

        <!-- 媒体号分析 -->
        <a-col v-if="showAnalytics && summary" :xs="24" :xl="dev ? 15 : 24">
          <a-card size="small" :bordered="false" :title="t('dashboard.w.analytics')" class="card">
            <template #extra>
              <a-space>
                <a-segmented v-model:value="days" size="small" :options="[{ value: 7, label: t('analytics.lastDays', { n: 7 }) }, { value: 30, label: t('analytics.lastDays', { n: 30 }) }]" />
                <router-link to="/analytics">{{ t('dashboard.viewAll') }}</router-link>
              </a-space>
            </template>
            <div v-if="!summary.totals.accounts" class="muted empty">{{ t('analytics.empty') }}</div>
            <template v-else>
              <div class="grid-kpi">
                <StatLink :label="t('analytics.metrics.followers')" :value="num(totals!.followers)" to="/analytics" />
                <StatLink :label="t('dashboard.an.change', { n: days })" :value="signed(totals!.gained)" to="/analytics" :tone="(totals!.gained ?? 0) > 0 ? 'success' : undefined" />
                <StatLink :label="t('dashboard.an.posts')" :value="num(totals!.posts)" to="/analytics" />
                <StatLink :label="t('analytics.metrics.likes')" :value="num(totals!.likes)" to="/analytics" />
                <StatLink :label="t('analytics.metrics.comments')" :value="num(totals!.comments)" to="/analytics" />
                <StatLink :label="t('analytics.metrics.views')" :value="num(totals!.views)" to="/analytics" />
              </div>
              <div v-if="!summary.totals.withData" class="muted small hint">{{ t('analytics.noData') }} · {{ t('analytics.noDataHint') }}</div>
              <template v-else>
                <div class="list-title">{{ t('analytics.perDay.followersGained') }} <span class="muted small">{{ t('analytics.rangeHint', { from: summary.from, to: summary.to }) }}</span></div>
                <LineChart :points="chart" :height="140" :format-time="shortDay" :format="compactNumber" :aria-label="t('analytics.perDay.followersGained')" />
              </template>
            </template>
          </a-card>
        </a-col>

        <a-col v-if="showAnalytics && summary?.totals.accounts" :xs="24">
          <a-card size="small" :bordered="false" :title="t('dashboard.an.accounts', { n: summary.totals.accounts })" class="card">
            <a-table
              :data-source="summary.accounts" :columns="columns" row-key="id" size="small" :scroll="{ x: 720 }"
              :pagination="summary.accounts.length > 10 ? pagination({ defaultPageSize: 10 }) : false"
            >
              <template #bodyCell="{ column, record }">
                <template v-if="column.key === 'account'">
                  <router-link :to="`/social/accounts/${record.id}`" class="acct">
                    <PlatformIcon :platform="record.platform" :size="16" />
                    <span class="ellipsis">{{ record.displayName || `@${record.handle}` }}</span>
                    <span v-if="record.displayName" class="muted small ellipsis">@{{ record.handle }}</span>
                  </router-link>
                </template>
                <template v-else-if="column.key === 'owner'">{{ record.ownerName ?? '—' }}</template>
                <template v-else-if="column.key === 'followers'"><span class="num">{{ approx(record, 'followers') }}{{ num(record.latest?.followers) }}</span></template>
                <template v-else-if="column.key === 'change'">
                  <span :class="['num', (record.range.followersGained ?? 0) > 0 ? 'up' : (record.range.followersGained ?? 0) < 0 ? 'down' : '']">{{ signed(record.range.followersGained) }}</span>
                </template>
                <template v-else-if="column.key === 'following'"><span class="num">{{ approx(record, 'following') }}{{ num(record.latest?.following) }}</span></template>
                <template v-else-if="column.key === 'check'">
                  <template v-if="record.lastCheck">
                    <a-tag v-if="record.lastCheck.code" :color="CHECK_COLOR[record.lastCheck.code]">{{ checkText(record.lastCheck.code) }}</a-tag>
                    <span class="muted small">{{ fmtDateTime(record.lastCheck.at) }}</span>
                  </template>
                  <span v-else class="muted small">{{ t('social.notChecked') }}</span>
                </template>
              </template>
            </a-table>
          </a-card>
        </a-col>
      </a-row>
    </a-spin>

    <!-- system status (admin only, one line; not part of a user's view) -->
    <SystemStatus v-if="auth.isAdmin && !asUser" class="system" />
  </PageContainer>
</template>

<style scoped>
.system { margin-top: var(--cp-gap); }
.card { height: 100%; }
.grid-states { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 4px; }
.grid-kpi { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 4px; }
@media (max-width: 900px) { .grid-kpi { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
@media (max-width: 480px) { .grid-kpi, .grid-states { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
.empty { padding: 16px 0; }
.hint { margin-top: 8px; }
.list-title { margin: 12px 0 6px; font-weight: 600; color: var(--cp-text-secondary); font-size: 13px; }
.row { display: flex; align-items: center; gap: 8px; padding: 3px 4px; color: inherit; border-radius: 4px; }
.link-row:hover { background: var(--cp-bg-hover); }
.row .ellipsis { flex: 1; }
.acct { display: inline-flex; align-items: center; gap: 6px; max-width: 100%; color: inherit; }
.num { font-variant-numeric: tabular-nums; }
.up { color: var(--cp-success); }
.down { color: var(--cp-error); }
</style>
