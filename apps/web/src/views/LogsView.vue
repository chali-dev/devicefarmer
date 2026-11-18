<script setup lang="ts">
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import DeviceLogPanel from '../components/system/DeviceLogPanel.vue'
import LogPanel from '../components/system/LogPanel.vue'
import PageContainer from '../components/common/PageContainer.vue'

/** 系统日志 (系统配置, admin): the API's own log lines and the aggregated 设备日志 of every device. Tab in the URL (?tab=). */
const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const TABS = ['system', 'devices'] as const
type Tab = (typeof TABS)[number]
const tab = computed<Tab>({
  get: () => (TABS.includes(route.query.tab as Tab) ? (route.query.tab as Tab) : 'system'),
  set: (v) => { void router.replace({ query: { ...route.query, tab: v } }) },
})
</script>

<template>
  <PageContainer>
    <a-card :bordered="false">
      <a-tabs v-model:active-key="tab" destroy-inactive-tab-pane>
        <a-tab-pane key="system" :tab="t('sysadmin.tabs.logs')"><LogPanel /></a-tab-pane>
        <a-tab-pane key="devices" :tab="t('sysadmin.tabs.deviceLogs')"><DeviceLogPanel /></a-tab-pane>
      </a-tabs>
    </a-card>
  </PageContainer>
</template>
