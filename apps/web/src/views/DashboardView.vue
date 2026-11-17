<script setup lang="ts">
import { dateLocale } from '../i18n'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { MobileOutlined, ReloadOutlined, ScheduleOutlined, SendOutlined, TeamOutlined } from '@ant-design/icons-vue'
import { useI18n } from 'vue-i18n'
import { api, errorText } from '../api/client'
import {
  compactNumber, dayTs, POST_TYPES, taskStatusText, taskText, trackedHandle,
  type DashboardResponse, type DashboardUserRow, type ManagedUser,
} from '../api/types'
import { fmtSize } from '../components/media/media'
import StatLink from '../components/dashboard/StatLink.vue'
import PageContainer from '../components/common/PageContainer.vue'
import StatCard from '../components/common/StatCard.vue'
import { pagination } from '../components/common/ui'
import PlatformTag from '../components/social/PlatformTag.vue'
import LineChart from '../components/tracked/LineChart.vue'
import { useAuthStore } from '../stores/auth'
import { useInstancesStore } from '../stores/instances'

/**
 * Dashboard (概览): GET /api/dashboard, RBAC-scoped on the server. Each number links to the list page
 * with the matching filter. Refreshes on task/device events (debounced) and every 30 s.
 */
const { t } = useI18n()
const auth = useAuthStore()
const store = useInstancesStore()

const data = ref<DashboardResponse | null>(null)
const loading = ref(false)
const error = ref<string | null>(null)
const users = ref<ManagedUser[]>([])
const asUser = ref<string | undefined>(undefined)
const tz = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' } catch { return 'UTC' } })()

async function load() {
  loading.value = true
  try {
    const p = new URLSearchParams({ tz })
    if (asUser.value) p.set('userId', asUser.value)
    data.value = await api<DashboardResponse>('GET', `/api/dashboard?${p}`)
    error.value = null
  } catch (e) { error.value = errorText(e) }
  finally { loading.value = false }
}
watch(asUser, () => void load())

// Live refresh: debounce bursts of events; never more often than every 3 s.
let timer: ReturnType<typeof setTimeout> | null = null
let lastLoad = 0
function scheduleLoad() {
  if (timer) return
  const wait = Math.max(800, 3000 - (Date.now() - lastLoad))
  timer = setTimeout(() => { timer = null; lastLoad = Date.now(); void load() }, wait)
}
const off = store.onTaskEvent((ev) => { if (ev.type === 'task.updated') scheduleLoad() })
// Device status changes (instance.updated / deleted) only matter when the status counts change.
const statusSig = computed(() => store.list.map((i) => `${i.id}:${i.status}:${i.adbState}`).join('|'))
watch(statusSig, () => scheduleLoad())
let poll: ReturnType<typeof setInterval> | null = null
onMounted(() => {
  lastLoad = Date.now()
  void load()
  poll = setInterval(() => { if (document.visibilityState === 'visible') void load() }, 30_000)
  if (auth.isAdmin) void api<{ users: ManagedUser[] }>('GET', '/api/users').then((r) => { users.value = r.users }).catch(() => undefined)
})
onBeforeUnmount(() => { off(); if (timer) clearTimeout(timer); if (poll) clearInterval(poll) })

const w = computed(() => data.value?.widgets ?? {})
const has = (k: string) => !!data.value?.order.includes(k)
const fmtTime = (s: string | null) => (s ? new Date(s).toLocaleString(dateLocale()) : '—')
const trendPoints = computed(() => (w.value.publishing?.trend ?? []).map((r) => ({ t: dayTs(r.day), v: r.published })))
const trendFailed = computed(() => (w.value.publishing?.trend ?? []).reduce((s, r) => s + r.failed, 0))
const trendPublished = computed(() => (w.value.publishing?.trend ?? []).reduce((s, r) => s + r.published, 0))
const shortDay = (ts: number) => new Date(ts).toLocaleDateString(undefined, { month: '2-digit', day: '2-digit' })
const entries = (o: Record<string, number> | undefined) => Object.entries(o ?? {}).sort((a, b) => b[1] - a[1])
const userOptions = computed(() => users.value.map((u) => ({ value: u.id, label: u.username })))

const userColumns = computed(() => [
  { title: t('common.username'), key: 'username', dataIndex: 'username' },
  { title: t('dashboard.colDevices'), dataIndex: 'devices', key: 'devices', align: 'right' as const },
  { title: t('dashboard.colSocial'), dataIndex: 'socialAccounts', key: 'socialAccounts', align: 'right' as const },
  { title: t('dashboard.colExceptions'), dataIndex: 'exceptions', key: 'exceptions', align: 'right' as const },
  { title: t('dashboard.colTracked'), dataIndex: 'trackedAccounts', key: 'trackedAccounts', align: 'right' as const },
  { title: t('dashboard.colContents'), dataIndex: 'contents', key: 'contents', align: 'right' as const },
  { title: t('dashboard.colPublished7d'), dataIndex: 'published7d', key: 'published7d', align: 'right' as const },
  { title: t('dashboard.colFailed7d'), dataIndex: 'failed7d', key: 'failed7d', align: 'right' as const },
  { title: t('dashboard.colAwaiting'), dataIndex: 'awaitingOperator', key: 'awaitingOperator', align: 'right' as const },
  { title: '', key: 'view', width: 90 },
])
/** KPI row on top (Ant Design Pro analysis layout): one headline number per main module, linking to its list. */
const kpis = computed(() => {
  const x = w.value
  const out: { key: string; title: string; value: number; suffix?: string; footer: string; to: string | { path: string; query: Record<string, string> }; icon: typeof MobileOutlined }[] = []
  if (x.devices) out.push({ key: 'devices', title: t('dashboard.kpi.devices'), value: x.devices.running, suffix: `/ ${x.devices.total}`, icon: MobileOutlined,
    footer: t('dashboard.devicesOnline', { n: x.devices.online, stopped: x.devices.stopped }), to: '/instances' })
  if (x.social) out.push({ key: 'social', title: t('dashboard.w.social'), value: x.social.total, icon: TeamOutlined,
    footer: `${t('dashboard.exceptions')} ${x.social.exceptions} · ${t('dashboard.connConnected')} ${x.social.connections.connected}`, to: '/social' })
  if (x.publishing) out.push({ key: 'publishing', title: t('dashboard.published7d'), value: x.publishing.published7d, icon: SendOutlined,
    footer: `${t('dashboard.failed7d')} ${x.publishing.failed7d} · ${t('dashboard.upcoming7d')} ${x.publishing.upcoming7d}`, to: { path: '/publish', query: { tab: 'history', status: 'published' } } })
  if (x.tasks) out.push({ key: 'tasks', title: t('dashboard.kpi.tasks'), value: x.tasks.last24h.total, icon: ScheduleOutlined,
    footer: `${taskStatusText('running')} ${x.tasks.last24h.running} · ${taskStatusText('failed')} ${x.tasks.last24h.failed}`, to: '/tasks' })
  return out
})
const viewAs = (u: DashboardUserRow) => { asUser.value = u.id; window.scrollTo({ top: 0, behavior: 'smooth' }) }
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
      <a-row v-if="kpis.length" :gutter="[16, 16]" class="kpis">
        <a-col v-for="k in kpis" :key="k.key" :xs="24" :sm="12" :xl="6">
          <StatCard :title="k.title" :value="k.value" :suffix="k.suffix" :icon="k.icon" :footer="k.footer" :to="k.to" />
        </a-col>
      </a-row>
      <a-row :gutter="[16, 16]">
        <!-- devices -->
        <a-col v-if="w.devices" :xs="24" :md="12" :xl="8">
          <a-card size="small" :bordered="false" :title="t('dashboard.w.devices')" class="card">
            <template #extra><router-link to="/instances">{{ t('dashboard.viewAll') }}</router-link></template>
            <div class="grid4">
              <StatLink :label="t('devices.total')" :value="w.devices.total" to="/instances" />
              <StatLink :label="t('devices.running')" :value="w.devices.running" :to="{ path: '/instances', query: { status: 'running' } }" tone="success" />
              <StatLink :label="t('devices.busy')" :value="w.devices.busy" :to="{ path: '/instances', query: { status: 'busy' } }" />
              <StatLink :label="t('devices.error')" :value="w.devices.error" :to="{ path: '/instances', query: { status: 'error' } }" tone="error" />
            </div>
            <div class="sub muted">
              {{ t('dashboard.devicesOnline', { n: w.devices.online, stopped: w.devices.stopped }) }}
            </div>
            <div v-if="w.devices.capacity" class="sub">
              <template v-if="w.devices.capacity.freeMb !== null">
                {{ t('dashboard.capacity', { mb: w.devices.capacity.freeMb }) }}
                <span v-for="f in w.devices.capacity.fits" :key="f.profile" class="muted fit">{{ t('dashboard.fits', { profile: f.profile, n: f.count }) }}</span>
              </template>
              <span v-else class="muted">{{ t('dashboard.capacityUnknown') }}</span>
            </div>
          </a-card>
        </a-col>

        <!-- proxy pool (admin) -->
        <a-col v-if="w.proxies" :xs="24" :md="12" :xl="8">
          <a-card size="small" :bordered="false" :title="t('dashboard.w.proxies')" class="card">
            <template #extra><router-link to="/proxies">{{ t('dashboard.viewAll') }}</router-link></template>
            <div class="grid4">
              <StatLink :label="t('dashboard.proxyTotal')" :value="w.proxies.total" to="/proxies" />
              <StatLink :label="t('dashboard.proxyFree')" :value="w.proxies.free" :to="{ path: '/proxies', query: { bound: 'free' } }" />
              <StatLink :label="t('dashboard.proxyBound')" :value="w.proxies.bound" :to="{ path: '/proxies', query: { bound: 'bound' } }" />
              <StatLink :label="t('dashboard.proxyFailed')" :value="w.proxies.failed" :to="{ path: '/proxies', query: { status: 'failed' } }" tone="error" />
            </div>
            <div class="sub muted">{{ t('dashboard.proxyUsable', { n: w.proxies.freeUsable, unchecked: w.proxies.unchecked }) }}</div>
          </a-card>
        </a-col>

        <!-- social accounts -->
        <a-col v-if="w.social" :xs="24" :md="12" :xl="8">
          <a-card size="small" :bordered="false" :title="t('dashboard.w.social')" class="card">
            <template #extra><router-link to="/social">{{ t('dashboard.viewAll') }}</router-link></template>
            <div class="grid4">
              <StatLink :label="t('dashboard.accounts')" :value="w.social.total" to="/social" />
              <StatLink :label="t('dashboard.exceptions')" :value="w.social.exceptions" :to="{ path: '/social', query: { exception: '1' } }" tone="error" />
              <StatLink :label="t('dashboard.connConnected')" :value="w.social.connections.connected" to="/social" tone="success" />
              <StatLink :label="t('dashboard.connExpired')" :value="w.social.connections.expired + w.social.connections.revoked + w.social.connections.error" to="/social" tone="warning" />
            </div>
            <div class="tags">
              <router-link v-for="[p, c] in entries(w.social.byPlatform)" :key="p" :to="{ path: '/social', query: { platform: p } }" class="tag-link">
                <PlatformTag :platform="p" /> {{ c }}
              </router-link>
            </div>
            <div class="tags">
              <router-link v-for="[s, c] in entries(w.social.byLogin)" :key="s" :to="{ path: '/social', query: { loginStatus: s } }" class="tag-link">
                <a-tag>{{ t(`social.login.${s}`) }} {{ c }}</a-tag>
              </router-link>
            </div>
          </a-card>
        </a-col>

        <!-- tracked accounts -->
        <a-col v-if="w.tracked" :xs="24" :md="12" :xl="8">
          <a-card size="small" :bordered="false" :title="t('dashboard.w.tracked')" class="card">
            <template #extra><router-link to="/tracked">{{ t('dashboard.viewAll') }}</router-link></template>
            <div class="grid4">
              <StatLink :label="t('dashboard.accounts')" :value="w.tracked.total" to="/tracked" />
              <StatLink :label="t('tracked.status.active')" :value="w.tracked.byStatus.active ?? 0" :to="{ path: '/tracked', query: { status: 'active' } }" />
              <StatLink :label="t('tracked.status.paused')" :value="w.tracked.byStatus.paused ?? 0" :to="{ path: '/tracked', query: { status: 'paused' } }" />
              <StatLink :label="t('tracked.status.error')" :value="w.tracked.byStatus.error ?? 0" :to="{ path: '/tracked', query: { status: 'error' } }" tone="error" />
            </div>
            <div class="list-title">{{ t('dashboard.topGainers') }}</div>
            <div v-if="!w.tracked.topGainers.length" class="muted small">{{ t('dashboard.noGainers') }}</div>
            <div v-for="g in w.tracked.topGainers" :key="g.id" class="row">
              <PlatformTag :platform="g.platform" icon-only />
              <span class="ellipsis">{{ g.displayName || trackedHandle(g) }}</span>
              <span class="gain">+{{ compactNumber(g.gain) }}</span>
              <span class="muted small">{{ compactNumber(g.followers) }}</span>
            </div>
          </a-card>
        </a-col>

        <!-- account analytics (账号分析) -->
        <a-col v-if="w.analytics" :xs="24" :md="12" :xl="8">
          <a-card size="small" :bordered="false" :title="t('dashboard.w.analytics')" class="card">
            <template #extra><router-link to="/analytics">{{ t('dashboard.viewAll') }}</router-link></template>
            <div class="grid3">
              <StatLink :label="t('analytics.metrics.followers')" :value="compactNumber(w.analytics.followers)" to="/analytics" />
              <StatLink :label="t('analytics.gained7d')" :value="w.analytics.followersGained7d === null ? '—' : `${w.analytics.followersGained7d > 0 ? '+' : ''}${compactNumber(w.analytics.followersGained7d)}`" to="/analytics" />
              <StatLink :label="t('analytics.views7d')" :value="compactNumber(w.analytics.views7d)" to="/analytics" />
              <StatLink :label="t('analytics.likes7d')" :value="compactNumber(w.analytics.likes7d)" to="/analytics" />
              <StatLink :label="t('analytics.comments7d')" :value="compactNumber(w.analytics.comments7d)" to="/analytics" />
              <StatLink :label="t('analytics.shares7d')" :value="compactNumber(w.analytics.shares7d)" to="/analytics" />
            </div>
            <LineChart :points="w.analytics.trend.map((d) => ({ t: dayTs(d.day), v: d.followersGained }))" :height="110" :format-time="shortDay" :format="compactNumber" :aria-label="t('analytics.perDay.followersGained')" />
            <div v-for="g in w.analytics.top" :key="g.id" class="row">
              <PlatformTag :platform="g.platform" icon-only />
              <span class="ellipsis">{{ g.displayName || `@${g.handle}` }}</span>
              <span class="gain">+{{ compactNumber(g.gain) }}</span>
              <span class="muted small">{{ compactNumber(g.followers) }}</span>
            </div>
          </a-card>
        </a-col>

        <!-- task centre -->
        <a-col v-if="w.tasks" :xs="24" :md="12" :xl="8">
          <a-card size="small" :bordered="false" :title="t('dashboard.w.tasks')" class="card">
            <template #extra><router-link to="/tasks">{{ t('dashboard.viewAll') }}</router-link></template>
            <div class="muted small">{{ t('dashboard.last24h', { n: w.tasks.last24h.total }) }}</div>
            <div class="grid3">
              <StatLink v-for="s in (['running', 'pending', 'scheduled', 'success', 'failed', 'cancelled'] as const)" :key="s"
                :label="taskStatusText(s)" :value="w.tasks.last24h[s]" :to="{ path: '/tasks', query: { status: s } }"
                :tone="s === 'failed' ? 'error' : undefined" />
            </div>
            <div class="list-title">{{ t('dashboard.recentFailures') }}</div>
            <div v-if="!w.tasks.recentFailures.length" class="muted small">{{ t('dashboard.noFailures') }}</div>
            <router-link v-for="f in w.tasks.recentFailures" :key="f.id" :to="{ path: '/tasks', query: { task: f.id } }" class="row link-row">
              <span class="ellipsis">{{ taskText(f.type) }}<template v-if="f.label"> · {{ f.label }}</template></span>
              <span class="muted small">{{ fmtTime(f.finishedAt ?? f.createdAt) }}</span>
            </router-link>
          </a-card>
        </a-col>

        <!-- comments & engagement -->
        <a-col v-if="w.comments" :xs="24" :md="12" :xl="8">
          <a-card size="small" :bordered="false" :title="t('dashboard.w.comments')" class="card">
            <template #extra><router-link to="/comments">{{ t('dashboard.viewAll') }}</router-link></template>
            <div class="grid4">
              <StatLink :label="t('dashboard.commentsUnread')" :value="w.comments.unread" :to="{ path: '/comments', query: { status: 'new' } }" />
              <StatLink :label="t('dashboard.commentsReview')" :value="w.comments.pendingReview" :to="{ path: '/comments', query: { tab: 'review' } }" />
              <StatLink :label="t('dashboard.commentsOperator')" :value="w.comments.awaitingOperator" :to="{ path: '/comments', query: { tab: 'queue' } }" />
              <StatLink :label="t('dashboard.commentsQueued')" :value="w.comments.queued" :to="{ path: '/comments', query: { tab: 'queue' } }" />
            </div>
            <div class="sub muted">{{ t('dashboard.commentsRecent', { total: w.comments.total, sent: w.comments.sent7d, failed: w.comments.failed7d }) }}</div>
          </a-card>
        </a-col>

        <!-- trending (public chart data) -->
        <a-col v-if="w.trending" :xs="24" :md="12" :xl="8">
          <a-card size="small" :bordered="false" :title="t('trending.title')" class="card">
            <template #extra><router-link to="/trending">{{ t('dashboard.viewAll') }}</router-link></template>
            <div class="muted small">{{ t('trending.widgetTop', { region: w.trending.region }) }} · {{ fmtTime(w.trending.capturedAt) }}</div>
            <a v-for="x in w.trending.top" :key="x.videoId" :href="x.url" target="_blank" rel="noopener noreferrer" class="row link-row">
              <span class="muted small">{{ x.rank }}</span>
              <span class="ellipsis">{{ x.title || x.videoId }}</span>
              <span class="muted small">{{ compactNumber(x.views) }}</span>
            </a>
          </a-card>
        </a-col>

        <!-- media -->
        <a-col v-if="w.media" :xs="24" :md="12" :xl="8">
          <a-card size="small" :bordered="false" :title="t('dashboard.w.media')" class="card">
            <template #extra><router-link to="/media">{{ t('dashboard.viewAll') }}</router-link></template>
            <div class="grid4">
              <StatLink :label="t('dashboard.mediaPublic')" :value="w.media.public.count" :to="{ path: '/media', query: { tab: 'public' } }" />
              <StatLink :label="t('dashboard.mediaPublicSize')" :value="fmtSize(w.media.public.bytes)" :to="{ path: '/media', query: { tab: 'public' } }" />
              <StatLink :label="data?.scope.admin ? t('dashboard.mediaPrivateAll') : t('dashboard.mediaMine')" :value="w.media.private.count" :to="{ path: '/media', query: { tab: 'mine' } }" />
              <StatLink :label="t('dashboard.mediaPrivateSize')" :value="fmtSize(w.media.private.bytes)" :to="{ path: '/media', query: { tab: 'mine' } }" />
            </div>
            <div class="sub muted">
              {{ t('dashboard.mediaKinds', { images: w.media.public.images + w.media.private.images, videos: w.media.public.videos + w.media.private.videos }) }}
              <template v-if="w.media.processing || w.media.failed"> · {{ t('dashboard.mediaPending', { processing: w.media.processing, failed: w.media.failed }) }}</template>
            </div>
          </a-card>
        </a-col>

        <!-- content + publishing -->
        <a-col v-if="w.publishing" :xs="24">
          <a-card size="small" :bordered="false" :title="t('dashboard.w.publishing')" class="card">
            <template #extra>
              <a-space>
                <router-link to="/content">{{ t('nav.content') }}</router-link>
                <router-link to="/publish">{{ t('nav.publish') }}</router-link>
              </a-space>
            </template>
            <a-row :gutter="[16, 16]">
              <a-col :xs="24" :lg="10">
                <div class="grid3">
                  <StatLink :label="t('dashboard.upcoming7d')" :value="w.publishing.upcoming7d" :to="{ path: '/publish', query: { tab: 'queue' } }" />
                  <StatLink :label="t('dashboard.published7d')" :value="w.publishing.published7d" :to="{ path: '/publish', query: { tab: 'history', status: 'published' } }" tone="success" />
                  <StatLink :label="t('dashboard.failed7d')" :value="w.publishing.failed7d" :to="{ path: '/publish', query: { tab: 'history', status: 'failed' } }" tone="error" />
                  <StatLink :label="t('dashboard.awaitingOperator')" :value="w.publishing.awaitingOperator" :to="{ path: '/publish', query: { tab: 'queue', status: 'awaiting_operator' } }" tone="warning" />
                  <StatLink :label="t('dashboard.publishRunning')" :value="w.publishing.running" :to="{ path: '/publish', query: { tab: 'queue', status: 'running' } }" />
                  <StatLink :label="t('dashboard.contents')" :value="w.publishing.contents.total" to="/content" />
                </div>
                <div class="tags">
                  <router-link v-for="[s, c] in entries(w.publishing.contents.byStatus)" :key="s" :to="{ path: '/content', query: { status: s } }" class="tag-link">
                    <a-tag>{{ t(`content.status.${s}`) }} {{ c }}</a-tag>
                  </router-link>
                </div>
                <div class="list-title">{{ t('dashboard.nextUp') }}</div>
                <div v-if="!w.publishing.next.length" class="muted small">{{ t('dashboard.nothingScheduled') }}</div>
                <router-link v-for="x in w.publishing.next" :key="x.id" :to="{ path: '/publish', query: { tab: 'queue', task: x.id } }" class="row link-row">
                  <span class="muted small nowrap">{{ fmtTime(x.scheduledAt) }}</span>
                  <PlatformTag :platform="x.platform" icon-only />
                  <span class="ellipsis">{{ x.title || '—' }}<template v-if="x.handle"> · @{{ x.handle }}</template></span>
                </router-link>
              </a-col>
              <a-col :xs="24" :lg="14">
                <div class="list-title">
                  {{ t('dashboard.trendTitle') }}
                  <span class="muted small">{{ t('dashboard.trendTotals', { published: trendPublished, failed: trendFailed }) }}</span>
                </div>
                <LineChart :points="trendPoints" :height="200" :format-time="shortDay" :aria-label="t('dashboard.trendTitle')" />
              </a-col>
            </a-row>
          </a-card>
        </a-col>

        <!-- today's publishing per post type -->
        <a-col v-if="w.publishToday" :xs="24" :lg="12">
          <a-card size="small" :bordered="false" :title="t('dashboard.w.publishToday')" class="card">
            <template #extra><router-link :to="{ path: '/publish', query: { tab: 'today' } }">{{ t('dashboard.viewAll') }}</router-link></template>
            <div class="grid3">
              <StatLink v-for="pt in POST_TYPES" :key="pt" :label="t(`publish.type.${pt}`)" :value="w.publishToday.byType[pt] ?? 0" :to="{ path: '/publish', query: { tab: 'today', postType: pt } }" />
            </div>
            <div class="muted small">
              {{ t('dashboard.todayTotal', { n: w.publishToday.total }) }} · {{ t('dashboard.todayPublished', { n: w.publishToday.byStatus.published ?? 0 }) }}
            </div>
          </a-card>
        </a-col>

        <!-- per-user breakdown (admin) -->
        <a-col v-if="w.perUser && has('perUser')" :xs="24">
          <a-card size="small" :bordered="false" :title="t('dashboard.w.perUser')" class="card">
            <a-table :data-source="w.perUser.users" :columns="userColumns" row-key="id" size="small" :pagination="w.perUser.users.length > 10 ? pagination({ defaultPageSize: 10 }) : false" :scroll="{ x: 900 }">
              <template #bodyCell="{ column, record }">
                <template v-if="column.key === 'username'">
                  {{ record.username }}
                  <a-tag v-if="record.role === 'admin'" color="blue">{{ t('roles.admin') }}</a-tag>
                  <a-tag v-if="record.disabled">{{ t('permissions.disabled') }}</a-tag>
                </template>
                <template v-else-if="column.key === 'view'">
                  <a-button size="small" type="link" @click="viewAs(record as DashboardUserRow)">{{ t('dashboard.viewAsUser') }}</a-button>
                </template>
              </template>
            </a-table>
          </a-card>
        </a-col>
      </a-row>
    </a-spin>
  </PageContainer>
</template>

<style scoped>
.kpis { margin-bottom: var(--cp-gap); }
.card { height: 100%; }
.grid4 { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 4px; }
.grid3 { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 4px; }
@media (max-width: 480px) { .grid4 { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
.sub { margin-top: 8px; font-size: 12px; }
.fit { margin-left: 8px; }
.tags { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.tag-link { color: inherit; }
.list-title { margin: 12px 0 6px; font-weight: 600; color: var(--cp-text-secondary); font-size: 13px; }
.row { display: flex; align-items: center; gap: 8px; padding: 3px 0; color: inherit; }
.link-row { border-radius: 4px; padding: 3px 4px; }
.link-row:hover { background: var(--cp-bg-hover); }
.row .ellipsis { flex: 1; }
.gain { color: var(--cp-success); font-weight: 600; font-variant-numeric: tabular-nums; }
</style>
