<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { message } from 'ant-design-vue'
import { useI18n } from 'vue-i18n'
import { api, errorText } from '../../api/client'
import type { RiskSettings } from '../../api/types'

/**
 * 风控 → 云手机节奏: one pace for every automatic operation on a phone (tracked-account collection and the
 * automatic account checks share it), plus the interval of the automatic account checks. Saved values take
 * effect at once; the TRACKED_DEVICE_* env values are the defaults.
 */
/** Which half of the shared `risk.device` setting this tab shows; the save always sends the whole (strict) body. */
const props = withDefaults(defineProps<{ part?: 'collect' | 'check' | 'all' }>(), { part: 'all' })
const showCollect = computed(() => props.part !== 'check')
const showCheck = computed(() => props.part !== 'collect')
const { t } = useI18n()
const state = ref<RiskSettings | null>(null)
const form = reactive({ minIntervalSec: 30, maxPerHour: 60, busyRetrySec: 300, checkOn: true, accountCheckHours: 6, feedOn: true, feedCollectHours: 24, feedPosts: 3, feedCommentsPerPost: 30, accountDiscovery: true, followingOn: true, followingSyncHours: 24 })
const saving = ref(false)

function fill(s: RiskSettings) {
  state.value = s
  Object.assign(form, {
    minIntervalSec: s.device.minIntervalSec, maxPerHour: s.device.maxPerHour, busyRetrySec: s.device.busyRetrySec,
    checkOn: s.device.accountCheckHours !== null, accountCheckHours: s.device.accountCheckHours ?? s.defaults.accountCheckHours ?? 6,
    feedOn: s.device.feedCollectHours !== null, feedCollectHours: s.device.feedCollectHours ?? s.defaults.feedCollectHours ?? 24,
    feedPosts: s.device.feedPosts, feedCommentsPerPost: s.device.feedCommentsPerPost, accountDiscovery: s.device.accountDiscovery,
    followingOn: s.device.followingSyncHours !== null, followingSyncHours: s.device.followingSyncHours ?? s.defaults.followingSyncHours ?? 24,
  })
}
onMounted(async () => { try { fill(await api<RiskSettings>('GET', '/api/risk/settings')) } catch (e) { message.error(errorText(e)) } })
/** Visits per hour one phone can do with the values in the form (same formula as the API). */
const capacity = computed(() => Math.min(form.maxPerHour || 0, Math.floor(3600 / (form.minIntervalSec || 1))))

async function save() {
  saving.value = true
  try {
    fill(await api<RiskSettings>('PUT', '/api/risk/settings', {
      minIntervalSec: form.minIntervalSec, maxPerHour: form.maxPerHour, busyRetrySec: form.busyRetrySec,
      accountCheckHours: form.checkOn ? form.accountCheckHours : null,
      feedCollectHours: form.feedOn ? form.feedCollectHours : null, feedPosts: form.feedPosts, feedCommentsPerPost: form.feedCommentsPerPost,
      accountDiscovery: form.accountDiscovery,
      followingSyncHours: form.followingOn ? form.followingSyncHours : null,
    }))
    message.success(t('common.saved'))
  } catch (e) { message.error(errorText(e)) }
  finally { saving.value = false }
}
</script>

<template>
  <div class="settings-pane">
    <a-spin :spinning="!state">
      <a-form layout="vertical">
       <template v-if="showCollect">
        <a-typography-title :level="5">{{ t('risk.pace.title') }}</a-typography-title>
        <a-typography-paragraph type="secondary">{{ t('risk.pace.hint') }}</a-typography-paragraph>
        <a-row :gutter="12">
          <a-col :xs="24" :sm="8">
            <a-form-item :label="t('risk.pace.minInterval')" :extra="state ? t('risk.pace.defaultSec', { n: state.defaults.minIntervalSec }) : undefined">
              <a-input-number v-model:value="form.minIntervalSec" :min="5" :max="3600" :precision="0" addon-after="s" style="width: 100%" />
            </a-form-item>
          </a-col>
          <a-col :xs="24" :sm="8">
            <a-form-item :label="t('risk.pace.maxPerHour')" :extra="state ? t('risk.pace.default', { n: state.defaults.maxPerHour }) : undefined">
              <a-input-number v-model:value="form.maxPerHour" :min="1" :max="600" :precision="0" style="width: 100%" />
            </a-form-item>
          </a-col>
          <a-col :xs="24" :sm="8">
            <a-form-item :label="t('risk.pace.busyRetry')" :extra="state ? t('risk.pace.defaultSec', { n: state.defaults.busyRetrySec }) : undefined">
              <a-input-number v-model:value="form.busyRetrySec" :min="5" :max="86400" :precision="0" addon-after="s" style="width: 100%" />
            </a-form-item>
          </a-col>
        </a-row>
        <a-alert type="info" show-icon class="block" :message="t('risk.pace.capacity', { n: capacity })" />
       </template>

       <template v-if="showCheck">
        <a-typography-title :level="5">{{ t('risk.check.title') }}</a-typography-title>
        <a-typography-paragraph type="secondary">{{ t('risk.check.hint') }}</a-typography-paragraph>
        <a-form-item>
          <a-space wrap>
            <a-switch v-model:checked="form.checkOn" />
            <span>{{ t('risk.check.every') }}</span>
            <a-input-number v-model:value="form.accountCheckHours" :min="1" :max="168" :precision="0" :disabled="!form.checkOn" addon-after="h" style="width: 140px" />
          </a-space>
        </a-form-item>
       </template>

       <template v-if="showCollect">
        <a-typography-title :level="5">{{ t('risk.feed.title') }}</a-typography-title>
        <a-typography-paragraph type="secondary">{{ t('risk.feed.hint') }}</a-typography-paragraph>
        <a-form-item>
          <a-space wrap>
            <a-switch v-model:checked="form.feedOn" />
            <span>{{ t('risk.feed.every') }}</span>
            <a-input-number v-model:value="form.feedCollectHours" :min="1" :max="168" :precision="0" :disabled="!form.feedOn" addon-after="h" style="width: 140px" />
          </a-space>
        </a-form-item>
        <a-row :gutter="12">
          <a-col :xs="24" :sm="8">
            <a-form-item :label="t('risk.feed.posts')"><a-input-number v-model:value="form.feedPosts" :min="1" :max="10" :precision="0" style="width: 100%" /></a-form-item>
          </a-col>
          <a-col :xs="24" :sm="8">
            <a-form-item :label="t('risk.feed.comments')"><a-input-number v-model:value="form.feedCommentsPerPost" :min="0" :max="100" :precision="0" style="width: 100%" /></a-form-item>
          </a-col>
        </a-row>

        <a-typography-title :level="5">{{ t('risk.following.title') }}</a-typography-title>
        <a-typography-paragraph type="secondary">{{ t('risk.following.hint') }}</a-typography-paragraph>
        <a-form-item>
          <a-space wrap>
            <a-switch v-model:checked="form.followingOn" />
            <span>{{ t('risk.following.every') }}</span>
            <a-input-number v-model:value="form.followingSyncHours" :min="1" :max="168" :precision="0" :disabled="!form.followingOn" addon-after="h" style="width: 140px" />
          </a-space>
        </a-form-item>
       </template>

       <template v-if="showCheck">
        <a-typography-title :level="5">{{ t('risk.discovery.title') }}</a-typography-title>
        <a-typography-paragraph type="secondary">{{ t('risk.discovery.hint') }}</a-typography-paragraph>
        <a-form-item>
          <a-space>
            <a-switch v-model:checked="form.accountDiscovery" />
            <span>{{ form.accountDiscovery ? t('risk.discovery.on') : t('risk.discovery.off') }}</span>
          </a-space>
        </a-form-item>
       </template>
        <a-button type="primary" :loading="saving" :disabled="!state" @click="save">{{ t('common.save') }}</a-button>
      </a-form>
    </a-spin>
  </div>
</template>

<style scoped>
.settings-pane { max-width: 720px; }
.block { margin-bottom: 16px; }
</style>
