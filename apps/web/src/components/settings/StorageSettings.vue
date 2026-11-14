<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { message } from 'ant-design-vue'
import { useI18n } from 'vue-i18n'
import { api, errorText } from '../../api/client'
import type { StorageSettings, StorageTestResult } from '../../api/types'

/** Settings → Storage (admin): backend of the media library, local disk or S3-compatible. */
const { t } = useI18n()
const errMsg = errorText
onMounted(() => void load())

const storageLoading = ref(false)
const storageSaving = ref(false)
const storageTesting = ref(false)
const hasSecret = ref(false)
const testResult = ref<StorageTestResult | null>(null)
const storageForm = reactive({
  type: 'local' as 'local' | 's3',
  endpoint: '', region: 'us-east-1', bucket: '', accessKeyId: '', secretAccessKey: '', forcePathStyle: false, prefix: '',
})
const isS3 = computed(() => storageForm.type === 's3')
async function load() {
  storageLoading.value = true
  testResult.value = null
  try {
    const { storage } = await api<{ storage: StorageSettings }>('GET', '/api/settings/storage')
    storageForm.type = storage.type
    storageForm.endpoint = storage.s3?.endpoint ?? ''
    storageForm.region = storage.s3?.region ?? 'us-east-1'
    storageForm.bucket = storage.s3?.bucket ?? ''
    storageForm.accessKeyId = storage.s3?.accessKeyId ?? ''
    storageForm.forcePathStyle = storage.s3?.forcePathStyle ?? false
    storageForm.prefix = storage.s3?.prefix ?? ''
    storageForm.secretAccessKey = ''
    hasSecret.value = Boolean(storage.s3?.hasSecret)
  } catch (e) { message.error(errMsg(e)) }
  finally { storageLoading.value = false }
}
function storageBody() {
  if (storageForm.type === 'local') return { type: 'local' as const }
  return {
    type: 's3' as const,
    s3: {
      endpoint: storageForm.endpoint.trim(), region: storageForm.region.trim() || 'us-east-1', bucket: storageForm.bucket.trim(),
      accessKeyId: storageForm.accessKeyId.trim(), forcePathStyle: storageForm.forcePathStyle, prefix: storageForm.prefix.trim(),
      ...(storageForm.secretAccessKey ? { secretAccessKey: storageForm.secretAccessKey } : {}),
    },
  }
}
function s3Incomplete(): string | null {
  if (storageForm.type !== 's3') return null
  if (!storageForm.bucket.trim()) return t('media.storage.needBucket')
  if (!storageForm.accessKeyId.trim()) return t('media.storage.needKeyId')
  if (!storageForm.secretAccessKey && !hasSecret.value) return t('media.storage.needSecret')
  return null
}
async function testStorage() {
  const bad = s3Incomplete()
  if (bad) { message.warning(bad); return }
  storageTesting.value = true
  testResult.value = null
  try { testResult.value = await api<StorageTestResult>('POST', '/api/settings/storage/test', storageBody()) }
  catch (e) { testResult.value = { ok: false, latencyMs: 0, error: errMsg(e) } }
  finally { storageTesting.value = false }
}
async function saveStorage() {
  const bad = s3Incomplete()
  if (bad) { message.warning(bad); return }
  storageSaving.value = true
  try {
    await api('PUT', '/api/settings/storage', storageBody())
    message.success(storageForm.type === 's3' ? t('media.storage.savedS3') : t('media.storage.savedLocal'))
    void load()
  } catch (e) { testResult.value = { ok: false, latencyMs: 0, error: errMsg(e) } }
  finally { storageSaving.value = false }
}
</script>

<template>
  <div class="settings-pane">
    <a-spin :spinning="storageLoading">
      <a-form layout="vertical">
        <a-form-item :label="t('media.storage.location')" :extra="t('media.storage.locationHint')">
          <a-radio-group v-model:value="storageForm.type">
            <a-radio-button value="local">{{ t('media.storage.local') }}</a-radio-button>
            <a-radio-button value="s3">{{ t('media.storage.s3') }}</a-radio-button>
          </a-radio-group>
        </a-form-item>
        <template v-if="isS3">
          <a-form-item label="Endpoint" :extra="t('media.storage.endpointHint')">
            <a-input v-model:value="storageForm.endpoint" :placeholder="t('media.storage.endpointPlaceholder')" />
          </a-form-item>
          <a-row :gutter="12">
            <a-col :xs="24" :sm="12">
              <a-form-item label="Region" :extra="t('media.storage.regionHint')"><a-input v-model:value="storageForm.region" placeholder="us-east-1" /></a-form-item>
            </a-col>
            <a-col :xs="24" :sm="12">
              <a-form-item label="Bucket" required><a-input v-model:value="storageForm.bucket" placeholder="my-bucket" /></a-form-item>
            </a-col>
          </a-row>
          <a-form-item label="Access Key ID" required><a-input v-model:value="storageForm.accessKeyId" autocomplete="off" /></a-form-item>
          <a-form-item label="Secret Access Key" :required="!hasSecret" :extra="hasSecret ? t('media.storage.secretSaved') : t('media.storage.secretEncrypted')">
            <a-input-password v-model:value="storageForm.secretAccessKey" autocomplete="new-password" :placeholder="hasSecret ? t('media.storage.secretPlaceholder') : ''" />
          </a-form-item>
          <a-row :gutter="12">
            <a-col :xs="24" :sm="12">
              <a-form-item :label="t('media.storage.pathStyle')" :extra="t('media.storage.pathStyleHint')">
                <a-switch v-model:checked="storageForm.forcePathStyle" />
              </a-form-item>
            </a-col>
            <a-col :xs="24" :sm="12">
              <a-form-item :label="t('media.storage.prefix')" :extra="t('media.storage.prefixHint')"><a-input v-model:value="storageForm.prefix" placeholder="cloudphone/" /></a-form-item>
            </a-col>
          </a-row>
          <a-alert type="warning" show-icon style="margin-bottom: 12px"
            :message="t('media.storage.bucketWarning')" />
        </template>
        <a-alert
          v-if="testResult" :type="testResult.ok ? 'success' : 'error'" show-icon style="margin-bottom: 12px"
          :message="testResult.ok ? t('media.storage.testOk', { ms: testResult.latencyMs }) : t('media.storage.testFailed', { error: testResult.error ?? '' })"
        />
        <div style="display: flex; gap: 8px">
          <a-button :loading="storageTesting" @click="testStorage">{{ t('media.storage.test') }}</a-button>
          <a-button type="primary" :loading="storageSaving" @click="saveStorage">{{ t('common.save') }}</a-button>
        </div>
      </a-form>
    </a-spin>
  </div>
</template>

<style scoped>
.settings-pane { max-width: 640px; }
</style>
