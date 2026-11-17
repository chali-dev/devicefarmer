<script setup lang="ts">
import { dateLocale } from '../i18n'
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { message } from 'ant-design-vue'
import { LeftOutlined, RightOutlined } from '@ant-design/icons-vue'
import dayjs, { type Dayjs } from 'dayjs'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { queryParam } from '../api/query'
import { api, codeText, errorText } from '../api/client'
import { PUBLISH_STATUS_COLOR, type ManagedUser, type PublishPlatform, type PublishStatus, type PublishTaskItem } from '../api/types'
import PublishTaskDrawer from '../components/publish/PublishTaskDrawer.vue'
import PlatformTag from '../components/social/PlatformTag.vue'
import { useAuthStore } from '../stores/auth'
import { useInstancesStore } from '../stores/instances'

/** Publish scheduler (定时发布): week calendar, pending queue, history. */
const { t } = useI18n()
const auth = useAuthStore()
const store = useInstancesStore()
const route = useRoute()
const router = useRouter()

type Tab = 'calendar' | 'queue' | 'history'
const TABS: Tab[] = ['calendar', 'queue', 'history']
const tab = computed<Tab>({
  get: () => (TABS.includes(route.query.tab as Tab) ? (route.query.tab as Tab) : 'calendar'),
  set: (v) => { void router.replace({ query: { ...route.query, tab: v } }) },
})
const QUEUE: PublishStatus[] = ['pending', 'scheduled', 'running', 'awaiting_operator']
const HISTORY: PublishStatus[] = ['published', 'failed', 'cancelled']

const platforms = ref<PublishPlatform[]>([])
const users = ref<ManagedUser[]>([])
const filters = reactive({ q: '', platform: undefined as string | undefined, ownerId: undefined as string | undefined, status: queryParam<PublishStatus>(route.query, 'status') })
const contentId = computed(() => (typeof route.query.contentId === 'string' ? route.query.contentId : undefined))
const fmt = (d: string | null) => (d ? new Date(d).toLocaleString(dateLocale()) : '—')
const statusText = (s: string) => t(`publish.status.${s}`)

function baseParams(): URLSearchParams {
  const p = new URLSearchParams()
  if (filters.q.trim()) p.set('q', filters.q.trim())
  if (filters.platform) p.set('platform', filters.platform)
  if (filters.ownerId) p.set('ownerId', filters.ownerId)
  if (contentId.value) p.set('contentId', contentId.value)
  return p
}

// ---------------------------------------------------------------- calendar
// One week at a time (the owner wants the schedule by week, not by month).
const cursor = ref<Dayjs>(dayjs())
const calItems = ref<PublishTaskItem[]>([])
const calLoading = ref(false)
const range = computed(() => ({ from: cursor.value.startOf('week'), to: cursor.value.endOf('week').add(1, 'millisecond') }))
const weekDays = computed(() => Array.from({ length: 7 }, (_, i) => range.value.from.add(i, 'day')))
async function loadCalendar() {
  calLoading.value = true
  try {
    const p = baseParams()
    p.set('from', range.value.from.toISOString()); p.set('to', range.value.to.toISOString()); p.set('sort', 'scheduled_asc'); p.set('limit', '500')
    calItems.value = (await api<{ items: PublishTaskItem[] }>('GET', `/api/publish/tasks?${p}`)).items
  } catch (e) { message.error(errorText(e)) } finally { calLoading.value = false }
}
const dayItems = (d: Dayjs) => calItems.value.filter((x) => dayjs(x.scheduledAt).isSame(d, 'day'))
function shift(n: number) { cursor.value = cursor.value.add(n, 'week') }
watch(cursor, () => { if (tab.value === 'calendar') void loadCalendar() })

// ---------------------------------------------------------------- queue / history
const items = ref<PublishTaskItem[]>([])
const total = ref(0)
const byStatus = ref<Partial<Record<PublishStatus, number>>>({})
const loading = ref(false)
const page = reactive({ current: 1, pageSize: 20 })
async function loadList() {
  loading.value = true
  try {
    const p = baseParams()
    const statuses = tab.value === 'queue' ? QUEUE : HISTORY
    p.set('status', (filters.status && statuses.includes(filters.status) ? [filters.status] : statuses).join(','))
    p.set('sort', tab.value === 'queue' ? 'scheduled_asc' : 'updated_desc')
    p.set('limit', String(page.pageSize)); p.set('offset', String((page.current - 1) * page.pageSize))
    const r = await api<{ items: PublishTaskItem[]; total: number; byStatus: Record<PublishStatus, number> }>('GET', `/api/publish/tasks?${p}`)
    items.value = r.items; total.value = r.total; byStatus.value = r.byStatus
  } catch (e) { message.error(errorText(e)) } finally { loading.value = false }
}
function load() { return tab.value === 'calendar' ? loadCalendar() : loadList() }
const search = () => { page.current = 1; void load() }
function reset() {
  Object.assign(filters, { q: '', platform: undefined, ownerId: undefined, status: undefined })
  if (contentId.value) void router.replace({ query: { ...route.query, contentId: undefined } })
  else search()
}
watch(tab, () => { filters.status = undefined; page.current = 1; void load() })
watch(contentId, () => search())

const columns = computed(() => [
  { title: t('publish.colTime'), key: 'time', width: 170 },
  { title: t('publish.colAccount'), key: 'account', width: 220 },
  { title: t('publish.colContent'), key: 'content' },
  { title: t('common.status'), key: 'status', width: 130 },
  ...(tab.value === 'history' ? [{ title: t('publish.result'), key: 'result' }] : [{ title: t('common.device'), key: 'device', width: 160 }]),
  ...(auth.isAdmin ? [{ title: t('content.colOwner'), key: 'owner', width: 100 }] : []),
  { title: t('common.action'), key: 'action', width: 90 },
])

// ---------------------------------------------------------------- drawer + live updates
const drawerOpen = ref(false)
const drawerId = ref<string | null>(null)
const drawer = ref<InstanceType<typeof PublishTaskDrawer>>()
function openTask(id: string) { drawerId.value = id; drawerOpen.value = true }
watch(() => route.query.task, (id) => { if (typeof id === 'string') openTask(id) }, { immediate: true })
watch(drawerOpen, (o) => { if (!o && route.query.task) void router.replace({ query: { ...route.query, task: undefined } }) })

let timer: ReturnType<typeof setTimeout> | null = null
const off = store.onTaskEvent((ev) => {
  if (ev.type !== 'task.updated' || ev.task.type !== 'publish') return
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    void load()
    if (drawerOpen.value && ev.task.refId === drawerId.value) void drawer.value?.reload()
  }, 400)
})
onBeforeUnmount(() => { off(); if (timer) clearTimeout(timer) })

onMounted(async () => {
  void load()
  try {
    platforms.value = (await api<{ platforms: PublishPlatform[] }>('GET', '/api/publish/platforms')).platforms
    if (auth.isAdmin) users.value = (await api<{ users: ManagedUser[] }>('GET', '/api/users')).users
  } catch (e) { message.error(errorText(e)) }
})
const errText = (x: PublishTaskItem) => (x.errorCode ? codeText(x.errorCode, undefined, x.error ?? x.errorCode) : '')
</script>

<template>
  <a-card :title="t('publish.title')" size="small">
    <template #extra><a-button @click="router.push('/content')">{{ t('publish.toContent') }}</a-button></template>
    <a-space wrap style="margin-bottom: 8px">
      <a-input-search v-model:value="filters.q" :placeholder="t('publish.searchPlaceholder')" allow-clear style="width: 220px" @search="search" />
      <a-select v-model:value="filters.platform" :placeholder="t('publish.platform')" allow-clear style="width: 130px" @change="search">
        <a-select-option v-for="p in platforms" :key="p.id" :value="p.id">{{ p.name }}</a-select-option>
      </a-select>
      <a-select v-if="tab !== 'calendar'" v-model:value="filters.status" :placeholder="t('common.status')" allow-clear style="width: 140px" @change="search">
        <a-select-option v-for="s in (tab === 'queue' ? QUEUE : HISTORY)" :key="s" :value="s">{{ statusText(s) }} ({{ byStatus[s] ?? 0 }})</a-select-option>
      </a-select>
      <a-select v-if="auth.isAdmin" v-model:value="filters.ownerId" :placeholder="t('content.colOwner')" allow-clear show-search option-filter-prop="label" style="width: 140px"
        :options="users.map((u) => ({ value: u.id, label: u.username }))" @change="search" />
      <a-tag v-if="contentId" closable @close="reset">{{ t('publish.filteredByContent') }}</a-tag>
      <a-button @click="reset">{{ t('common.reset') }}</a-button>
    </a-space>

    <a-tabs v-model:active-key="tab">
      <a-tab-pane key="calendar" :tab="t('publish.tabs.calendar')">
        <a-space style="margin-bottom: 8px" wrap>
          <a-button size="small" :aria-label="t('publish.prev')" @click="shift(-1)"><LeftOutlined /></a-button>
          <a-button size="small" @click="cursor = dayjs()">{{ t('publish.today') }}</a-button>
          <a-button size="small" :aria-label="t('publish.next')" @click="shift(1)"><RightOutlined /></a-button>
          <b>{{ `${weekDays[0]!.format('YYYY-MM-DD')} – ${weekDays[6]!.format('MM-DD')}` }}</b>
        </a-space>
        <a-spin :spinning="calLoading">
          <div class="week">
            <div v-for="d in weekDays" :key="d.valueOf()" class="day" :class="{ today: d.isSame(dayjs(), 'day') }">
              <div class="day-head">{{ d.format('ddd MM-DD') }}</div>
              <div v-for="x in dayItems(d)" :key="x.id" class="card" role="button" tabindex="0" @click="openTask(x.id)" @keydown.enter="openTask(x.id)">
                <div>{{ dayjs(x.scheduledAt).format('HH:mm') }} <PlatformTag :platform="x.platform" /></div>
                <div class="ellipsis">@{{ x.account?.handle }}</div>
                <div class="ellipsis muted">{{ x.content?.title }}</div>
                <a-tag :color="PUBLISH_STATUS_COLOR[x.status]">{{ statusText(x.status) }}</a-tag>
              </div>
              <div v-if="!dayItems(d).length" class="muted empty">—</div>
            </div>
          </div>
        </a-spin>
      </a-tab-pane>
      <a-tab-pane v-for="k in (['queue', 'history'] as const)" :key="k" :tab="t(`publish.tabs.${k}`)">
        <a-table :data-source="items" :columns="columns" row-key="id" size="small" :loading="loading" :scroll="{ x: 960 }"
          :pagination="{ current: page.current, pageSize: page.pageSize, total, showSizeChanger: true, showTotal: (n: number) => t('content.total', { n }) }"
          @change="(p: any) => { page.current = p.current; page.pageSize = p.pageSize; loadList() }">
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'time'">{{ fmt(record.status === 'published' ? record.publishedAt : record.scheduledAt) }}</template>
            <template v-else-if="column.key === 'account'"><PlatformTag :platform="record.platform" /> @{{ record.account?.handle ?? '—' }}</template>
            <template v-else-if="column.key === 'content'">{{ record.content?.title ?? '—' }}</template>
            <template v-else-if="column.key === 'status'">
              <a-tag :color="PUBLISH_STATUS_COLOR[record.status as PublishStatus]">{{ statusText(record.status) }}</a-tag>
              <div v-if="record.status === 'pending' && record.errorCode" class="err">{{ errText(record) }}</div>
            </template>
            <template v-else-if="column.key === 'device'">
              <template v-if="record.instance"><a-badge :status="record.instance.online ? 'success' : 'default'" />{{ record.instance.name }}</template>
              <span v-else class="muted">—</span>
            </template>
            <template v-else-if="column.key === 'result'">
              <a v-if="record.url" :href="record.url" target="_blank" rel="noopener noreferrer">{{ t('publish.viewPost') }}</a>
              <span v-else-if="record.externalId">{{ record.externalId }}</span>
              <span v-else-if="record.errorCode" class="err">{{ errText(record) }}<template v-if="record.errorCode === 'publish.operator_failed' && record.error">: {{ record.error }}</template></span>
            </template>
            <template v-else-if="column.key === 'owner'">{{ record.ownerName ?? '—' }}</template>
            <template v-else-if="column.key === 'action'"><a @click="openTask(record.id)">{{ record.status === 'awaiting_operator' ? t('publish.handle') : t('common.view') }}</a></template>
          </template>
        </a-table>
      </a-tab-pane>
    </a-tabs>
  </a-card>
  <PublishTaskDrawer ref="drawer" v-model:open="drawerOpen" :task-id="drawerId" @changed="load" />
</template>

<style scoped>
.cell-list { font-size: 12px; }
.ev { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; cursor: pointer; border-radius: 3px; padding: 0 2px; }
.ev:hover { background: var(--cp-bg-hover); }
.more { color: var(--cp-primary); cursor: pointer; }
.week { display: grid; grid-template-columns: repeat(7, minmax(120px, 1fr)); gap: 6px; overflow-x: auto; }
.day { border: 1px solid var(--cp-border-secondary); border-radius: 6px; padding: 6px; min-height: 240px; }
.day.today { border-color: var(--cp-primary); }
.day-head { font-weight: 600; margin-bottom: 6px; }
.card { border: 1px solid var(--cp-border-secondary); border-radius: 4px; padding: 4px 6px; margin-bottom: 6px; cursor: pointer; font-size: 12px; }
.card:hover { background: var(--cp-bg-hover); }
.ellipsis { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.muted { color: var(--cp-text-tertiary); }
.err { color: var(--cp-error); font-size: 12px; }
.empty { text-align: center; }
</style>
