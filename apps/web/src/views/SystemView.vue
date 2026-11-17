<script setup lang="ts">
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import BackupPanel from '../components/system/BackupPanel.vue'
import LogPanel from '../components/system/LogPanel.vue'
import PageContainer from '../components/common/PageContainer.vue'

/** System maintenance (系统维护, admin): database backups and API logs. The tab is in the URL (?tab=). */
const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const TABS = ['backups', 'logs'] as const
type Tab = (typeof TABS)[number]
const tab = computed<Tab>({
  get: () => (TABS.includes(route.query.tab as Tab) ? (route.query.tab as Tab) : 'backups'),
  set: (v) => { void router.replace({ query: { ...route.query, tab: v } }) },
})
</script>

<template>
  <PageContainer>
    <a-card :bordered="false">
      <a-tabs v-model:active-key="tab" destroy-inactive-tab-pane>
        <a-tab-pane key="backups" :tab="t('sysadmin.tabs.backups')"><BackupPanel /></a-tab-pane>
        <a-tab-pane key="logs" :tab="t('sysadmin.tabs.logs')"><LogPanel /></a-tab-pane>
      </a-tabs>
    </a-card>
  </PageContainer>
</template>
