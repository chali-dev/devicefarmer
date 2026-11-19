<script setup lang="ts">
import { dateLocale } from '../i18n'
import { message } from 'ant-design-vue'
import { ArrowDownOutlined, ArrowUpOutlined } from '@ant-design/icons-vue'
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { api, codeText, errorText } from '../api/client'
import { compactNumber, type TrendingData, type TrendingItem } from '../api/types'
import PageContainer from '../components/common/PageContainer.vue'
import SearchBar from '../components/common/SearchBar.vue'
import StatusTag from '../components/common/StatusTag.vue'
import { MODAL_WIDTH, TABLE_SIZE } from '../components/common/ui'
import { useAuthStore } from '../stores/auth'
import { usePlatformsStore } from '../stores/platforms'
import YoutubeKeySettings from '../components/settings/YoutubeKeySettings.vue'

/**
 * 趋势热点: YouTube mostPopular chart per region (official Data API), rank changes vs. the previous snapshot. Admins
 * also set the YouTube API key here (used by trending and by YouTube tracked accounts; formerly 系统配置 → 追踪采集,
 * old links /settings?tab=tracked land here with ?youtubeKey=1, which opens it).
 */
const { t } = useI18n()
const auth = useAuthStore()
const platformScope = usePlatformsStore()
const route = useRoute()
const router = useRouter()
const keyOpen = ref(auth.isAdmin && route.query.youtubeKey === '1')
watch(keyOpen, (o) => {
  if (!o && route.query.youtubeKey) void router.replace({ query: { ...route.query, youtubeKey: undefined } })
  if (!o) void load()
})

const data = ref<TrendingData | null>(null)
const loading = ref(false)
const filters = reactive({ region: undefined as string | undefined, snapshotId: undefined as string | undefined, q: '', onlyNew: false, onlyRising: false })
const fmt = (d: string | null | undefined) => (d ? new Date(d).toLocaleString(dateLocale()) : '—')

async function load() {
  loading.value = true
  try {
    const p = new URLSearchParams()
    if (filters.snapshotId) p.set('snapshotId', filters.snapshotId)
    else if (filters.region) p.set('region', filters.region)
    if (filters.q.trim()) p.set('q', filters.q.trim())
    data.value = await api<TrendingData>('GET', `/api/trending?${p}`)
    if (!filters.region && data.value.snapshot) filters.region = data.value.snapshot.region
  } catch (e) { message.error(errorText(e)) } finally { loading.value = false }
}
onMounted(load)

// No region chips while trending is unavailable for the platform scope (configured regions are kept for later).
const regionOptions = computed(() => (data.value?.notice === 'trending.unavailable' ? [] : [...new Set([...(data.value?.settings.regions ?? []), ...(data.value?.regions ?? []).map((r) => r.region)])]))
function pickRegion(r: string) { filters.region = r; filters.snapshotId = undefined; void load() }
const items = computed(() => (data.value?.items ?? []).filter((x) => (!filters.onlyNew || x.isNew) && (!filters.onlyRising || (x.rankChange ?? 0) > 0)))

const columns = computed(() => [
  { title: t('trending.rank'), key: 'rank', width: 70, align: 'right' as const },
  { title: t('trending.change'), key: 'change', width: 100 },
  { title: t('trending.video'), key: 'video', width: 380 },
  { title: t('trending.channel'), key: 'channel', width: 180 },
  { title: t('trending.views'), key: 'views', width: 100, align: 'right' as const },
  { title: t('trending.likes'), key: 'likes', width: 90, align: 'right' as const },
  { title: t('trending.published'), key: 'published', width: 170 },
])
const scrollX = computed(() => columns.value.reduce((n, c) => n + c.width, 0))

// ---- admin
const refreshing = ref(false)
async function refreshNow() {
  refreshing.value = true
  try {
    const r = await api<{ taskIds: string[] }>('POST', '/api/trending/refresh')
    message.info(t('trending.refreshQueued', { n: r.taskIds.length }))
    setTimeout(() => void load(), 4000)
  } catch (e) { message.error(errorText(e)) } finally { refreshing.value = false }
}
const settingsOpen = ref(false)
const saving = ref(false)
const INTERVALS = [1, 3, 6, 12, 24, 48, 168]
const sform = reactive({ regions: [] as string[], categoryId: '', intervalHours: 24, maxResults: 50, retentionDays: 30 })
function openSettings() {
  const s = data.value?.settings
  if (s) Object.assign(sform, { regions: [...s.regions], categoryId: s.categoryId ?? '', intervalHours: s.intervalHours, maxResults: s.maxResults, retentionDays: s.retentionDays })
  settingsOpen.value = true
}
async function saveSettings() {
  saving.value = true
  try {
    await api('PUT', '/api/trending/settings', {
      regions: sform.regions.map((r) => r.trim().toUpperCase()).filter(Boolean), categoryId: sform.categoryId.trim() || null,
      intervalHours: sform.intervalHours, maxResults: sform.maxResults, retentionDays: sform.retentionDays,
    })
    message.success(t('common.saved'))
    settingsOpen.value = false
    void load()
  } catch (e) { message.error(errorText(e)) } finally { saving.value = false }
}
const intervalLabel = (h: number) => (h < 24 ? t('collect.everyHours', { n: h }) : t('collect.everyDays', { n: h / 24 }))
const changeOf = (x: TrendingItem) => x.rankChange ?? 0
</script>

<template>
  <PageContainer :title="t('trending.title')">
    <template v-if="auth.isAdmin" #extra>
      <a-button v-if="platformScope.scope.features.youtubeKey" @click="keyOpen = true">{{ t('tracked.youtubeKey') }}</a-button>
      <template v-if="data?.notice !== 'trending.unavailable'">
        <a-button @click="openSettings">{{ t('trending.settings') }}</a-button>
        <a-button type="primary" :loading="refreshing" :disabled="!data?.configured || !data?.settings.regions.length" @click="refreshNow">{{ t('trending.refreshNow') }}</a-button>
      </template>
    </template>

    <a-alert v-if="data?.notice === 'tracked.youtube_no_api_key'" type="warning" show-icon :message="codeText(data.notice, undefined, data.notice)">
      <template v-if="auth.isAdmin" #action>
        <a-button size="small" @click="keyOpen = true">{{ t('trending.setKey') }}</a-button>
      </template>
    </a-alert>
    <a-alert v-else-if="data?.notice === 'trending.no_regions'" type="info" show-icon :message="auth.isAdmin ? t('trending.emptyAdmin') : t('trending.noRegions')" />
    <a-alert v-else-if="data?.notice" type="info" show-icon :message="codeText(data.notice, undefined, data.notice)" />

    <a-card :bordered="false">
      <SearchBar :loading="loading" @refresh="load">
        <a-radio-group v-if="regionOptions.length" :value="data?.snapshot?.region ?? filters.region" button-style="solid" @change="(e: any) => pickRegion(e.target.value)">
          <a-radio-button v-for="r in regionOptions" :key="r" :value="r">{{ r }}</a-radio-button>
        </a-radio-group>
        <a-select v-if="data?.history.length" v-model:value="filters.snapshotId" :placeholder="t('trending.latest')" allow-clear style="width: 200px" @change="load">
          <a-select-option v-for="h in data.history" :key="h.id" :value="h.id">{{ fmt(h.capturedAt) }}</a-select-option>
        </a-select>
        <a-input-search v-model:value="filters.q" :placeholder="t('trending.searchPlaceholder')" allow-clear style="width: 240px" @search="load" />
        <a-checkbox v-model:checked="filters.onlyNew">{{ t('trending.onlyNew') }}</a-checkbox>
        <a-checkbox v-model:checked="filters.onlyRising">{{ t('trending.onlyRising') }}</a-checkbox>
        <template v-if="data?.snapshot" #actions>
          <span class="muted small">
            {{ t('trending.capturedAt', { time: fmt(data.snapshot.capturedAt) }) }}
            · {{ data.previous ? t('trending.vsPrevious', { time: fmt(data.previous.capturedAt) }) : t('trending.noPrevious') }}
            <template v-if="data.nextSlotAt"> · {{ t('trending.nextRun', { time: fmt(data.nextSlotAt) }) }}</template>
          </span>
        </template>
      </SearchBar>

      <a-table :data-source="items" :columns="columns" row-key="id" :size="TABLE_SIZE" :loading="loading" :scroll="{ x: scrollX }" :pagination="false"
        :locale="{ emptyText: t('trending.empty') }">
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'rank'"><span class="num">{{ record.rank }}</span></template>
          <template v-else-if="column.key === 'change'">
            <a-tag v-if="record.isNew" color="blue">{{ t('trending.new') }}</a-tag>
            <span v-else-if="changeOf(record as TrendingItem) > 0" class="up nowrap"><ArrowUpOutlined /> {{ record.rankChange }}</span>
            <span v-else-if="changeOf(record as TrendingItem) < 0" class="down nowrap"><ArrowDownOutlined /> {{ -record.rankChange }}</span>
            <span v-else class="muted">—</span>
          </template>
          <template v-else-if="column.key === 'video'">
            <a :href="record.url" target="_blank" rel="noopener noreferrer">{{ record.title || record.videoId }}</a>
            <div v-if="record.tags.length"><a-tag v-for="tg in record.tags.slice(0, 6)" :key="tg" style="margin-top: 2px">{{ tg }}</a-tag></div>
          </template>
          <template v-else-if="column.key === 'channel'">
            <a v-if="record.channelUrl" :href="record.channelUrl" target="_blank" rel="noopener noreferrer">{{ record.channelTitle || record.channelId }}</a>
            <span v-else>{{ record.channelTitle ?? '—' }}</span>
          </template>
          <template v-else-if="column.key === 'views'"><span class="num">{{ compactNumber(record.views) }}</span></template>
          <template v-else-if="column.key === 'likes'"><span class="num">{{ compactNumber(record.likes) }}</span></template>
          <template v-else-if="column.key === 'published'">{{ fmt(record.publishedAt) }}</template>
        </template>
      </a-table>
    </a-card>

    <a-card v-if="auth.isAdmin && data?.lastTasks.length" :bordered="false" size="small" :title="t('trending.lastTasks')">
      <a-space wrap :size="[24, 8]">
        <span v-for="x in data.lastTasks" :key="x.label ?? ''" class="nowrap">
          {{ x.label }}
          <a-tooltip :title="x.errorCode || x.error ? codeText(x.errorCode, undefined, x.error ?? '') : undefined">
            <StatusTag kind="task" :status="x.status" style="margin-inline: 4px" />
          </a-tooltip>
          <span class="muted small">{{ fmt(x.finishedAt ?? x.createdAt) }}</span>
        </span>
      </a-space>
    </a-card>

    <a-modal v-model:open="settingsOpen" :title="t('trending.settings')" :ok-text="t('common.save')" :cancel-text="t('common.cancel')" :confirm-loading="saving" :width="MODAL_WIDTH.md" @ok="saveSettings">
      <a-form layout="vertical">
        <a-form-item :label="t('trending.regions')">
          <a-select v-model:value="sform.regions" mode="tags" :token-separators="[',', ' ']" :max-tag-count="10" :placeholder="t('trending.regionsHint')" />
        </a-form-item>
        <a-form-item :label="t('trending.categoryId')" :extra="t('trending.categoryHint')">
          <a-input v-model:value="sform.categoryId" :maxlength="4" style="width: 160px" />
        </a-form-item>
        <a-row :gutter="12">
          <a-col :xs="24" :sm="8">
            <a-form-item :label="t('trending.interval')">
              <a-select v-model:value="sform.intervalHours" :options="INTERVALS.map((h) => ({ value: h, label: intervalLabel(h) }))" />
            </a-form-item>
          </a-col>
          <a-col :xs="12" :sm="8">
            <a-form-item :label="t('trending.maxResults')"><a-input-number v-model:value="sform.maxResults" :min="1" :max="50" style="width: 100%" /></a-form-item>
          </a-col>
          <a-col :xs="12" :sm="8">
            <a-form-item :label="t('trending.retentionDays')"><a-input-number v-model:value="sform.retentionDays" :min="1" :max="365" style="width: 100%" /></a-form-item>
          </a-col>
        </a-row>
      </a-form>
    </a-modal>

    <a-modal v-model:open="keyOpen" :title="t('tracked.youtubeKey')" :footer="null" :width="MODAL_WIDTH.md" destroy-on-close>
      <YoutubeKeySettings />
    </a-modal>
  </PageContainer>
</template>

<style scoped>
.num { font-variant-numeric: tabular-nums; }
.up { color: var(--cp-success); }
.down { color: var(--cp-error); }
</style>
