<script setup lang="ts">
import { message } from 'ant-design-vue'
import type { Dayjs } from 'dayjs'
import { onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'
import { api, errorText } from '../../api/client'
import { queryParam } from '../../api/query'
import type { ManagedUser, PublishStatus, PublishTaskItem, SocialAccount } from '../../api/types'
import { useAuthStore } from '../../stores/auth'
import { useInstancesStore } from '../../stores/instances'
import SearchBar from '../common/SearchBar.vue'
import PublishTaskDrawer from './PublishTaskDrawer.vue'
import PublishTaskTable from './PublishTaskTable.vue'

/**
 * 媒体管理 → 发文日志: every publish task of the viewer's accounts (admins: all, or one user's), newest change first,
 * filtered by account / status / date (a task's day = published, else due: the API's from/to). Same rows and drawer as
 * 排程发布; rescheduling, 编辑后重新发布 and recording the operator's result happen in the drawer.
 */
const { t } = useI18n()
const auth = useAuthStore()
const store = useInstancesStore()
const route = useRoute()

const STATUSES: PublishStatus[] = ['pending', 'scheduled', 'running', 'awaiting_operator', 'published', 'failed', 'cancelled']
const users = ref<ManagedUser[]>([])
const accounts = ref<SocialAccount[]>([])
const filters = reactive({
  q: '', ownerId: undefined as string | undefined,
  accountId: queryParam(route.query, 'account'), status: queryParam<PublishStatus>(route.query, 'status', STATUSES),
  range: null as [Dayjs, Dayjs] | null,
})
const items = ref<PublishTaskItem[]>([])
const total = ref(0)
const byStatus = ref<Partial<Record<PublishStatus, number>>>({})
const loading = ref(false)
const page = reactive({ current: 1, pageSize: 20 })

async function load() {
  loading.value = true
  try {
    const p = new URLSearchParams({ group: 'content', sort: 'updated_desc', limit: String(page.pageSize), offset: String((page.current - 1) * page.pageSize) })
    if (filters.q.trim()) p.set('q', filters.q.trim())
    if (filters.ownerId) p.set('ownerId', filters.ownerId)
    if (filters.accountId) p.set('accountId', filters.accountId)
    if (filters.status) p.set('status', filters.status)
    if (filters.range) { p.set('from', filters.range[0].startOf('day').toISOString()); p.set('to', filters.range[1].startOf('day').add(1, 'day').toISOString()) }
    const r = await api<{ items: PublishTaskItem[]; total: number; byStatus: Record<PublishStatus, number> }>('GET', `/api/publish/tasks?${p}`)
    items.value = r.items; total.value = r.total; byStatus.value = r.byStatus
  } catch (e) { message.error(errorText(e)) } finally { loading.value = false }
}
async function loadAccounts() {
  try {
    const q = new URLSearchParams({ pageSize: '200' })
    if (filters.ownerId) q.set('ownerId', filters.ownerId)
    accounts.value = (await api<{ items: SocialAccount[] }>('GET', `/api/social/accounts?${q}`)).items
  } catch { accounts.value = [] }
}
const search = () => { page.current = 1; void load() }
function reset() { Object.assign(filters, { q: '', ownerId: undefined, accountId: undefined, status: undefined, range: null }); void loadAccounts(); search() }
function onOwner() { filters.accountId = undefined; void loadAccounts(); search() }
function onChange(p: { current?: number; pageSize?: number }) { page.current = p.current ?? 1; page.pageSize = p.pageSize ?? page.pageSize; void load() }

const drawerOpen = ref(false)
const drawerId = ref<string | null>(null)
const drawer = ref<InstanceType<typeof PublishTaskDrawer>>()
function openTask(id: string) { drawerId.value = id; drawerOpen.value = true }

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
  void load(); void loadAccounts()
  if (auth.isAdmin) { try { users.value = (await api<{ users: ManagedUser[] }>('GET', '/api/users')).users } catch { /* filter only */ } }
})
</script>

<template>
  <div>
    <SearchBar :loading="loading" @reset="reset" @refresh="load">
      <a-input-search v-model:value="filters.q" :placeholder="t('publish.searchPlaceholder')" allow-clear style="width: 220px" @search="search" />
      <a-select v-if="auth.isAdmin" v-model:value="filters.ownerId" :placeholder="t('content.colOwner')" allow-clear show-search option-filter-prop="label" style="width: 140px"
        :options="users.map((u) => ({ value: u.id, label: u.username }))" @change="onOwner" />
      <a-select v-model:value="filters.accountId" :placeholder="t('publish.colAccount')" allow-clear show-search option-filter-prop="label" style="width: 180px"
        :options="accounts.map((a) => ({ value: a.id, label: `@${a.handle}` }))" @change="search" />
      <a-select v-model:value="filters.status" :placeholder="t('common.status')" allow-clear style="width: 160px" @change="search">
        <a-select-option v-for="s in STATUSES" :key="s" :value="s">{{ t(`publish.status.${s}`) }} ({{ byStatus[s] ?? 0 }})</a-select-option>
      </a-select>
      <a-range-picker v-model:value="filters.range" style="width: 240px" @change="search" />
    </SearchBar>
    <PublishTaskTable :items="items" :total="total" :loading="loading" :current="page.current" :page-size="page.pageSize" mode="result"
      @change="onChange" @open="openTask" />
    <PublishTaskDrawer ref="drawer" v-model:open="drawerOpen" :task-id="drawerId" @changed="load" />
  </div>
</template>
