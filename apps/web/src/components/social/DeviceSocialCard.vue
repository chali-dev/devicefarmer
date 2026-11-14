<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { api, errorText } from '../../api/client'
import { SOCIAL_ACCOUNT_COLOR, SOCIAL_LOGIN_COLOR, type SocialAccount } from '../../api/types'
import PlatformTag from './PlatformTag.vue'

/** Read-only list of the social accounts linked to a device (the caller's own; admins see all). */
const props = defineProps<{ instanceId: string }>()
const { t } = useI18n()
const items = ref<SocialAccount[]>([])
const error = ref('')

async function load() {
  try {
    items.value = (await api<{ items: SocialAccount[] }>('GET', `/api/social/accounts?instanceId=${props.instanceId}&pageSize=50`)).items
    error.value = ''
  } catch (e) { error.value = errorText(e) }
}
onMounted(load)
watch(() => props.instanceId, load)
</script>

<template>
  <a-card size="small" :title="t('social.deviceCard')">
    <template #extra>
      <router-link :to="{ path: '/social', query: { instanceId } }">{{ t('social.manage') }}</router-link>
    </template>
    <div v-if="error" class="hint">{{ error }}</div>
    <div v-else-if="!items.length" class="hint">{{ t('social.deviceNone') }}</div>
    <div v-for="a in items" v-else :key="a.id" class="row">
      <PlatformTag :platform="a.platform" />
      <span class="handle">{{ '@' + a.handle }}</span>
      <a-tag :color="SOCIAL_LOGIN_COLOR[a.loginStatus]">{{ t(`social.login.${a.loginStatus}`) }}</a-tag>
      <a-tag v-if="a.accountStatus !== 'active'" :color="SOCIAL_ACCOUNT_COLOR[a.accountStatus]">{{ t(`social.account.${a.accountStatus}`) }}</a-tag>
    </div>
  </a-card>
</template>

<style scoped>
.row { display: flex; align-items: center; gap: 8px; padding: 2px 0; flex-wrap: wrap; }
.handle { font-weight: 500; }
.hint { color: var(--cp-text-secondary); }
</style>
