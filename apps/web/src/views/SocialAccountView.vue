<script setup lang="ts">
import { SyncOutlined } from '@ant-design/icons-vue'
import { message } from 'ant-design-vue'
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { ApiError, api, errorText } from '../api/client'
import { compactNumber, type AccountFollowers, type AccountFollowing, type SocialAccount } from '../api/types'
import PageContainer from '../components/common/PageContainer.vue'
import { usePageCrumb } from '../components/common/menu'
import StatusTag from '../components/common/StatusTag.vue'
import AudienceList from '../components/social/AudienceList.vue'
import InitialAvatar from '../components/social/InitialAvatar.vue'
import PlatformTag from '../components/social/PlatformTag.vue'
import { useAccountSync } from '../components/social/useAccountSync'
import { fmtDateTime } from '../i18n'

/**
 * A media account's 关注 / 粉丝 page (/social/accounts/:id, owner 2026-11-19, replaces the row expansion of 我的媒体号):
 * header breadcrumb 我的媒体 / @handle (owner 2026-11-19), the account card with its one 同步 button, tabs 关注 (the following list read from its cloud phone) and 粉丝
 * (the account's own follower count, then only its newest ≤ 20 followers read from the phone; owner 2026-11-19).
 * RBAC = the account's (owner + admins; others get the API's 404 → not-found state).
 */
const route = useRoute()
const router = useRouter()
const { t } = useI18n()
const id = computed(() => String(route.params.id))

const account = ref<SocialAccount | null>(null)
const notFound = ref(false)
const loading = ref(false)
async function loadAccount() {
  loading.value = true
  try {
    account.value = (await api<{ account: SocialAccount }>('GET', `/api/social/accounts/${id.value}`)).account
    notFound.value = false
  } catch (e) {
    if (e instanceof ApiError && (e.status === 404 || e.status === 400)) notFound.value = true
    else message.error(errorText(e))
  } finally { loading.value = false }
}

// 粉丝: the account's own follower count (latest reading of the automatic check / sync)
const fol = ref<AccountFollowers | null>(null)
async function loadFollowers() {
  try { fol.value = await api<AccountFollowers>('GET', `/api/social/accounts/${id.value}/followers?days=7`) } catch { fol.value = null }
}
const followersCount = computed(() => (fol.value?.current ? `${fol.value.current.approx ? '≈' : ''}${compactNumber(fol.value.current.followers)}` : '—'))

// 关注: count for the tab label (the list itself reports it again whenever it loads)
const followingCount = ref<number | null>(null)
async function loadFollowingCount() {
  try { followingCount.value = (await api<AccountFollowing>('GET', `/api/social/accounts/${id.value}/following?limit=1`)).current } catch { followingCount.value = null }
}

const tab = computed<'following' | 'followers'>({
  get: () => (route.query.tab === 'followers' ? 'followers' : 'following'),
  set: (v) => { void router.replace({ query: { ...route.query, tab: v } }) },
})

const { syncing, syncLabel, syncDisabled, syncNow } = useAccountSync(() => { void loadAccount(); void loadFollowers() })

const profileLink = computed(() => account.value?.profileUrl || (account.value?.platform === 'instagram' ? `https://www.instagram.com/${account.value.handle}/` : null))
const back = () => router.push({ path: '/social', query: { tab: 'accounts' } })
usePageCrumb(() => (account.value ? { label: `@${account.value.handle}`, parentTo: '/social?tab=accounts' } : null))

function loadAll() { void loadAccount(); void loadFollowers(); void loadFollowingCount() }
onMounted(loadAll)
watch(id, loadAll)
</script>

<template>
  <PageContainer title="">

    <a-card v-if="notFound" :bordered="false">
      <a-result status="404" :sub-title="t('social.audience.page.notFound')">
        <template #extra><a-button type="primary" @click="back">{{ t('social.audience.page.back') }}</a-button></template>
      </a-result>
    </a-card>

    <template v-else>
      <a-card :bordered="false" :loading="loading && !account">
        <div v-if="account" class="head">
          <InitialAvatar :name="account.displayName" :handle="account.handle" :size="56" />
          <div class="who">
            <div class="line">
              <PlatformTag :platform="account.platform" icon-only />
              <a v-if="profileLink" :href="profileLink" target="_blank" rel="noopener noreferrer" class="handle">@{{ account.handle }}</a>
              <span v-else class="handle">@{{ account.handle }}</span>
              <StatusTag kind="socialLogin" :status="account.loginStatus" />
            </div>
            <div v-if="account.displayName" class="name">{{ account.displayName }}</div>
            <div class="muted small">
              {{ account.lastCheckedAt ? t('social.audience.page.lastSync', { time: fmtDateTime(account.lastCheckedAt) }) : t('social.audience.page.neverSync') }}
            </div>
          </div>
          <a-space wrap class="actions">
            <a-tooltip :title="syncDisabled(account) ? t('social.syncNoDevice') : t('social.syncNowHint')">
              <a-button type="primary" :disabled="syncDisabled(account)" :loading="!!syncing[account.id]" @click="syncNow(account)">
                <template #icon><SyncOutlined /></template>{{ syncLabel(account.id) }}
              </a-button>
            </a-tooltip>
          </a-space>
        </div>
      </a-card>

      <a-card v-if="account" :bordered="false" class="tabs-card">
        <a-tabs v-model:active-key="tab">
          <a-tab-pane key="following" :tab="t('social.audience.page.followingTab', { n: followingCount ?? '—' })">
            <AudienceList :account-id="account.id" kind="following" @loaded="(d) => (followingCount = d.current)" />
          </a-tab-pane>
          <a-tab-pane key="followers" :tab="t('social.audience.page.followersTab', { n: followersCount })">
            <AudienceList :account-id="account.id" kind="followers" :count="followersCount" />
          </a-tab-pane>
        </a-tabs>
      </a-card>
    </template>
  </PageContainer>
</template>

<style scoped>
.head { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; }
.who { flex: 1 1 240px; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.line { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.line .ant-tag { margin-inline-end: 0; }
.handle { font-size: 18px; font-weight: 600; word-break: break-all; }
.name { color: var(--cp-text-secondary); }
.actions { flex: none; }
.tabs-card :deep(.ant-card-body) { padding-top: 4px; }
</style>
