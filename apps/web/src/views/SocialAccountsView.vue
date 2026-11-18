<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import PageContainer from '../components/common/PageContainer.vue'
import CommentsPanel from '../components/comments/CommentsPanel.vue'
import PublishLogPanel from '../components/publish/PublishLogPanel.vue'
import MyAccountsPanel from '../components/social/MyAccountsPanel.vue'
import TrackedAccountsPanel from '../components/tracked/TrackedAccountsPanel.vue'

/**
 * 媒体管理 (owner's menu list, 2026-11-18): 我的媒体号 / 追踪号 / 发文日志 / 回文日志 in one page, the tab in `?tab=`.
 * The former 追踪账号 (/tracked) and 评论互动 (/comments) pages are these tabs (the router redirects old links).
 * Only the shown tab is mounted; its header actions are teleported into the page header.
 */
const route = useRoute()
const router = useRouter()
const { t } = useI18n()

type Tab = 'accounts' | 'tracked' | 'publishLog' | 'replies'
const TABS: Tab[] = ['accounts', 'tracked', 'publishLog', 'replies']
const tab = computed<Tab>({
  get: () => (TABS.includes(route.query.tab as Tab) ? (route.query.tab as Tab) : 'accounts'),
  // A tab's filters live in the query too (?q=, ?status=, ?account= …): switching starts the other tab unfiltered.
  set: (v) => { void router.replace({ query: { tab: v } }) },
})
const EXTRA = '#cp-social-extra'
</script>

<template>
  <PageContainer :title="t('nav.social')">
    <template #extra><div id="cp-social-extra" class="tab-extra" /></template>
    <a-card :bordered="false" class="tabs-card">
      <a-tabs v-model:active-key="tab" destroy-inactive-tab-pane>
        <a-tab-pane key="accounts" :tab="t('social.tabs.accounts')"><MyAccountsPanel :extra-to="EXTRA" /></a-tab-pane>
        <a-tab-pane key="tracked" :tab="t('social.tabs.tracked')"><TrackedAccountsPanel :extra-to="EXTRA" /></a-tab-pane>
        <a-tab-pane key="publishLog" :tab="t('social.tabs.publishLog')"><PublishLogPanel /></a-tab-pane>
        <a-tab-pane key="replies" :tab="t('social.tabs.replies')"><CommentsPanel :extra-to="EXTRA" /></a-tab-pane>
      </a-tabs>
    </a-card>
  </PageContainer>
</template>

<style scoped>
.tab-extra { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 8px; }
.tabs-card :deep(.ant-card-body) { padding-top: 4px; }
</style>
