<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { message, Modal } from 'ant-design-vue'
import {
  CloudUploadOutlined, DeleteOutlined, DownloadOutlined, FileOutlined, SendOutlined, SettingOutlined, TagsOutlined, VideoCameraOutlined,
} from '@ant-design/icons-vue'
import { useI18n } from 'vue-i18n'
import { api, errorText, getToken, responseError } from '../api/client'
import type { Asset, StorageSettings, StorageTestResult } from '../api/types'
import { useAuthStore } from '../stores/auth'
import { useInstancesStore } from '../stores/instances'

const auth = useAuthStore()
const store = useInstancesStore()
const { t } = useI18n()
const errMsg = errorText

// ---- list
const assets = ref<Asset[]>([])
const loading = ref(false)
const q = ref('')
const type = ref<'' | 'image' | 'video' | 'other'>('')
const TYPE_OPTIONS = computed(() => [
  { value: '', label: t('assets.allTypes') }, { value: 'image', label: t('assets.image') }, { value: 'video', label: t('assets.video') }, { value: 'other', label: t('assets.other') },
])

async function load() {
  loading.value = true
  try {
    const params = new URLSearchParams()
    if (q.value.trim()) params.set('q', q.value.trim())
    if (type.value) params.set('type', type.value)
    assets.value = (await api<{ assets: Asset[] }>('GET', `/api/assets${params.size ? `?${params}` : ''}`)).assets
    selected.value = selected.value.filter((id) => assets.value.some((a) => a.id === id))
    void loadThumbs()
  } catch (e) { message.error(errMsg(e)) }
  finally { loading.value = false }
}
onMounted(load)
watch(type, load)

const isImage = (a: Asset) => a.mime.startsWith('image/')
const isVideo = (a: Asset) => a.mime.startsWith('video/')
function fmtSize(n: number) {
  if (n < 1024) return `${n} B`
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1073741824) return `${(n / 1048576).toFixed(1)} MB`
  return `${(n / 1073741824).toFixed(2)} GB`
}

// ---- thumbnails: <img> can't send the Authorization header, so fetch → blob URL
const thumbs = reactive(new Map<string, string>())
const thumbFailed = reactive(new Set<string>())
let disposed = false
async function fetchBlob(a: Asset): Promise<Blob> {
  const token = getToken()
  const res = await fetch(`/api/assets/${a.id}/content`, { headers: token ? { authorization: `Bearer ${token}` } : {} })
  if (!res.ok) throw await responseError(res)
  return res.blob()
}
async function loadThumbs() {
  const todo = assets.value.filter((a) => isImage(a) && a.size <= 20 * 1048576 && !thumbs.has(a.id) && !thumbFailed.has(a.id))
  const worker = async () => {
    for (let a = todo.shift(); a; a = todo.shift()) {
      try {
        const blob = await fetchBlob(a)
        if (disposed) return
        thumbs.set(a.id, URL.createObjectURL(blob))
      } catch { thumbFailed.add(a.id) }
    }
  }
  await Promise.all(Array.from({ length: 4 }, worker))
}
function dropThumb(id: string) {
  const url = thumbs.get(id)
  if (url) URL.revokeObjectURL(url)
  thumbs.delete(id)
}
onBeforeUnmount(() => {
  disposed = true
  for (const url of thumbs.values()) URL.revokeObjectURL(url)
  thumbs.clear()
})

// ---- upload: one request per file, sequential
const uploadQueue: File[] = []
const uploading = ref(false)
let uploadTotal = 0
let uploadDone = 0
function enqueueUpload(opt: { file: File; onSuccess?: (r: unknown) => void }) {
  uploadQueue.push(opt.file)
  uploadTotal++
  opt.onSuccess?.(null)
  if (!uploading.value) void drainUploads()
}
async function drainUploads() {
  uploading.value = true
  let ok = 0
  const failed: string[] = []
  for (let f = uploadQueue.shift(); f; f = uploadQueue.shift()) {
    message.loading({ content: t('assets.uploadingN', { i: uploadDone + 1, total: uploadTotal, name: f.name }), key: 'asset-upload', duration: 0 })
    try {
      const fd = new FormData()
      fd.append('file', f, f.name)
      await api('POST', '/api/assets', fd)
      ok++
    } catch (e) { failed.push(t('assets.uploadFailedItem', { name: f.name, error: errMsg(e) })) }
    uploadDone++
  }
  if (failed.length) message.error({ content: t('assets.uploadFailed', { n: failed.length, list: failed.join(t('common.reasonSep')) }), key: 'asset-upload', duration: 6 })
  else message.success({ content: t('assets.uploaded', { n: ok }), key: 'asset-upload' })
  uploadTotal = 0
  uploadDone = 0
  uploading.value = false
  await load()
}

// ---- per-asset actions
async function download(a: Asset) {
  const hide = message.loading(t('assets.downloading', { name: a.name }), 0)
  try {
    const url = URL.createObjectURL(await fetchBlob(a))
    const link = document.createElement('a')
    link.href = url
    link.download = a.name
    document.body.appendChild(link)
    link.click()
    link.remove()
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
  } catch (e) { message.error(errMsg(e)) }
  finally { hide() }
}

function remove(a: Asset) {
  Modal.confirm({
    title: t('assets.confirmDelete', { name: a.name }), content: t('assets.deleteContent'), okType: 'danger', okText: t('common.delete'), cancelText: t('common.cancel'),
    onOk: async () => {
      try {
        await api('DELETE', `/api/assets/${a.id}`)
        dropThumb(a.id)
        message.success(t('common.deleted'))
        await load()
      } catch (e) { message.error(errMsg(e)) }
    },
  })
}

const editing = ref<Asset | null>(null)
const editForm = reactive({ name: '', tags: [] as string[] })
const editSaving = ref(false)
const allTags = computed(() => [...new Set(assets.value.flatMap((a) => a.tags))].sort().map((t) => ({ value: t })))
function openEdit(a: Asset) {
  editing.value = a
  editForm.name = a.name
  editForm.tags = [...a.tags]
}
async function saveEdit() {
  if (!editing.value) return
  const name = editForm.name.trim()
  if (!name) { message.warning(t('assets.nameRequired')); return }
  const tags = editForm.tags.map((t) => t.trim()).filter(Boolean)
  if (tags.some((t) => t.length > 32)) { message.warning(t('assets.tagTooLong')); return }
  if (tags.length > 20) { message.warning(t('assets.tooManyTags')); return }
  editSaving.value = true
  try {
    await api('PATCH', `/api/assets/${editing.value.id}`, { name, tags })
    editing.value = null
    await load()
  } catch (e) { message.error(errMsg(e)) }
  finally { editSaving.value = false }
}

// ---- push to devices (single or batch)
const selected = ref<string[]>([])
const pushAssets = ref<Asset[] | null>(null)
const pushTargets = ref<string[]>([])
const pushing = ref(false)
const runningDevices = computed(() => store.list.filter((i) => i.status === 'running').map((i) => ({ value: i.id, label: i.name })))
function toggleSelect(id: string, on: boolean) {
  selected.value = on ? [...new Set([...selected.value, id])] : selected.value.filter((x) => x !== id)
}
function openPush(list: Asset[]) {
  if (!list.length) return
  if (list.length > 20) { message.warning(t('assets.pushLimit')); return }
  pushAssets.value = list
  pushTargets.value = []
}
async function doPush() {
  if (!pushAssets.value || !pushTargets.value.length) { message.warning(t('assets.pickDevice')); return }
  pushing.value = true
  try {
    const r = await api<{ accepted: unknown[]; skipped: { reason: string }[] }>('POST', '/api/assets/push', {
      assetIds: pushAssets.value.map((a) => a.id), instanceIds: pushTargets.value,
    })
    message.success(t('assets.pushSubmitted', { n: r.accepted.length }))
    if (r.skipped.length) message.warning(t('assets.pushSkipped', { n: r.skipped.length, reasons: [...new Set(r.skipped.map((s) => s.reason))].join(t('common.reasonSep')) }))
    pushAssets.value = null
    selected.value = []
  } catch (e) { message.error(errMsg(e)) }
  finally { pushing.value = false }
}

// ---- storage settings (admin)
const storageOpen = ref(false)
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
async function openStorage() {
  storageOpen.value = true
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
  if (!storageForm.bucket.trim()) return t('assets.storage.needBucket')
  if (!storageForm.accessKeyId.trim()) return t('assets.storage.needKeyId')
  if (!storageForm.secretAccessKey && !hasSecret.value) return t('assets.storage.needSecret')
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
    message.success(storageForm.type === 's3' ? t('assets.storage.savedS3') : t('assets.storage.savedLocal'))
    storageOpen.value = false
  } catch (e) { testResult.value = { ok: false, latencyMs: 0, error: errMsg(e) } }
  finally { storageSaving.value = false }
}
</script>

<template>
  <a-card :title="t('assets.title')" size="small">
    <template #extra>
      <a-space wrap>
        <a-button size="small" type="primary" :disabled="!selected.length" @click="openPush(assets.filter((a) => selected.includes(a.id)))">
          <SendOutlined /> {{ selected.length ? t('assets.pushToDeviceN', { n: selected.length }) : t('assets.pushToDevice') }}
        </a-button>
        <a-button v-if="auth.isAdmin" size="small" @click="openStorage"><SettingOutlined /> {{ t('assets.storageSettings') }}</a-button>
        <a-button size="small" :loading="loading" @click="load">{{ t('common.refresh') }}</a-button>
      </a-space>
    </template>

    <div class="toolbar">
      <a-input-search v-model:value="q" :placeholder="t('assets.searchPlaceholder')" allow-clear class="search" @search="load" />
      <a-select v-model:value="type" :options="TYPE_OPTIONS" class="type" />
      <a-checkbox
        v-if="assets.length"
        :checked="selected.length > 0 && selected.length === assets.length"
        :indeterminate="selected.length > 0 && selected.length < assets.length"
        @change="(e: any) => (selected = e.target.checked ? assets.map((a) => a.id) : [])"
      >{{ t('assets.selectAll') }}</a-checkbox>
    </div>

    <a-upload-dragger
      :multiple="true" :show-upload-list="false" :custom-request="enqueueUpload as any" class="dragger"
    >
      <p style="margin: 8px 0"><CloudUploadOutlined class="upload-icon" /></p>
      <p style="margin: 0">{{ uploading ? t('common.uploading') : t('assets.drop') }}</p>
      <p class="hint" style="margin: 4px 0 8px">{{ t('assets.dropHint') }}</p>
    </a-upload-dragger>

    <a-spin :spinning="loading">
      <a-empty v-if="!assets.length && !loading" :description="t('assets.empty')" style="margin: 32px 0" />
      <div class="grid">
        <div v-for="a in assets" :key="a.id" class="item" :class="{ checked: selected.includes(a.id) }">
          <div class="thumb">
            <img v-if="thumbs.get(a.id)" :src="thumbs.get(a.id)" :alt="a.name" />
            <VideoCameraOutlined v-else-if="isVideo(a)" class="icon" />
            <FileOutlined v-else class="icon" />
            <a-checkbox
              class="check" :checked="selected.includes(a.id)"
              @change="(e: any) => toggleSelect(a.id, e.target.checked)"
            />
            <a-tag v-if="a.storage === 's3'" class="badge" color="blue">S3</a-tag>
          </div>
          <div class="meta">
            <a-typography-text class="name" :content="a.name" :ellipsis="{ tooltip: a.name }" />
            <div class="hint">{{ fmtSize(a.size) }} · {{ new Date(a.createdAt).toLocaleDateString() }}</div>
            <div class="tags">
              <a-tag v-for="t in a.tags" :key="t">{{ t }}</a-tag>
            </div>
          </div>
          <div class="actions">
            <a-tooltip :title="t('assets.download')"><a-button type="text" size="small" @click="download(a)"><DownloadOutlined /></a-button></a-tooltip>
            <a-tooltip :title="t('assets.editTags')"><a-button type="text" size="small" @click="openEdit(a)"><TagsOutlined /></a-button></a-tooltip>
            <a-tooltip :title="t('assets.pushToDevice')"><a-button type="text" size="small" @click="openPush([a])"><SendOutlined /></a-button></a-tooltip>
            <a-tooltip v-if="auth.isAdmin" :title="t('common.delete')"><a-button type="text" size="small" danger @click="remove(a)"><DeleteOutlined /></a-button></a-tooltip>
          </div>
        </div>
      </div>
    </a-spin>
  </a-card>

  <a-modal :open="!!editing" :title="t('assets.editTitle')" :ok-text="t('common.save')" :cancel-text="t('common.cancel')" :confirm-loading="editSaving" @ok="saveEdit" @cancel="editing = null">
    <a-form layout="vertical">
      <a-form-item :label="t('common.name')"><a-input v-model:value="editForm.name" :maxlength="200" /></a-form-item>
      <a-form-item :label="t('assets.tags')" :extra="t('assets.tagsHint')">
        <a-select v-model:value="editForm.tags" mode="tags" :options="allTags" :placeholder="t('assets.addTag')" style="width: 100%" />
      </a-form-item>
    </a-form>
  </a-modal>

  <a-modal
    :open="!!pushAssets" :title="pushAssets?.length === 1 ? t('assets.pushOne', { name: pushAssets[0]!.name }) : t('assets.pushMany', { n: pushAssets?.length ?? 0 })"
    :ok-text="t('common.push')" :cancel-text="t('common.cancel')" :confirm-loading="pushing" @ok="doPush" @cancel="pushAssets = null"
  >
    <a-select
      v-model:value="pushTargets" mode="multiple" style="width: 100%" :placeholder="t('assets.pickRunning')" :options="runningDevices"
      :not-found-content="t('assets.noRunning')" option-filter-prop="label"
    />
    <p class="hint" style="margin-top: 8px">{{ t('assets.pushHint') }}</p>
  </a-modal>

  <a-modal v-model:open="storageOpen" :title="t('assets.storageSettings')" :footer="null" width="560px">
    <a-spin :spinning="storageLoading">
      <a-form layout="vertical">
        <a-form-item :label="t('assets.storage.location')" :extra="t('assets.storage.locationHint')">
          <a-radio-group v-model:value="storageForm.type">
            <a-radio-button value="local">{{ t('assets.storage.local') }}</a-radio-button>
            <a-radio-button value="s3">{{ t('assets.storage.s3') }}</a-radio-button>
          </a-radio-group>
        </a-form-item>
        <template v-if="isS3">
          <a-form-item label="Endpoint" :extra="t('assets.storage.endpointHint')">
            <a-input v-model:value="storageForm.endpoint" :placeholder="t('assets.storage.endpointPlaceholder')" />
          </a-form-item>
          <a-row :gutter="12">
            <a-col :xs="24" :sm="12">
              <a-form-item label="Region" :extra="t('assets.storage.regionHint')"><a-input v-model:value="storageForm.region" placeholder="us-east-1" /></a-form-item>
            </a-col>
            <a-col :xs="24" :sm="12">
              <a-form-item label="Bucket" required><a-input v-model:value="storageForm.bucket" placeholder="my-bucket" /></a-form-item>
            </a-col>
          </a-row>
          <a-form-item label="Access Key ID" required><a-input v-model:value="storageForm.accessKeyId" autocomplete="off" /></a-form-item>
          <a-form-item label="Secret Access Key" :required="!hasSecret" :extra="hasSecret ? t('assets.storage.secretSaved') : t('assets.storage.secretEncrypted')">
            <a-input-password v-model:value="storageForm.secretAccessKey" autocomplete="new-password" :placeholder="hasSecret ? t('assets.storage.secretPlaceholder') : ''" />
          </a-form-item>
          <a-row :gutter="12">
            <a-col :xs="24" :sm="12">
              <a-form-item :label="t('assets.storage.pathStyle')" :extra="t('assets.storage.pathStyleHint')">
                <a-switch v-model:checked="storageForm.forcePathStyle" />
              </a-form-item>
            </a-col>
            <a-col :xs="24" :sm="12">
              <a-form-item :label="t('assets.storage.prefix')" :extra="t('assets.storage.prefixHint')"><a-input v-model:value="storageForm.prefix" placeholder="cloudphone/" /></a-form-item>
            </a-col>
          </a-row>
          <a-alert type="warning" show-icon style="margin-bottom: 12px"
            :message="t('assets.storage.bucketWarning')" />
        </template>
        <a-alert
          v-if="testResult" :type="testResult.ok ? 'success' : 'error'" show-icon style="margin-bottom: 12px"
          :message="testResult.ok ? t('assets.storage.testOk', { ms: testResult.latencyMs }) : t('assets.storage.testFailed', { error: testResult.error ?? '' })"
        />
        <div style="display: flex; justify-content: flex-end; gap: 8px">
          <a-button @click="storageOpen = false">{{ t('common.cancel') }}</a-button>
          <a-button :loading="storageTesting" @click="testStorage">{{ t('assets.storage.test') }}</a-button>
          <a-button type="primary" :loading="storageSaving" @click="saveStorage">{{ t('common.save') }}</a-button>
        </div>
      </a-form>
    </a-spin>
  </a-modal>
</template>

<style scoped>
.toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-bottom: 12px; }
.search { width: 260px; max-width: 100%; }
.type { width: 130px; }
.dragger { display: block; margin-bottom: 16px; }
.hint { color: var(--cp-text-tertiary); font-size: 12px; }
.upload-icon { font-size: 24px; color: var(--cp-primary); }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 12px; }
.item { border: 1px solid var(--cp-border-secondary); border-radius: 8px; overflow: hidden; background: var(--cp-bg-container); display: flex; flex-direction: column; min-width: 0; }
.item.checked { border-color: var(--cp-primary); box-shadow: 0 0 0 1px var(--cp-primary); }
.thumb { position: relative; height: 140px; background: var(--cp-fill-alter); display: flex; align-items: center; justify-content: center; }
.thumb img { width: 100%; height: 100%; object-fit: cover; }
.icon { font-size: 40px; color: var(--cp-text-quaternary); }
.check { position: absolute; top: 8px; left: 8px; }
.badge { position: absolute; top: 8px; right: 0; }
.meta { padding: 8px 10px 0; min-width: 0; flex: 1; }
.name { display: block; font-weight: 500; }
.tags { margin-top: 4px; display: flex; flex-wrap: wrap; gap: 4px 0; }
.actions { display: flex; justify-content: space-around; border-top: 1px solid var(--cp-border-secondary); padding: 2px 0; margin-top: 8px; }
@media (max-width: 640px) {
  .grid { grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 8px; }
  .thumb { height: 110px; }
  .search { width: 100%; }
}
</style>
