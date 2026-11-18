<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { api } from '../api/client'
import type { SettingsConfig } from '../api/types'
import AiSettings from '../components/settings/AiSettings.vue'
import MediaLimitSettings from '../components/settings/MediaLimitSettings.vue'
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
 * formerly /system and the 数据保留 tab), 发布任务, 素材上传, 存储, AI and 追踪采集. The former read-only 环境变量 tab is gone:
 * its values are the defaults of 发布任务 / 素材上传 (shown as a hint under each field), AUDIT_RETENTION_DAYS stays
 * read-only in 备份与保留. The active tab is
 * in the URL (?tab=), so other pages link straight to their settings (e.g. /settings?tab=storage). The alert rules
 * moved to 告警通道 (?tab=rules), the system logs to 系统日志 (/logs).
 */
const { t } = useI18n()
const platforms = usePlatformsStore()
const route = useRoute()
const router = useRouter()

const TABS = ['backup', 'publishRetry', 'media', 'storage', 'ai', 'tracked'] as const
type Tab = (typeof TABS)[number]
// Old tab names (links from before the regrouping).
const ALIASES: Record<string, Tab> = { retention: 'backup', backups: 'backup', publish: 'publishRetry', publishTask: 'publishRetry', env: 'publishRetry' }
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
        <a-tab-pane key="media" :tab="t('settings.tabs.media')"><MediaLimitSettings /></a-tab-pane>
        <a-tab-pane key="storage" :tab="t('settings.tabs.storage')"><StorageSettings /></a-tab-pane>
        <a-tab-pane key="ai" :tab="t('settings.tabs.ai')"><AiSettings /></a-tab-pane>
        <a-tab-pane v-if="platforms.scope.features.youtubeKey || platforms.scope.features.trackedCollector" key="tracked" :tab="t('settings.tabs.tracked')">
          <TrackedCollectorSettings v-if="platforms.scope.features.trackedCollector" />
          <a-divider v-if="platforms.scope.features.youtubeKey && platforms.scope.features.trackedCollector" />
          <YoutubeKeySettings v-if="platforms.scope.features.youtubeKey" />
        </a-tab-pane>
      </a-tabs>
    </a-card>
  </PageContainer>
</template>

