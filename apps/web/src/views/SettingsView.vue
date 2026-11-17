<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { api } from '../api/client'
import type { SettingsConfig } from '../api/types'
import AlertSettings from '../components/settings/AlertSettings.vue'
import PlatformSettings from '../components/settings/PlatformSettings.vue'
import RetentionSettings from '../components/settings/RetentionSettings.vue'
import SocialLimitsSettings from '../components/settings/SocialLimitsSettings.vue'
import StorageSettings from '../components/settings/StorageSettings.vue'
import SystemInfo from '../components/settings/SystemInfo.vue'
import YoutubeKeySettings from '../components/settings/YoutubeKeySettings.vue'

/**
 * Settings (设置, admin): one page whose tabs reuse the existing settings APIs. The active tab is in the
 * URL (?tab=), so other pages link straight to their settings (e.g. /settings?tab=storage).
 */
const { t } = useI18n()
const route = useRoute()
const router = useRouter()

const TABS = ['storage', 'platforms', 'tracked', 'social', 'publish', 'retention', 'system', 'alerts'] as const
type Tab = (typeof TABS)[number]
const tab = computed<Tab>({
  get: () => (TABS.includes(route.query.tab as Tab) ? (route.query.tab as Tab) : 'storage'),
  set: (v) => { void router.replace({ query: { ...route.query, tab: v } }) },
})

const cfg = ref<SettingsConfig | null>(null)
onMounted(async () => { try { cfg.value = await api<SettingsConfig>('GET', '/api/settings/config') } catch { /* tabs show — */ } })
const secs = (ms: number) => `${Math.round(ms / 1000)} s`
</script>

<template>
  <a-card :title="t('settings.title')" size="small">
    <a-tabs v-model:active-key="tab" destroy-inactive-tab-pane>
      <a-tab-pane key="storage" :tab="t('settings.tabs.storage')"><StorageSettings /></a-tab-pane>
      <a-tab-pane key="platforms" :tab="t('settings.tabs.platforms')"><PlatformSettings /></a-tab-pane>
      <a-tab-pane key="tracked" :tab="t('settings.tabs.tracked')"><YoutubeKeySettings /></a-tab-pane>
      <a-tab-pane key="social" :tab="t('settings.tabs.social')"><SocialLimitsSettings /></a-tab-pane>
      <a-tab-pane key="publish" :tab="t('settings.tabs.publish')">
        <div class="settings-pane">
          <p class="muted">{{ t('settings.publish.hint') }}</p>
          <a-descriptions size="small" :column="1" bordered>
            <a-descriptions-item :label="t('settings.publish.maxAttempts')">
              {{ cfg?.publish.maxAttempts ?? '—' }} <a-tag class="ro">PUBLISH_MAX_ATTEMPTS</a-tag>
            </a-descriptions-item>
            <a-descriptions-item :label="t('settings.publish.timeout')">
              {{ cfg ? secs(cfg.publish.timeoutMs) : '—' }} <a-tag class="ro">PUBLISH_TIMEOUT_MS</a-tag>
            </a-descriptions-item>
            <a-descriptions-item :label="t('settings.publish.backoff')">
              {{ cfg ? secs(cfg.publish.retryBackoffMs) : '—' }} <a-tag class="ro">PUBLISH_RETRY_BACKOFF_MS</a-tag>
            </a-descriptions-item>
          </a-descriptions>
          <h4 class="sub">{{ t('settings.publish.mediaTitle') }}</h4>
          <a-descriptions size="small" :column="1" bordered>
            <a-descriptions-item :label="t('settings.publish.imageMax')">{{ cfg ? `${cfg.media.imageMaxMb} MB` : '—' }} <a-tag class="ro">MEDIA_IMAGE_MAX_MB</a-tag></a-descriptions-item>
            <a-descriptions-item :label="t('settings.publish.videoMax')">{{ cfg ? `${cfg.media.videoMaxMb} MB` : '—' }} <a-tag class="ro">MEDIA_VIDEO_MAX_MB</a-tag></a-descriptions-item>
            <a-descriptions-item :label="t('settings.publish.types')">{{ cfg?.media.allowedTypes.join(', ') ?? '—' }} <a-tag class="ro">MEDIA_ALLOWED_TYPES</a-tag></a-descriptions-item>
          </a-descriptions>
        </div>
      </a-tab-pane>
      <a-tab-pane key="retention" :tab="t('settings.tabs.retention')"><RetentionSettings :audit-retention-days="cfg?.auditRetentionDays ?? null" /></a-tab-pane>
      <a-tab-pane key="system" :tab="t('settings.tabs.system')"><SystemInfo /></a-tab-pane>
      <a-tab-pane key="alerts" :tab="t('alerts.settings.tab')"><AlertSettings /></a-tab-pane>
    </a-tabs>
  </a-card>
</template>

<style scoped>
.settings-pane { max-width: 640px; }
.muted { color: var(--cp-text-tertiary); }
.ro { margin-left: 8px; font-family: monospace; font-size: 11px; }
.sub { margin-top: 20px; }
</style>
