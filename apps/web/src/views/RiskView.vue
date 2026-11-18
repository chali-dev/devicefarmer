<script setup lang="ts">
import { computed, type Component } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import PageContainer from '../components/common/PageContainer.vue'
import SocialLimitsSettings from '../components/settings/SocialLimitsSettings.vue'
import CommentSendSettings from '../components/risk/CommentSendSettings.vue'
import DevicePublishSettings from '../components/risk/DevicePublishSettings.vue'
import RiskEvents from '../components/risk/RiskEvents.vue'
import RiskPaceSettings from '../components/risk/RiskPaceSettings.vue'

/**
 * 风控 (admin): every rule that limits what the platform does with the operators' media accounts and phones,
 * in one place. Each section is one entry of SECTIONS (tab key = ?tab=, label = risk.tabs.<key>); a new
 * section is one component + one entry here. The per-device state (风控暂停 + 恢复, busy) is shown on the 云机管理
 * cards since 2026-11-18 (owner decision), not here; 评论回复 holds both the reply rules and the cloud-phone limits.
 */
const { t } = useI18n()
const route = useRoute()
const router = useRouter()

const SECTIONS: { key: string; component: Component }[] = [
  { key: 'pace', component: RiskPaceSettings },
  { key: 'limits', component: SocialLimitsSettings },
  { key: 'comments', component: CommentSendSettings },
  { key: 'devicePublish', component: DevicePublishSettings },
  { key: 'events', component: RiskEvents },
]
const tab = computed<string>({
  get: () => (SECTIONS.some((s) => s.key === route.query.tab) ? String(route.query.tab) : SECTIONS[0]!.key),
  set: (v) => { void router.replace({ query: { ...route.query, tab: v } }) },
})
</script>

<template>
  <PageContainer>
    <a-card :bordered="false">
      <a-tabs v-model:active-key="tab" destroy-inactive-tab-pane>
        <a-tab-pane v-for="s in SECTIONS" :key="s.key" :tab="t(`risk.tabs.${s.key}`)">
          <component :is="s.component" />
        </a-tab-pane>
      </a-tabs>
    </a-card>
  </PageContainer>
</template>
