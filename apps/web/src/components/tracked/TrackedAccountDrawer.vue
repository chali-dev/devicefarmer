<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { message, Modal } from 'ant-design-vue'
import type { Dayjs } from 'dayjs'
import { useI18n } from 'vue-i18n'
import { api, codeText, errorText } from '../../api/client'
import {
  compactNumber, TRACKED_STATUS_COLOR, trackedHandle,
  type TrackedAccount, type TrackedMetric, type TrackedPlatform, type TrackedPost, type TrackedSnapshot,
} from '../../api/types'
import LineChart from './LineChart.vue'

/** Detail of one tracked account: follower history chart + table, public posts, manual entry, refresh. */
const open = defineModel<boolean>('open', { required: true })
const props = defineProps<{ account: TrackedAccount | null; platforms: TrackedPlatform[] }>()
const emit = defineEmits<{ changed: [TrackedAccount]; edit: [TrackedAccount]; refresh: [TrackedAccount] }>()
const { t } = useI18n()
const URL_HINT = 'https://'

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
const fmtFull = (n: number | null) => (n === null ? '—' : n.toLocaleString())

const snapColumns = computed(() => [
  { title: t('tracked.capturedAt'), key: 'capturedAt', width: 170 },
  ...metrics.value.map((m) => ({ title: metricText(m), key: m, align: 'right' as const })),
  { title: t('tracked.source'), key: 'source', width: 90 },
  { title: '', key: 'ops', width: 60 },
])
const snapRows = computed(() => [...snapshots.value].reverse())

// ---- manual snapshot
const snapOpen = ref(false)
const snapSaving = ref(false)
const snapForm = reactive({ capturedAt: null as Dayjs | null, followers: null as number | null, following: null as number | null, posts: null as number | null, views: null as number | null })
function openSnap() {
  const l = acc.value?.latest
  Object.assign(snapForm, { capturedAt: null, followers: l?.followers ?? null, following: l?.following ?? null, posts: l?.posts ?? null, views: l?.views ?? null })
  snapOpen.value = true
}
async function saveSnap() {
  if (!acc.value) return
  const body: Record<string, unknown> = {}
  for (const m of metrics.value) if (snapForm[m] !== null && snapForm[m] !== undefined) body[m] = snapForm[m]
  if (!Object.keys(body).length) { message.warning(t('errors.tracked.snapshot_empty')); return }
  if (snapForm.capturedAt) body.capturedAt = snapForm.capturedAt.toISOString()
  snapSaving.value = true
  try {
    await api('POST', `/api/tracked-accounts/${acc.value.id}/snapshots`, body)
    snapOpen.value = false
    message.success(t('common.saved'))
    await loadSnapshots()
    await reloadAccount()
  } catch (e) { message.error(errorText(e)) }
  finally { snapSaving.value = false }
}
function removeSnap(s: TrackedSnapshot) {
  Modal.confirm({
    title: t('tracked.confirmDeleteSnapshot'), okType: 'danger', okText: t('common.delete'), cancelText: t('common.cancel'),
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
  { title: '', key: 'ops', width: 60 },
])
const postOpen = ref(false)
const postSaving = ref(false)
const postForm = reactive({ url: '', externalId: '', title: '', publishedAt: null as Dayjs | null, views: null as number | null, likes: null as number | null, comments: null as number | null })
function openPost() {
  Object.assign(postForm, { url: '', externalId: '', title: '', publishedAt: null, views: null, likes: null, comments: null })
  postOpen.value = true
}
async function savePost() {
  if (!acc.value) return
  if (!postForm.url.trim() && !postForm.externalId.trim()) { message.warning(t('errors.tracked.post_id_required')); return }
  const body: Record<string, unknown> = {}
  if (postForm.url.trim()) body.url = postForm.url.trim()
  if (postForm.externalId.trim()) body.externalId = postForm.externalId.trim()
  if (postForm.title.trim()) body.title = postForm.title.trim()
  if (postForm.publishedAt) body.publishedAt = postForm.publishedAt.toISOString()
  for (const k of ['views', 'likes', 'comments'] as const) if (postForm[k] !== null && postForm[k] !== undefined) body[k] = postForm[k]
  postSaving.value = true
  try {
    const r = await api<{ created: boolean }>('POST', `/api/tracked-accounts/${acc.value.id}/posts`, body)
    postOpen.value = false
    message.success(r.created ? t('tracked.postAdded') : t('tracked.postUpdated'))
    await loadPosts()
    await reloadAccount()
  } catch (e) { message.error(errorText(e)) }
  finally { postSaving.value = false }
}
function removePost(p: TrackedPost) {
  Modal.confirm({
    title: t('tracked.confirmDeletePost'), okType: 'danger', okText: t('common.delete'), cancelText: t('common.cancel'),
    onOk: async () => {
      try { await api('DELETE', `/api/tracked-accounts/${acc.value!.id}/posts/${p.id}`); await loadPosts() } catch (e) { message.error(errorText(e)) }
    },
  })
}
const isHttp = (u: string | null) => !!u && /^https?:\/\//i.test(u)
const when = (s: string | null) => (s ? new Date(s).toLocaleString() : '—')
</script>

<template>
  <a-drawer v-model:open="open" :width="860" :title="acc ? (acc.displayName || trackedHandle(acc)) : ''" destroy-on-close class="tracked-drawer">
    <template v-if="acc">
      <div class="head">
        <a-avatar v-if="acc.avatarUrl" :src="acc.avatarUrl" :size="56" referrerpolicy="no-referrer" />
        <a-avatar v-else :size="56">{{ (acc.displayName || acc.handle).charAt(0).toUpperCase() }}</a-avatar>
        <div class="who">
          <div>
            <a-tag>{{ platform?.label ?? acc.platform }}</a-tag>
            <a :href="acc.profileUrl" target="_blank" rel="noopener noreferrer">{{ trackedHandle(acc) }}</a>
            <a-tag :color="TRACKED_STATUS_COLOR[acc.status]" style="margin-left: 8px">{{ t(`tracked.status.${acc.status}`) }}</a-tag>
          </div>
          <div class="muted small">
            {{ acc.category || t('tracked.uncategorized') }}
            <a-tag v-for="tg in acc.tags" :key="tg" class="small-tag">{{ tg }}</a-tag>
          </div>
          <div v-if="acc.bio" class="bio">{{ acc.bio }}</div>
        </div>
        <a-space direction="vertical" align="end">
          <a-space>
            <a-button @click="emit('edit', acc)">{{ t('common.edit') }}</a-button>
            <a-button type="primary" :disabled="acc.status === 'paused' || acc.dataMode === 'api_unconfigured'"
              :loading="['pending', 'scheduled', 'running'].includes(acc.lastRefresh?.status ?? '')" @click="emit('refresh', acc)">
              {{ t('tracked.refreshNow') }}
            </a-button>
          </a-space>
          <span class="muted small">{{ t('tracked.lastChecked') }}: {{ when(acc.lastCheckedAt) }}{{ acc.lastSource ? ` · ${t(`tracked.sources.${acc.lastSource}`)}` : '' }}</span>
        </a-space>
      </div>

      <a-alert v-if="acc.status === 'error' && acc.lastError" type="error" show-icon class="note"
        :message="codeText(acc.lastErrorCode, undefined, acc.lastError)" />
      <a-alert v-if="acc.dataMode === 'manual_only'" type="info" show-icon class="note" :message="t('tracked.manualOnlyHint', { platform: platform?.label ?? acc.platform })" />
      <a-alert v-else-if="acc.dataMode === 'api_unconfigured'" type="warning" show-icon class="note" :message="t('tracked.apiUnconfiguredHint')" />

      <a-row :gutter="12" class="stats">
        <a-col v-for="m in metrics" :key="m" :xs="12" :sm="6">
          <a-statistic :title="metricText(m)" :value="acc.latest?.[m] ?? undefined" :formatter="({ value }: any) => fmtFull(value ?? null)" />
          <div v-if="m === 'followers' && acc.followersDelta !== null" :class="['delta', acc.followersDelta >= 0 ? 'up' : 'down']">
            {{ acc.followersDelta >= 0 ? '+' : '' }}{{ acc.followersDelta.toLocaleString() }}
          </div>
        </a-col>
      </a-row>

      <a-tabs v-model:active-key="tab">
        <a-tab-pane key="history" :tab="t('tracked.history')">
          <a-space style="margin-bottom: 8px" wrap>
            <a-radio-group v-model:value="metric" size="small">
              <a-radio-button v-for="m in metrics" :key="m" :value="m">{{ metricText(m) }}</a-radio-button>
            </a-radio-group>
            <a-button size="small" @click="openSnap">{{ t('tracked.addSnapshot') }}</a-button>
          </a-space>
          <a-spin :spinning="loading">
            <LineChart v-if="series.length" :points="series" :format="(v: number) => compactNumber(v)" :aria-label="metricText(metric)" />
            <a-empty v-else :description="t('tracked.noHistory')" />
          </a-spin>
          <a-table :data-source="snapRows" :columns="snapColumns" row-key="id" size="small" style="margin-top: 12px"
            :pagination="{ pageSize: 10, size: 'small', hideOnSinglePage: true }">
            <template #bodyCell="{ column, record }">
              <template v-if="column.key === 'capturedAt'">{{ when(record.capturedAt) }}</template>
              <template v-else-if="column.key === 'source'"><a-tag>{{ t(`tracked.sources.${record.source}`) }}</a-tag></template>
              <template v-else-if="column.key === 'ops'">
                <a-button size="small" type="link" danger @click="removeSnap(record as TrackedSnapshot)">{{ t('common.delete') }}</a-button>
              </template>
              <template v-else>{{ fmtFull(record[column.key as TrackedMetric]) }}</template>
            </template>
          </a-table>
        </a-tab-pane>

        <a-tab-pane key="posts" :tab="`${t('tracked.posts')} (${postsTotal})`">
          <a-space style="margin-bottom: 8px">
            <a-button size="small" @click="openPost">{{ t('tracked.addPost') }}</a-button>
            <span class="muted small">{{ t('tracked.postsHint') }}</span>
          </a-space>
          <a-table :data-source="posts" :columns="postColumns" row-key="id" size="small" :loading="loading"
            :pagination="{ current: postsPage, pageSize: 20, total: postsTotal, size: 'small', hideOnSinglePage: true, onChange: (p: number) => { postsPage = p; loadPosts() } }">
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

  <a-modal v-model:open="snapOpen" :title="t('tracked.addSnapshot')" :ok-text="t('common.save')" :cancel-text="t('common.cancel')" :confirm-loading="snapSaving" @ok="saveSnap">
    <a-form layout="vertical" :model="snapForm">
      <a-form-item :label="t('tracked.capturedAt')" :extra="t('tracked.capturedAtHint')">
        <a-date-picker v-model:value="snapForm.capturedAt" show-time style="width: 100%" />
      </a-form-item>
      <a-row :gutter="12">
        <a-col v-for="m in metrics" :key="m" :span="12">
          <a-form-item :label="metricText(m)"><a-input-number v-model:value="snapForm[m]" :min="0" :precision="0" style="width: 100%" /></a-form-item>
        </a-col>
      </a-row>
    </a-form>
  </a-modal>

  <a-modal v-model:open="postOpen" :title="t('tracked.addPost')" :ok-text="t('common.save')" :cancel-text="t('common.cancel')" :confirm-loading="postSaving" @ok="savePost">
    <a-form layout="vertical" :model="postForm">
      <a-form-item :label="t('tracked.postUrl')"><a-input v-model:value="postForm.url" :placeholder="URL_HINT" :maxlength="1000" /></a-form-item>
      <a-form-item :label="t('tracked.postId')" :extra="t('tracked.postIdHint')"><a-input v-model:value="postForm.externalId" :maxlength="200" /></a-form-item>
      <a-form-item :label="t('tracked.postTitle')"><a-textarea v-model:value="postForm.title" :maxlength="500" :auto-size="{ minRows: 1, maxRows: 4 }" /></a-form-item>
      <a-form-item :label="t('tracked.publishedAt')"><a-date-picker v-model:value="postForm.publishedAt" show-time style="width: 100%" /></a-form-item>
      <a-row :gutter="12">
        <a-col :span="8"><a-form-item :label="t('tracked.views')"><a-input-number v-model:value="postForm.views" :min="0" :precision="0" style="width: 100%" /></a-form-item></a-col>
        <a-col :span="8"><a-form-item :label="t('tracked.likes')"><a-input-number v-model:value="postForm.likes" :min="0" :precision="0" style="width: 100%" /></a-form-item></a-col>
        <a-col :span="8"><a-form-item :label="t('tracked.comments')"><a-input-number v-model:value="postForm.comments" :min="0" :precision="0" style="width: 100%" /></a-form-item></a-col>
      </a-row>
    </a-form>
  </a-modal>
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
.muted { color: var(--cp-text-tertiary); }
.small { font-size: 12px; }
.small-tag { margin-left: 4px; font-size: 11px; }
@media (max-width: 640px) { .head { flex-wrap: wrap; } }
</style>
