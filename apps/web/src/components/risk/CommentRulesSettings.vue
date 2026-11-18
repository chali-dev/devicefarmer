<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { message } from 'ant-design-vue'
import { useI18n } from 'vue-i18n'
import { api, errorText } from '../../api/client'
import type { CommentRules } from '../../api/types'

/**
 * 风控 → 评论回复规则 (settings key comments.rules): the same-text rule. There is no approval step any more (removed
 * 2026-11-18); the sending limits + test mode are in the 云手机发评论 section (same key).
 */
const { t } = useI18n()
const form = reactive<Pick<CommentRules, 'duplicateMax' | 'duplicateWindowHours'>>({ duplicateMax: 3, duplicateWindowHours: 24 })
const pick = (r: CommentRules) => ({ duplicateMax: r.duplicateMax, duplicateWindowHours: r.duplicateWindowHours })
const loading = ref(true)
const saving = ref(false)
onMounted(async () => {
  try { Object.assign(form, pick((await api<{ rules: CommentRules }>('GET', '/api/comments/settings')).rules)) } catch (e) { message.error(errorText(e)) }
  finally { loading.value = false }
})
async function save() {
  saving.value = true
  try {
    Object.assign(form, pick((await api<{ rules: CommentRules }>('PUT', '/api/comments/settings', { ...form })).rules))
    message.success(t('common.saved'))
  } catch (e) { message.error(errorText(e)) }
  finally { saving.value = false }
}
</script>

<template>
  <div class="settings-pane">
    <a-spin :spinning="loading">
      <a-typography-title :level="5">{{ t('risk.comments.title') }}</a-typography-title>
      <a-typography-paragraph type="secondary">{{ t('risk.comments.hint') }}</a-typography-paragraph>
      <a-form layout="vertical">
        <a-row :gutter="12">
          <a-col :xs="24" :sm="12">
            <a-form-item :label="t('comments.duplicateMax')"><a-input-number v-model:value="form.duplicateMax" :min="1" :max="100" :precision="0" style="width: 100%" /></a-form-item>
          </a-col>
          <a-col :xs="24" :sm="12">
            <a-form-item :label="t('comments.duplicateWindowHours')"><a-input-number v-model:value="form.duplicateWindowHours" :min="1" :max="720" :precision="0" style="width: 100%" /></a-form-item>
          </a-col>
        </a-row>
        <a-button type="primary" :loading="saving" @click="save">{{ t('common.save') }}</a-button>
      </a-form>
    </a-spin>
  </div>
</template>

<style scoped>
.settings-pane { max-width: 640px; }
</style>
