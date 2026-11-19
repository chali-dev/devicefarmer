<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { message } from 'ant-design-vue'
import dayjs from 'dayjs'
import { CheckCircleOutlined, CloseCircleOutlined, ExclamationCircleOutlined } from '@ant-design/icons-vue'
import { useI18n } from 'vue-i18n'
import { api, errorText } from '../api/client'
import { alertDetail, alertLink, alertText } from '../api/alerts'
import type { AppNotification } from '../api/types'
import { fmtDateTime } from '../i18n'
import PageContainer from '../components/common/PageContainer.vue'
import SearchBar from '../components/common/SearchBar.vue'
import BatchActions, { type BatchItem } from '../components/common/BatchActions.vue'
import { confirmDanger, pagination, TABLE_SIZE } from '../components/common/ui'
import { useNotificationsStore } from '../stores/notifications'

/**
 * 通知中心: the signed-in user's own notifications (告警通知) with filters, paging, mark read and deletion
 * (selected rows / all read ones). Unread count is the shared store (header bell + user menu).
 */
const { t, tm } = useI18n()
const router = useRouter()
const route = useRoute()
const notes = useNotificationsStore()

type ReadFilter = 'all' | 'unread' | 'read'
/** `?read=unread|read` preselects the filter (the bell's 查看更多 with 只看未读). */
const initialRead = (['unread', 'read'] as const).find((r) => r === route.query.read) ?? 'all'
const filters = reactive({ read: initialRead as ReadFilter, kinds: [] as string[], range: null as [string, string] | null })
const items = ref<AppNotification[]>([])
const total = ref(0)
const loading = ref(false)
const page = ref(1)
const pageSize = ref(20)
const selectedKeys = ref<string[]>([])

/** Kind ids from the i18n names ('device_down' → 'device.down'). */
const kindOptions = computed(() => Object.keys(tm('alerts.kindNames') as Record<string, unknown>)
  .map((k) => ({ value: k.replace('_', '.'), label: t(`alerts.kindNames.${k}`) })))
const kindName = (kind: string) => kindOptions.value.find((o) => o.value === kind)?.label ?? kind

async function load() {
  loading.value = true
  try {
    const p = new URLSearchParams({ read: filters.read, limit: String(pageSize.value), offset: String((page.value - 1) * pageSize.value) })
    if (filters.kinds.length) p.set('kind', filters.kinds.join(','))
    if (filters.range) {
      p.set('from', dayjs(filters.range[0]).startOf('day').toISOString())
      p.set('to', dayjs(filters.range[1]).add(1, 'day').startOf('day').toISOString())
    }
    const r = await api<{ notifications: AppNotification[]; total: number; unread: number }>('GET', `/api/notifications?${p}`)
    items.value = r.notifications
    total.value = r.total
    notes.setUnread(r.unread)
    // Keep only selections still on the page.
    selectedKeys.value = selectedKeys.value.filter((id) => r.notifications.some((n) => n.id === id))
  } catch (e) { message.error(errorText(e)) }
  finally { loading.value = false }
}

function search() { page.value = 1; void load() }
function reset() { Object.assign(filters, { read: 'all', kinds: [], range: null }); search() }
function onTableChange(p: { current?: number; pageSize?: number }) {
  if (p.pageSize && p.pageSize !== pageSize.value) { pageSize.value = p.pageSize; page.value = 1 }
  else if (p.current) page.value = p.current
  void load()
}

onMounted(load)
// The bell's 查看更多 while this page is open only changes the query.
watch(() => route.query.read, (r) => { filters.read = r === 'unread' || r === 'read' ? r : 'all'; search() })
// New notifications show up at once on the first page (the store counts them for the badges).
const off = notes.onCreated(() => { if (page.value === 1 && !loading.value) void load() })
onBeforeUnmount(off)

async function markRead(n: AppNotification) {
  if (n.readAt) return
  try {
    const r = await api<{ notification: AppNotification; unread: number }>('POST', `/api/notifications/${n.id}/read`)
    n.readAt = r.notification.readAt
    notes.setUnread(r.unread)
    if (filters.read === 'unread') void load()
  } catch (e) { message.error(errorText(e)) }
}
async function markAll() {
  try {
    await api('POST', '/api/notifications/read-all')
    notes.setUnread(0)
    void load()
  } catch (e) { message.error(errorText(e)) }
}
async function open(n: AppNotification) {
  await markRead(n)
  const to = alertLink(n)
  if (to) void router.push(to)
}

/** After deleting, step back a page when this one became empty. */
function afterDelete(deleted: number, unread: number) {
  notes.setUnread(unread)
  message.success(t('notifications.deleted', { n: deleted }))
  selectedKeys.value = []
  const left = total.value - deleted
  const last = Math.max(1, Math.ceil(left / pageSize.value))
  if (page.value > last) page.value = last
  void load()
}
function deleteSelected() {
  const ids = [...selectedKeys.value]
  if (!ids.length) return
  confirmDanger({
    title: t('notifications.deleteSelectedTitle', { n: ids.length }),
    content: t('notifications.deleteHint'),
    onOk: async () => {
      try {
        const r = await api<{ deleted: number; unread: number }>('POST', '/api/notifications/delete', { ids })
        afterDelete(r.deleted, r.unread)
      } catch (e) { message.error(errorText(e)); void load() }
    },
  })
}
function deleteRead() {
  confirmDanger({
    title: t('notifications.deleteReadTitle'),
    content: t('notifications.deleteHint'),
    onOk: async () => {
      try {
        const r = await api<{ deleted: number; unread: number }>('POST', '/api/notifications/delete-read')
        afterDelete(r.deleted, r.unread)
      } catch (e) { message.error(errorText(e)) }
    },
  })
}

const batchItems = computed<BatchItem[]>(() => [{ key: 'delete', label: t('common.delete'), danger: true }])
function onBatch(key: string) { if (key === 'delete') deleteSelected() }

const readOptions = computed(() => [
  { value: 'all', label: t('common.all') }, { value: 'unread', label: t('notifications.unread') }, { value: 'read', label: t('notifications.read') },
])
const columns = computed(() => [
  { title: t('notifications.content'), key: 'text' },
  { title: t('notifications.kind'), key: 'kind', width: 180 },
  { title: t('common.time'), key: 'createdAt', width: 180 },
  { title: t('notifications.state'), key: 'state', width: 100 },
  { title: t('common.action'), key: 'ops', width: 120 },
])
const rowSelection = computed(() => ({ selectedRowKeys: selectedKeys.value, onChange: (k: (string | number)[]) => { selectedKeys.value = k as string[] } }))
</script>

<template>
  <PageContainer :subtitle="t('notifications.subtitle')">
    <template #extra>
      <a-button :disabled="!notes.unread" @click="markAll">{{ t('alerts.markAllRead') }}</a-button>
      <a-button danger @click="deleteRead">{{ t('notifications.deleteRead') }}</a-button>
    </template>
    <a-card :bordered="false">
      <SearchBar :loading="loading" @search="search" @reset="reset" @refresh="load">
        <a-segmented v-model:value="filters.read" :options="readOptions" @change="search" />
        <a-select
          v-model:value="filters.kinds" mode="multiple" allow-clear :max-tag-count="2" :placeholder="t('notifications.kind')"
          :options="kindOptions" style="min-width: 200px" @change="search"
        />
        <a-range-picker v-model:value="filters.range" value-format="YYYY-MM-DD" @change="search" />
        <template #actions>
          <BatchActions :count="selectedKeys.length" :items="batchItems" @select="onBatch" @clear="selectedKeys = []" />
        </template>
      </SearchBar>

      <a-table
        :data-source="items" :columns="columns" row-key="id" :size="TABLE_SIZE" :loading="loading" :scroll="{ x: 860 }"
        :pagination="pagination({ current: page, pageSize, total })" :row-selection="rowSelection" @change="onTableChange"
      >
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'text'">
            <div :class="['note', { unread: !record.readAt }]">
              <CheckCircleOutlined v-if="record.recovered" class="sev ok" />
              <CloseCircleOutlined v-else-if="record.severity === 'error'" class="sev err" />
              <ExclamationCircleOutlined v-else class="sev warn" />
              <div class="body">
                <a v-if="alertLink(record as AppNotification)" class="text" @click="open(record as AppNotification)">{{ alertText(record as AppNotification) }}</a>
                <span v-else class="text">{{ alertText(record as AppNotification) }}</span>
                <div v-if="alertDetail(record as AppNotification)" class="detail">{{ alertDetail(record as AppNotification) }}</div>
              </div>
            </div>
          </template>
          <template v-else-if="column.key === 'kind'">
            {{ kindName(record.kind) }}
          </template>
          <template v-else-if="column.key === 'createdAt'">{{ fmtDateTime(record.createdAt) }}</template>
          <template v-else-if="column.key === 'state'">
            <a-badge v-if="!record.readAt" status="processing" :text="t('notifications.unread')" />
            <a-badge v-else status="default" :text="t('notifications.read')" />
          </template>
          <template v-else-if="column.key === 'ops'">
            <a-button v-if="!record.readAt" type="link" size="small" @click="markRead(record as AppNotification)">{{ t('alerts.markRead') }}</a-button>
          </template>
        </template>
      </a-table>
    </a-card>
  </PageContainer>
</template>

<style scoped>
.note { display: flex; gap: 8px; align-items: flex-start; }
.note.unread .text { font-weight: 600; }
.body { min-width: 0; }
.sev { font-size: 16px; margin-top: 3px; }
.sev.ok { color: var(--cp-success); }
.sev.err { color: var(--cp-error); }
.sev.warn { color: var(--cp-warning); }
.detail { color: var(--cp-text-secondary); font-size: 12px; }
</style>
