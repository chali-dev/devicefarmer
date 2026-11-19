<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { message } from 'ant-design-vue'
import { useI18n } from 'vue-i18n'
import { api, errorText } from '../../api/client'
import { dateLocale } from '../../i18n'

/**
 * 系统配置 → 上传文件 (admin; tab formerly 素材上传): size limit per kind and the allowed formats of media uploads
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
  .map((x) => ({ value: x.id, label: x.id.toUpperCase(), exts: `.${x.exts.join(', .')}` }))
const KINDS = [
  { kind: 'image', field: 'imageMaxMb', label: 'settings.mediaLimits.images' },
  { kind: 'video', field: 'videoMaxMb', label: 'settings.mediaLimits.videos' },
] as const

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
      <!-- 上传文件 (owner 2026-11-19): one row per kind = size limit + its formats, then 保存. -->
      <div v-for="k in KINDS" :key="k.kind" class="kind-row">
        <span class="label">{{ t(k.label) }}</span>
        <a-input-number v-model:value="form[k.field]" :min="1" :max="state?.max[k.field] ?? 4096" :precision="0" addon-before="≤" addon-after="MB" style="width: 170px" />
        <a-checkbox-group v-model:value="form.allowedTypes">
          <a-tooltip v-for="o in typeOptions(k.kind)" :key="o.value" :title="o.exts">
            <a-checkbox :value="o.value">{{ o.label }}</a-checkbox>
          </a-tooltip>
        </a-checkbox-group>
      </div>
      <a-alert v-if="form.allowedTypes.includes('heic')" type="warning" show-icon class="block" :message="t('settings.mediaLimits.heic')" />
      <a-space wrap>
        <a-button type="primary" :loading="saving" :disabled="!state" @click="save">{{ t('common.save') }}</a-button>
        <span v-if="state?.updatedAt" class="muted small">{{ t('settings.updatedAt', { at: new Date(state.updatedAt).toLocaleString(dateLocale()) }) }}</span>
      </a-space>
    </a-spin>
  </div>
</template>

<style scoped>
.settings-pane { max-width: 760px; }
.block { margin-bottom: 16px; }
.kind-row { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 16px; margin-bottom: 16px; }
.label { width: 40px; flex: none; font-weight: 500; }
</style>
