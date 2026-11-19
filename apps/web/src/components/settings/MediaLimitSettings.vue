<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { message } from 'ant-design-vue'
import { useI18n } from 'vue-i18n'
import { api, errorText } from '../../api/client'
import { dateLocale } from '../../i18n'

/**
 * 系统配置 → 素材上传 (admin): size limit per kind and the allowed formats of media uploads
 * (GET/PUT /api/settings/media-limits, key `media.limits`). The env values are the defaults (not shown in the page since 2026-11-19);
 * a save applies to the next upload (the upload pages read GET /api/media/limits).
 */
interface Limits { imageMaxMb: number; videoMaxMb: number; allowedTypes: string[] }
interface View {
  limits: Limits; defaults: Limits; updatedAt: string | null
  max: { imageMaxMb: number; videoMaxMb: number }
  types: { id: string; kind: 'image' | 'video'; exts: string[] }[]
}
const { t } = useI18n()
const state = ref<View | null>(null)
const form = reactive<Limits>({ imageMaxMb: 20, videoMaxMb: 500, allowedTypes: [] })
const saving = ref(false)

const clamp = (v: number, max: number) => Math.min(max, Math.max(1, Math.round(v)))
function fill(v: View) {
  state.value = v
  Object.assign(form, {
    imageMaxMb: clamp(v.limits.imageMaxMb, v.max.imageMaxMb), videoMaxMb: clamp(v.limits.videoMaxMb, v.max.videoMaxMb), allowedTypes: [...v.limits.allowedTypes],
  })
}
onMounted(async () => { try { fill(await api('GET', '/api/settings/media-limits')) } catch (e) { message.error(errorText(e)) } })

const typeOptions = (kind: 'image' | 'video') => (state.value?.types ?? []).filter((x) => x.kind === kind)
  .map((x) => ({ value: x.id, label: `${x.id.toUpperCase()} (.${x.exts.join(', .')})` }))
const imageTypes = computed(() => typeOptions('image'))
const videoTypes = computed(() => typeOptions('video'))

async function save() {
  if (!form.allowedTypes.length) { message.error(t('settings.mediaLimits.typesRequired')); return }
  saving.value = true
  try {
    fill(await api('PUT', '/api/settings/media-limits', { imageMaxMb: form.imageMaxMb, videoMaxMb: form.videoMaxMb, allowedTypes: form.allowedTypes }))
    message.success(t('common.saved'))
  } catch (e) { message.error(errorText(e)) }
  finally { saving.value = false }
}
</script>

<template>
  <div class="settings-pane">
    <a-spin :spinning="!state">
      <a-typography-title :level="5">{{ t('settings.publish.mediaTitle') }}</a-typography-title>
      <a-typography-paragraph type="secondary">{{ t('settings.mediaLimits.hint') }}</a-typography-paragraph>
      <a-form layout="vertical">
        <a-row :gutter="12">
          <a-col :xs="24" :sm="12">
            <a-form-item :label="t('settings.publish.imageMax')">
              <a-input-number v-model:value="form.imageMaxMb" :min="1" :max="state?.max.imageMaxMb ?? 100" :precision="0" addon-after="MB" style="width: 100%" />
            </a-form-item>
          </a-col>
          <a-col :xs="24" :sm="12">
            <a-form-item :label="t('settings.publish.videoMax')">
              <a-input-number v-model:value="form.videoMaxMb" :min="1" :max="state?.max.videoMaxMb ?? 4096" :precision="0" addon-after="MB" style="width: 100%" />
            </a-form-item>
          </a-col>
        </a-row>
        <a-form-item :label="t('settings.publish.types')">
          <a-checkbox-group v-model:value="form.allowedTypes" class="types">
            <div class="muted small">{{ t('settings.mediaLimits.images') }}</div>
            <div class="row"><a-checkbox v-for="o in imageTypes" :key="o.value" :value="o.value">{{ o.label }}</a-checkbox></div>
            <div class="muted small">{{ t('settings.mediaLimits.videos') }}</div>
            <div class="row"><a-checkbox v-for="o in videoTypes" :key="o.value" :value="o.value">{{ o.label }}</a-checkbox></div>
          </a-checkbox-group>
        </a-form-item>
        <a-alert v-if="form.allowedTypes.includes('heic')" type="warning" show-icon class="block" :message="t('settings.mediaLimits.heic')" />
        <a-space wrap>
          <a-button type="primary" :loading="saving" :disabled="!state" @click="save">{{ t('common.save') }}</a-button>
          <span v-if="state?.updatedAt" class="muted small">{{ t('settings.updatedAt', { at: new Date(state.updatedAt).toLocaleString(dateLocale()) }) }}</span>
        </a-space>
      </a-form>
    </a-spin>
  </div>
</template>

<style scoped>
.settings-pane { max-width: 640px; }
.block { margin-bottom: 16px; }
.types { display: flex; flex-direction: column; gap: 4px; }
.row { display: flex; flex-wrap: wrap; gap: 4px 12px; margin-bottom: 8px; }
</style>
