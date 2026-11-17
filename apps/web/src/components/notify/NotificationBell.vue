<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { message } from 'ant-design-vue'
import { BellOutlined, CheckCircleOutlined, CloseCircleOutlined, ExclamationCircleOutlined } from '@ant-design/icons-vue'
import { useI18n } from 'vue-i18n'
import { api, errorText } from '../../api/client'
import { alertDetail, alertLink, alertText } from '../../api/alerts'
import type { AppNotification } from '../../api/types'
import { dateLocale } from '../../i18n'
import { useInstancesStore } from '../../stores/instances'

/** Header bell (告警通知): unread count, live via /api/events, and a drawer with the latest alerts. */
const { t } = useI18n()
const router = useRouter()
const store = useInstancesStore()
const open = ref(false)
const loading = ref(false)
const onlyUnread = ref(false)
const items = ref<AppNotification[]>([])
const unread = ref(0)

async function load() {
  loading.value = true
  try {
    const r = await api<{ notifications: AppNotification[]; unread: number }>('GET', `/api/notifications?limit=50${onlyUnread.value ? '&unread=1' : ''}`)
    items.value = r.notifications
    unread.value = r.unread
  } catch (e) { message.error(errorText(e)) }
  finally { loading.value = false }
}
onMounted(load)
const off = store.onNotification((ev) => {
  if (items.value.some((x) => x.id === ev.notification.id)) return
  items.value = [ev.notification, ...items.value].slice(0, 50)
  unread.value++
})
onBeforeUnmount(off)

function show() { open.value = true; void load() }

async function markRead(n: AppNotification) {
  if (n.readAt) return
  try {
    const r = await api<{ notification: AppNotification; unread: number }>('POST', `/api/notifications/${n.id}/read`)
    n.readAt = r.notification.readAt
    unread.value = r.unread
  } catch (e) { message.error(errorText(e)) }
}
async function markAll() {
  try {
    await api('POST', '/api/notifications/read-all')
    const now = new Date().toISOString()
    items.value.forEach((n) => { n.readAt ??= now })
    unread.value = 0
  } catch (e) { message.error(errorText(e)) }
}
async function go(n: AppNotification) {
  await markRead(n)
  const to = alertLink(n)
  if (to) { open.value = false; void router.push(to) }
}
const label = computed(() => (unread.value ? t('alerts.bellUnread', { n: unread.value }) : t('alerts.bell')))
</script>

<template>
  <a-tooltip :title="label">
    <a-badge :count="unread" :overflow-count="99" size="small">
      <a-button type="text" class="pref-btn" :aria-label="label" @click="show"><BellOutlined /></a-button>
    </a-badge>
  </a-tooltip>
  <a-drawer v-model:open="open" :title="t('alerts.title')" placement="right" :width="420">
    <template #extra>
      <a-space>
        <a-checkbox v-model:checked="onlyUnread" @change="load">{{ t('alerts.onlyUnread') }}</a-checkbox>
        <a-button size="small" :disabled="!unread" @click="markAll">{{ t('alerts.markAllRead') }}</a-button>
      </a-space>
    </template>
    <a-spin :spinning="loading">
      <a-empty v-if="!items.length" :description="t('alerts.empty')" />
      <a-list v-else :data-source="items" size="small">
        <template #renderItem="{ item }">
          <a-list-item :class="['note', { unread: !item.readAt }]" @click="go(item)">
            <a-list-item-meta>
              <template #avatar>
                <CheckCircleOutlined v-if="item.recovered" class="sev ok" />
                <CloseCircleOutlined v-else-if="item.severity === 'error'" class="sev err" />
                <ExclamationCircleOutlined v-else class="sev warn" />
              </template>
              <template #title><span class="text">{{ alertText(item) }}</span></template>
              <template #description>
                <div v-if="alertDetail(item)" class="detail">{{ alertDetail(item) }}</div>
                <span class="time">{{ new Date(item.createdAt).toLocaleString(dateLocale()) }}</span>
              </template>
            </a-list-item-meta>
            <template #actions>
              <a-button v-if="!item.readAt" type="link" size="small" @click.stop="markRead(item)">{{ t('alerts.markRead') }}</a-button>
            </template>
          </a-list-item>
        </template>
      </a-list>
    </a-spin>
  </a-drawer>
</template>

<style scoped>
.pref-btn { color: inherit; }
.note { cursor: pointer; border-radius: 6px; padding-left: 8px; padding-right: 8px; }
.note:hover { background: var(--cp-bg-hover); }
.note.unread .text { font-weight: 600; }
.sev { font-size: 18px; margin-top: 2px; }
.sev.ok { color: var(--cp-success); }
.sev.err { color: var(--cp-error); }
.sev.warn { color: var(--cp-warning); }
.detail { color: var(--cp-text-secondary); font-size: 12px; }
.time { color: var(--cp-text-tertiary); font-size: 12px; }
</style>
