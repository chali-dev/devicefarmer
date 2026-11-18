<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { api } from '../api/client'
import type { SettingsConfig } from '../api/types'
import AiSettings from '../components/settings/AiSettings.vue'
import AlertSettings from '../components/settings/AlertSettings.vue'
import RetentionSettings from '../components/settings/RetentionSettings.vue'
import StorageSettings from '../components/settings/StorageSettings.vue'
import YoutubeKeySettings from '../components/settings/YoutubeKeySettings.vue'
import TrackedCollectorSettings from '../components/settings/TrackedCollectorSettings.vue'
import PageContainer from '../components/common/PageContainer.vue'
import { usePlatformsStore } from '../stores/platforms'

/**
 * Settings (设置, admin): one page whose tabs reuse the existing settings APIs. The active tab is in the
 * URL (?tab=), so other pages link straight to their settings (e.g. /settings?tab=storage).
 */
const { t } = useI18n()
const platforms = usePlatformsStore()
const route = useRoute()
const router = useRouter()

const TABS = ['storage', 'tracked', 'publish', 'ai', 'retention', 'alerts'] as const
type Tab = (typeof TABS)[number]
const tab = computed<Tab>({
  get: () => (TABS.includes(route.query.tab as Tab) ? (route.query.tab as Tab) : 'storage'),
  set: (v) => { void router.replace({ query: { ...route.query, tab: v } }) },
})

const cfg = ref<SettingsConfig | null>(null)
onMounted(async () => { try { cfg.value = await api<SettingsConfig>('GET', '/api/settings/config') } catch { /* tabs show — */ } })
const secs = (ms: number) => `${Math.round(ms / 1000)} s`
/** Read-only values from the API's environment (publish defaults, media limits). */
const envGroups = computed(() => {
  const c = cfg.value
  return [
    { title: undefined, rows: [
      { label: t('settings.publish.maxAttempts'), value: c?.publish.maxAttempts ?? '—', env: 'PUBLISH_MAX_ATTEMPTS' },
      { label: t('settings.publish.timeout'), value: c ? secs(c.publish.timeoutMs) : '—', env: 'PUBLISH_TIMEOUT_MS' },
      { label: t('settings.publish.backoff'), value: c ? secs(c.publish.retryBackoffMs) : '—', env: 'PUBLISH_RETRY_BACKOFF_MS' },
    ] },
    { title: t('settings.publish.mediaTitle'), rows: [
      { label: t('settings.publish.imageMax'), value: c ? `${c.media.imageMaxMb} MB` : '—', env: 'MEDIA_IMAGE_MAX_MB' },
      { label: t('settings.publish.videoMax'), value: c ? `${c.media.videoMaxMb} MB` : '—', env: 'MEDIA_VIDEO_MAX_MB' },
      { label: t('settings.publish.types'), value: c?.media.allowedTypes.join(', ') ?? '—', env: 'MEDIA_ALLOWED_TYPES' },
    ] },
  ]
})
</script>

<template>
  <PageContainer>
    <a-card :bordered="false">
      <a-tabs v-model:active-key="tab" destroy-inactive-tab-pane>
        <a-tab-pane key="storage" :tab="t('settings.tabs.storage')"><StorageSettings /></a-tab-pane>
        <a-tab-pane v-if="platforms.scope.features.youtubeKey || platforms.scope.features.trackedCollector" key="tracked" :tab="t('settings.tabs.tracked')">
          <TrackedCollectorSettings v-if="platforms.scope.features.trackedCollector" />
          <a-divider v-if="platforms.scope.features.youtubeKey && platforms.scope.features.trackedCollector" />
          <YoutubeKeySettings v-if="platforms.scope.features.youtubeKey" />
        </a-tab-pane>
        <a-tab-pane key="publish" :tab="t('settings.tabs.publish')">
          <div class="settings-pane">
            <a-descriptions
              v-for="(group, gi) in envGroups" :key="gi" size="small" :column="1" bordered :title="group.title" :class="{ block: gi > 0 }"
            >
              <a-descriptions-item v-for="r in group.rows" :key="r.env" :label="r.label">
                {{ r.value }}
                <a-tooltip :title="t('settings.readOnlyEnv', { name: r.env })"><a-tag class="env mono">{{ r.env }}</a-tag></a-tooltip>
              </a-descriptions-item>
            </a-descriptions>
          </div>
        </a-tab-pane>
        <a-tab-pane key="ai" :tab="t('settings.tabs.ai')"><AiSettings /></a-tab-pane>
        <a-tab-pane key="retention" :tab="t('settings.tabs.retention')"><RetentionSettings :audit-retention-days="cfg?.auditRetentionDays ?? null" /></a-tab-pane>
        <a-tab-pane key="alerts" :tab="t('alerts.settings.tab')"><AlertSettings /></a-tab-pane>
      </a-tabs>
    </a-card>
  </PageContainer>
</template>

<style scoped>
.settings-pane { max-width: 640px; }
.env { margin-inline-start: 8px; font-size: 11px; max-width: 100%; white-space: normal; word-break: break-all; }
.block { margin-top: 24px; }
</style>
