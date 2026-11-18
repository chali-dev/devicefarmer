<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { message } from 'ant-design-vue'
import { useI18n } from 'vue-i18n'
import { api, errorText } from '../../api/client'
import type { CommentRules } from '../../api/types'

/**
 * 风控 → 评论回复 (settings key comments.rules, GET/PUT /api/comments/settings): one section, one save. Above the
 * rules for every reply (same text per window, sends per account per hour), below the limits of sends from the cloud
 * phones (per day, minimum gap). No approval step and no test mode any more (both removed 2026-11-18): replies are
 * drafts until a person schedules them. Over the limits a send is deferred, never dropped.
 */
const { t } = useI18n()
const form = reactive<CommentRules>({ duplicateMax: 3, duplicateWindowHours: 24, sendsPerHour: 20, sendsPerDay: 50, minGapSec: 60 })
const pick = (r: CommentRules): CommentRules => ({
  duplicateMax: r.duplicateMax, duplicateWindowHours: r.duplicateWindowHours, sendsPerHour: r.sendsPerHour, sendsPerDay: r.sendsPerDay, minGapSec: r.minGapSec,
})
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
        <a-divider orientation="left" plain>{{ t('risk.comments.general') }}</a-divider>
        <a-row :gutter="12">
          <a-col :xs="24" :sm="8">
            <a-form-item :label="t('comments.duplicateMax')"><a-input-number v-model:value="form.duplicateMax" :min="1" :max="100" :precision="0" style="width: 100%" /></a-form-item>
          </a-col>
          <a-col :xs="24" :sm="8">
            <a-form-item :label="t('comments.duplicateWindowHours')"><a-input-number v-model:value="form.duplicateWindowHours" :min="1" :max="720" :precision="0" style="width: 100%" /></a-form-item>
          </a-col>
          <a-col :xs="24" :sm="8">
            <a-form-item :label="t('risk.comments.sendsPerHour')"><a-input-number v-model:value="form.sendsPerHour" :min="1" :max="500" :precision="0" style="width: 100%" /></a-form-item>
          </a-col>
        </a-row>
        <a-divider orientation="left" plain>{{ t('risk.comments.device') }}</a-divider>
        <a-typography-paragraph type="secondary">{{ t('risk.comments.deviceHint') }}</a-typography-paragraph>
        <a-row :gutter="12">
          <a-col :xs="24" :sm="12">
            <a-form-item :label="t('risk.comments.sendsPerDay')"><a-input-number v-model:value="form.sendsPerDay" :min="1" :max="2000" :precision="0" style="width: 100%" /></a-form-item>
          </a-col>
          <a-col :xs="24" :sm="12">
            <a-form-item :label="t('risk.comments.minGap')"><a-input-number v-model:value="form.minGapSec" :min="0" :max="86400" :precision="0" addon-after="s" style="width: 100%" /></a-form-item>
          </a-col>
        </a-row>
        <a-button type="primary" :loading="saving" @click="save">{{ t('common.save') }}</a-button>
      </a-form>
    </a-spin>
  </div>
</template>

<style scoped>
.settings-pane { max-width: 720px; }
</style>
