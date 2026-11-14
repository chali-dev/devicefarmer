<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { SettingOutlined } from '@ant-design/icons-vue'
import { useI18n } from 'vue-i18n'
import { api } from '../api/client'
import type { MediaLimits } from '../api/types'
import { useAuthStore } from '../stores/auth'
import MediaPanel from '../components/media/MediaPanel.vue'
import StorageSettingsModal from '../components/media/StorageSettingsModal.vue'

/** Media library (素材库): public / my media / favorites. */
const auth = useAuthStore()
const route = useRoute()
const router = useRouter()
const { t } = useI18n()

type Tab = 'public' | 'mine' | 'favorites'
const TABS: Tab[] = ['public', 'mine', 'favorites']
const tab = computed<Tab>({
  get: () => (TABS.includes(route.query.tab as Tab) ? (route.query.tab as Tab) : 'public'),
  set: (v) => { void router.replace({ query: { ...route.query, tab: v } }) },
})
const limits = ref<MediaLimits | null>(null)
const storageOpen = ref(false)
onMounted(async () => { try { limits.value = await api<MediaLimits>('GET', '/api/media/limits') } catch { /* uploads are still validated server-side */ } })
</script>

<template>
  <a-card :title="t('media.title')" size="small">
    <template #extra>
      <a-button v-if="auth.isAdmin" size="small" @click="storageOpen = true"><SettingOutlined /> {{ t('media.storageSettings') }}</a-button>
    </template>
    <a-tabs v-model:active-key="tab" destroy-inactive-tab-pane>
      <a-tab-pane v-for="k in TABS" :key="k" :tab="t(`media.tabs.${k}`)">
        <MediaPanel :tab="k" :limits="limits" />
      </a-tab-pane>
    </a-tabs>
  </a-card>
  <StorageSettingsModal v-if="auth.isAdmin" v-model:open="storageOpen" />
</template>
