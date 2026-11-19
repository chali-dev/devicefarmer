<script setup lang="ts">
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import AiSettings from '../components/settings/AiSettings.vue'
import MediaLimitSettings from '../components/settings/MediaLimitSettings.vue'
import StorageSettings from '../components/settings/StorageSettings.vue'
import TaskTimeoutSettings from '../components/settings/TaskTimeoutSettings.vue'
import BackupPanel from '../components/system/BackupPanel.vue'
import LogRetentionSettings from '../components/system/LogRetentionSettings.vue'
import PageContainer from '../components/common/PageContainer.vue'

/**
 * 系统配置 (admin, owner's menu list of 2026-11-18): 数据 (database backups) and 日志 (every log / history retention in
 * one form, 2026-11-19) — the former 备份与保留 tab split on 2026-11-19 (old ?tab=backup → data), 任务超时 (formerly 发布任务, ?tab=publishRetry), 素材上传, 存储 and AI.
 * The former read-only 环境变量 tab is gone: env values are only defaults. The active tab is
 * in the URL (?tab=), so other pages link straight to their settings (e.g. /settings?tab=storage). The alert rules
 * moved to 告警通道 (?tab=rules), the system logs to 系统日志 (/logs). The former 追踪采集 tab (?tab=tracked) is gone
 * (2026-11-19): every tracked account picks its own 采集手机, the YouTube API key moved to 趋势热点 (/trending?youtubeKey=1).
 */
const { t } = useI18n()
const route = useRoute()
const router = useRouter()

const TABS = ['data', 'logRetention', 'timeouts', 'media', 'storage', 'ai'] as const
type Tab = (typeof TABS)[number]
// Old tab names (links from before the regrouping).
const ALIASES: Record<string, Tab> = { backup: 'data', retention: 'data', backups: 'data', publish: 'timeouts', publishTask: 'timeouts', publishRetry: 'timeouts', env: 'timeouts' }
if (route.query.tab === 'alerts') void router.replace({ path: '/alert-channels', query: { tab: 'rules' } })
else if (route.query.tab === 'logs') void router.replace({ path: '/logs' })
else if (route.query.tab === 'tracked') void router.replace({ path: '/trending', query: { youtubeKey: '1' } })
const tab = computed<Tab>({
  get: () => {
    const q = ALIASES[String(route.query.tab)] ?? (route.query.tab as Tab)
    return TABS.includes(q) ? q : 'data'
  },
  set: (v) => { void router.replace({ query: { ...route.query, tab: v } }) },
})

</script>

<template>
  <PageContainer>
    <a-card :bordered="false">
      <a-tabs v-model:active-key="tab" destroy-inactive-tab-pane>
        <a-tab-pane key="data" :tab="t('settings.tabs.data')">
          <BackupPanel />
        </a-tab-pane>
        <a-tab-pane key="logRetention" :tab="t('settings.tabs.logRetention')">
          <LogRetentionSettings />
        </a-tab-pane>
        <a-tab-pane key="timeouts" :tab="t('settings.tabs.timeouts')"><TaskTimeoutSettings /></a-tab-pane>
        <a-tab-pane key="media" :tab="t('settings.tabs.media')"><MediaLimitSettings /></a-tab-pane>
        <a-tab-pane key="storage" :tab="t('settings.tabs.storage')"><StorageSettings /></a-tab-pane>
        <a-tab-pane key="ai" :tab="t('settings.tabs.ai')"><AiSettings /></a-tab-pane>
      </a-tabs>
    </a-card>
  </PageContainer>
</template>

