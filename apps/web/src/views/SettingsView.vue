<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { api } from '../api/client'
import type { SettingsConfig } from '../api/types'
import AiSettings from '../components/settings/AiSettings.vue'
import PublishRetrySettings from '../components/settings/PublishRetrySettings.vue'
import RetentionSettings from '../components/settings/RetentionSettings.vue'
import StorageSettings from '../components/settings/StorageSettings.vue'
import YoutubeKeySettings from '../components/settings/YoutubeKeySettings.vue'
import TrackedCollectorSettings from '../components/settings/TrackedCollectorSettings.vue'
import BackupPanel from '../components/system/BackupPanel.vue'
import LogRetentionSettings from '../components/system/LogRetentionSettings.vue'
import PageContainer from '../components/common/PageContainer.vue'
import { usePlatformsStore } from '../stores/platforms'

/**
 * 系统配置 (admin, owner's menu list of 2026-11-18): 备份与保留 (database backups + log / history / task retention,
 * formerly /system and the 数据保留 tab), 发布重发, 存储, AI, 追踪采集 and the read-only env values. The active tab is
 * in the URL (?tab=), so other pages link straight to their settings (e.g. /settings?tab=storage). The alert rules
 * moved to 告警通道 (?tab=rules), the system logs to 系统日志 (/logs).
 */
const { t } = useI18n()
const platforms = usePlatformsStore()
const route = useRoute()
const router = useRouter()

const TABS = ['backup', 'publishRetry', 'storage', 'ai', 'tracked', 'env'] as const
type Tab = (typeof TABS)[number]
// Old tab names (links from before the regrouping).
const ALIASES: Record<string, Tab> = { retention: 'backup', backups: 'backup', publish: 'publishRetry' }
if (route.query.tab === 'alerts') void router.replace({ path: '/alert-channels', query: { tab: 'rules' } })
else if (route.query.tab === 'logs') void router.replace({ path: '/logs' })
const tab = computed<Tab>({
  get: () => {
    const q = ALIASES[String(route.query.tab)] ?? (route.query.tab as Tab)
    return TABS.includes(q) ? q : 'backup'
  },
  set: (v) => { void router.replace({ query: { ...route.query, tab: v } }) },
})

const cfg = ref<SettingsConfig | null>(null)
onMounted(async () => { try { cfg.value = await api<SettingsConfig>('GET', '/api/settings/config') } catch { /* tabs show — */ } })
const secs = (ms: number) => `${Math.round(ms / 1000)} s`
/** Read-only values from the API's environment (publish defaults, media limits). */
const envGroups = computed(() => {
  const c = cfg.value
  return [
    { title: t('settings.publish.publishTitle'), rows: [
      { label: t('settings.publish.maxAttemptsDefault'), value: c?.publish.maxAttempts ?? '—', env: 'PUBLISH_MAX_ATTEMPTS' },
      { label: t('settings.publish.timeout'), value: c ? secs(c.publish.timeoutMs) : '—', env: 'PUBLISH_TIMEOUT_MS' },
      { label: t('settings.publish.backoffDefault'), value: c ? secs(c.publish.retryBackoffMs) : '—', env: 'PUBLISH_RETRY_BACKOFF_MS' },
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
        <a-tab-pane key="backup" :tab="t('settings.tabs.backup')">
          <BackupPanel />
          <a-divider />
          <LogRetentionSettings />
          <a-divider />
          <RetentionSettings :audit-retention-days="cfg?.auditRetentionDays ?? null" />
        </a-tab-pane>
        <a-tab-pane key="publishRetry" :tab="t('settings.tabs.publishRetry')"><PublishRetrySettings /></a-tab-pane>
        <a-tab-pane key="storage" :tab="t('settings.tabs.storage')"><StorageSettings /></a-tab-pane>
        <a-tab-pane key="ai" :tab="t('settings.tabs.ai')"><AiSettings /></a-tab-pane>
        <a-tab-pane v-if="platforms.scope.features.youtubeKey || platforms.scope.features.trackedCollector" key="tracked" :tab="t('settings.tabs.tracked')">
          <TrackedCollectorSettings v-if="platforms.scope.features.trackedCollector" />
          <a-divider v-if="platforms.scope.features.youtubeKey && platforms.scope.features.trackedCollector" />
          <YoutubeKeySettings v-if="platforms.scope.features.youtubeKey" />
        </a-tab-pane>
        <a-tab-pane key="env" :tab="t('settings.tabs.env')">
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
      </a-tabs>
    </a-card>
  </PageContainer>
</template>

<style scoped>
.settings-pane { max-width: 640px; }
.env { margin-inline-start: 8px; font-size: 11px; max-width: 100%; white-space: normal; word-break: break-all; }
.block { margin-top: 24px; }
</style>
