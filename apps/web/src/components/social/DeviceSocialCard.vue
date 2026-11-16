<script setup lang="ts">
import { message } from 'ant-design-vue'
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { api, errorText } from '../../api/client'
import { SOCIAL_ACCOUNT_COLOR, SOCIAL_LOGIN_COLOR, type SocialAccount } from '../../api/types'
import { useAuthStore } from '../../stores/auth'
import PlatformTag from './PlatformTag.vue'

/**
 * Social accounts linked to a device (the caller's own; admins see all), plus the platforms allowed
 * on the device (null = all; admins edit it).
 */
const props = defineProps<{ instanceId: string; allowedPlatforms: string[] | null }>()
const { t } = useI18n()
const auth = useAuthStore()
const items = ref<SocialAccount[]>([])
const platforms = ref<{ id: string; name: string }[]>([])
const error = ref('')

async function load() {
  try {
    const [acc, pl] = await Promise.all([
      api<{ items: SocialAccount[] }>('GET', `/api/social/accounts?instanceId=${props.instanceId}&pageSize=50`),
      api<{ platforms: { id: string; name: string }[] }>('GET', '/api/social/platforms'),
    ])
    items.value = acc.items
    platforms.value = pl.platforms
    error.value = ''
  } catch (e) { error.value = errorText(e) }
}
onMounted(load)
watch(() => props.instanceId, load)

const disabled = (platform: string) => props.allowedPlatforms !== null && !props.allowedPlatforms.includes(platform)

// ---- editor (admin)
const editOpen = ref(false)
const saving = ref(false)
const allOn = ref(true)
const picked = ref<string[]>([])
const options = computed(() => platforms.value.map((p) => ({ value: p.id, label: p.name })))

function openEdit() {
  allOn.value = props.allowedPlatforms === null
  picked.value = props.allowedPlatforms ?? platforms.value.map((p) => p.id)
  editOpen.value = true
}
async function save() {
  saving.value = true
  try {
    await api('PUT', `/api/instances/${props.instanceId}/platforms`, { platforms: allOn.value ? null : picked.value })
    editOpen.value = false
    message.success(t('common.saved'))
  } catch (e) { message.error(errorText(e)) } finally { saving.value = false }
}
</script>

<template>
  <a-card size="small" :title="t('social.deviceCard')">
    <template #extra>
      <router-link :to="{ path: '/social', query: { instanceId } }">{{ t('social.manage') }}</router-link>
    </template>
    <div class="allowed">
      <span class="label">{{ t('social.allowedPlatforms') }}:</span>
      <a-tag v-if="allowedPlatforms === null" color="green">{{ t('social.allPlatforms') }}</a-tag>
      <span v-else-if="!allowedPlatforms.length" class="hint">{{ t('social.noneAllowed') }}</span>
      <PlatformTag v-for="p in allowedPlatforms ?? []" v-else :key="p" :platform="p" />
      <a v-if="auth.isAdmin" class="edit" @click="openEdit">{{ t('social.editAllowed') }}</a>
    </div>
    <div v-if="error" class="hint">{{ error }}</div>
    <div v-else-if="!items.length" class="hint">{{ t('social.deviceNone') }}</div>
    <div v-for="a in items" v-else :key="a.id" class="row">
      <PlatformTag :platform="a.platform" />
      <span class="handle">{{ '@' + a.handle }}</span>
      <a-tag :color="SOCIAL_LOGIN_COLOR[a.loginStatus]">{{ t(`social.login.${a.loginStatus}`) }}</a-tag>
      <a-tag v-if="a.accountStatus !== 'active'" :color="SOCIAL_ACCOUNT_COLOR[a.accountStatus]">{{ t(`social.account.${a.accountStatus}`) }}</a-tag>
      <a-tag v-if="disabled(a.platform)" color="red">{{ t('social.platformOff') }}</a-tag>
    </div>

    <a-modal v-model:open="editOpen" :title="t('social.editAllowed')" :confirm-loading="saving" @ok="save">
      <p class="hint">{{ t('social.allowedHint') }}</p>
      <a-checkbox v-model:checked="allOn">{{ t('social.allPlatforms') }}</a-checkbox>
      <div class="hint small">{{ t('social.allPlatformsHint') }}</div>
      <a-checkbox-group v-model:value="picked" :options="options" :disabled="allOn" style="margin-top: 12px" />
    </a-modal>
  </a-card>
</template>

<style scoped>
.row { display: flex; align-items: center; gap: 8px; padding: 2px 0; flex-wrap: wrap; }
.allowed { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-bottom: 8px; }
.label { color: var(--cp-text-secondary); }
.edit { margin-inline-start: auto; }
.handle { font-weight: 500; }
.hint { color: var(--cp-text-secondary); }
.small { font-size: 12px; }
</style>
