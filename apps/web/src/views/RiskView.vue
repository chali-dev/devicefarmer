<script setup lang="ts">
import { computed, type Component } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import PageContainer from '../components/common/PageContainer.vue'
import SocialLimitsSettings from '../components/settings/SocialLimitsSettings.vue'
import CommentSendSettings from '../components/risk/CommentSendSettings.vue'
import DevicePublishSettings from '../components/risk/DevicePublishSettings.vue'
import RiskPaceSettings from '../components/risk/RiskPaceSettings.vue'

/**
 * 风控配置 (风控管理, admin; layout = owner's menu list of 2026-11-18): 媒体号发文限制, 回复限制, 采集限制 (pace +
 * 帖子与评论采集), 检测限制 (account checks + 自动发现) and 账号上限; 风控记录 is its own page (/risk-events). Each section is one entry of SECTIONS (tab key = ?tab=, label = risk.tabs.<key>); a new
 * section is one component + one entry here. The per-device state (风控暂停 + 恢复, busy) is shown on the 云机管理
 * cards since 2026-11-18 (owner decision), not here; 评论回复 holds both the reply rules and the cloud-phone limits.
 */
const { t } = useI18n()
const route = useRoute()
const router = useRouter()

const SECTIONS: { key: string; component: Component; props?: Record<string, unknown> }[] = [
  { key: 'devicePublish', component: DevicePublishSettings },
  { key: 'comments', component: CommentSendSettings },
  { key: 'collect', component: RiskPaceSettings, props: { part: 'collect' } },
  { key: 'check', component: RiskPaceSettings, props: { part: 'check' } },
  { key: 'limits', component: SocialLimitsSettings },
]
// Old links: ?tab=pace → 采集限制, ?tab=events → the 风控记录 page.
if (route.query.tab === 'events') void router.replace({ path: '/risk-events', query: { ...route.query, tab: undefined } })
const ALIASES: Record<string, string> = { pace: 'collect' }
const tab = computed<string>({
  get: () => {
    const q = ALIASES[String(route.query.tab)] ?? String(route.query.tab)
    return SECTIONS.some((s) => s.key === q) ? q : SECTIONS[0]!.key
  },
  set: (v) => { void router.replace({ query: { ...route.query, tab: v } }) },
})
</script>

<template>
  <PageContainer>
    <a-card :bordered="false">
      <a-tabs v-model:active-key="tab" destroy-inactive-tab-pane>
        <a-tab-pane v-for="s in SECTIONS" :key="s.key" :tab="t(`risk.tabs.${s.key}`)">
          <component :is="s.component" v-bind="s.props ?? {}" />
        </a-tab-pane>
      </a-tabs>
    </a-card>
  </PageContainer>
</template>
