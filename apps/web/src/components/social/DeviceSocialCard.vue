<script setup lang="ts">
import { message } from 'ant-design-vue'
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { api, errorText } from '../../api/client'
import type { SocialAccount } from '../../api/types'
import StatusTag from '../common/StatusTag.vue'
import { MODAL_WIDTH } from '../common/ui'
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
  <a-card :bordered="false" :title="t('social.deviceCard')">
    <template #extra>
      <router-link :to="{ path: '/social', query: { instanceId } }">{{ t('social.manage') }}</router-link>
    </template>
    <div class="row allowed">
      <span class="muted">{{ t('social.allowedPlatforms') }}:</span>
      <a-tag v-if="allowedPlatforms === null" color="green">{{ t('social.allPlatforms') }}</a-tag>
      <span v-else-if="!allowedPlatforms.length" class="muted">{{ t('social.noneAllowed') }}</span>
      <PlatformTag v-for="p in allowedPlatforms ?? []" v-else :key="p" :platform="p" />
      <a-button v-if="auth.isAdmin" type="link" size="small" class="edit" @click="openEdit">{{ t('social.editAllowed') }}</a-button>
    </div>
    <a-typography-text v-if="error" type="danger">{{ error }}</a-typography-text>
    <span v-else-if="!items.length" class="muted">{{ t('social.deviceNone') }}</span>
    <div v-for="a in items" v-else :key="a.id" class="row">
      <PlatformTag :platform="a.platform" />
      <span class="handle">{{ '@' + a.handle }}</span>
      <StatusTag kind="socialLogin" :status="a.loginStatus" />
      <StatusTag v-if="a.accountStatus !== 'active'" kind="socialAccount" :status="a.accountStatus" />
      <a-tag v-if="disabled(a.platform)" color="red">{{ t('social.platformOff') }}</a-tag>
    </div>

    <a-modal v-model:open="editOpen" :title="t('social.editAllowed')" :width="MODAL_WIDTH.sm" :confirm-loading="saving" @ok="save">
      <a-alert type="warning" show-icon :message="t('social.allowedHint')" style="margin-bottom: 16px" />
      <a-checkbox v-model:checked="allOn">{{ t('social.allPlatforms') }}</a-checkbox>
      <div class="muted small">{{ t('social.allPlatformsHint') }}</div>
      <a-checkbox-group v-model:value="picked" :options="options" :disabled="allOn" style="margin-top: 12px" />
    </a-modal>
  </a-card>
</template>

<style scoped>
.row { display: flex; align-items: center; gap: 8px; padding: 2px 0; flex-wrap: wrap; }
.allowed { margin-bottom: 8px; }
.edit { margin-inline-start: auto; }
.handle { font-weight: 500; }
</style>
