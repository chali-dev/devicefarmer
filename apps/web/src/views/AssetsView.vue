<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { message, Modal } from 'ant-design-vue'
import {
  CloudUploadOutlined, DeleteOutlined, DownloadOutlined, FileOutlined, SendOutlined, SettingOutlined, TagsOutlined, VideoCameraOutlined,
} from '@ant-design/icons-vue'
import { api, getToken } from '../api/client'
import type { Asset, StorageSettings, StorageTestResult } from '../api/types'
import { useAuthStore } from '../stores/auth'
import { useInstancesStore } from '../stores/instances'

const auth = useAuthStore()
const store = useInstancesStore()
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e))

// ---- list
const assets = ref<Asset[]>([])
const loading = ref(false)
const q = ref('')
const type = ref<'' | 'image' | 'video' | 'other'>('')
const TYPE_OPTIONS = [
  { value: '', label: '全部类型' }, { value: 'image', label: '图片' }, { value: 'video', label: '视频' }, { value: 'other', label: '其他文件' },
]

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
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    throw new Error(data.error ?? `请求失败 (${res.status})`)
  }
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
    message.loading({ content: `正在上传 (${uploadDone + 1}/${uploadTotal}) ${f.name}`, key: 'asset-upload', duration: 0 })
    try {
      const fd = new FormData()
      fd.append('file', f, f.name)
      await api('POST', '/api/assets', fd)
      ok++
    } catch (e) { failed.push(`${f.name}：${errMsg(e)}`) }
    uploadDone++
  }
  if (failed.length) message.error({ content: `上传失败 ${failed.length} 个：${failed.join('；')}`, key: 'asset-upload', duration: 6 })
  else message.success({ content: `已上传 ${ok} 个素材`, key: 'asset-upload' })
  uploadTotal = 0
  uploadDone = 0
  uploading.value = false
  await load()
}

// ---- per-asset actions
async function download(a: Asset) {
  const hide = message.loading(`正在下载 ${a.name}`, 0)
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
    title: `删除素材 ${a.name}？`, content: '将同时删除存储中的文件；已推送到设备上的文件不受影响。', okType: 'danger', okText: '删除', cancelText: '取消',
    onOk: async () => {
      try {
        await api('DELETE', `/api/assets/${a.id}`)
        dropThumb(a.id)
        message.success('已删除')
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
  if (!name) { message.warning('名称不能为空'); return }
  const tags = editForm.tags.map((t) => t.trim()).filter(Boolean)
  if (tags.some((t) => t.length > 32)) { message.warning('每个标签最多 32 个字符'); return }
  if (tags.length > 20) { message.warning('最多 20 个标签'); return }
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
  if (list.length > 20) { message.warning('一次最多推送 20 个素材'); return }
  pushAssets.value = list
  pushTargets.value = []
}
async function doPush() {
  if (!pushAssets.value || !pushTargets.value.length) { message.warning('请选择设备'); return }
  pushing.value = true
  try {
    const r = await api<{ accepted: unknown[]; skipped: { reason: string }[] }>('POST', '/api/assets/push', {
      assetIds: pushAssets.value.map((a) => a.id), instanceIds: pushTargets.value,
    })
    message.success(`已提交 ${r.accepted.length} 个推送任务，可在设备管理的任务列表查看进度`)
    if (r.skipped.length) message.warning(`跳过 ${r.skipped.length} 台设备：${[...new Set(r.skipped.map((s) => s.reason))].join('，')}`)
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
const ENDPOINT_HINT = 'AWS S3 留空；Cloudflare R2：https://<账号ID>.r2.cloudflarestorage.com；阿里云 OSS：https://oss-cn-hangzhou.aliyuncs.com；自建 SeaweedFS / MinIO：http://<主机>:<端口>'
const ENDPOINT_PLACEHOLDER = '留空 = AWS；R2 / OSS / 自建存储填写服务地址'
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
  if (!storageForm.bucket.trim()) return '请填写 Bucket'
  if (!storageForm.accessKeyId.trim()) return '请填写 Access Key ID'
  if (!storageForm.secretAccessKey && !hasSecret.value) return '请填写 Secret Access Key'
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
    message.success(storageForm.type === 's3' ? '连接测试通过，已保存；新上传的素材将存到 S3' : '已保存；新上传的素材将存到本地')
    storageOpen.value = false
  } catch (e) { testResult.value = { ok: false, latencyMs: 0, error: errMsg(e) } }
  finally { storageSaving.value = false }
}
</script>

<template>
  <a-card title="素材库" size="small">
    <template #extra>
      <a-space wrap>
        <a-button v-if="auth.canOperate" size="small" type="primary" :disabled="!selected.length" @click="openPush(assets.filter((a) => selected.includes(a.id)))">
          <SendOutlined /> 推送到设备{{ selected.length ? ` (${selected.length})` : '' }}
        </a-button>
        <a-button v-if="auth.isAdmin" size="small" @click="openStorage"><SettingOutlined /> 存储设置</a-button>
        <a-button size="small" :loading="loading" @click="load">刷新</a-button>
      </a-space>
    </template>

    <div class="toolbar">
      <a-input-search v-model:value="q" placeholder="搜索名称或标签" allow-clear class="search" @search="load" />
      <a-select v-model:value="type" :options="TYPE_OPTIONS" class="type" />
      <a-checkbox
        v-if="auth.canOperate && assets.length"
        :checked="selected.length > 0 && selected.length === assets.length"
        :indeterminate="selected.length > 0 && selected.length < assets.length"
        @change="(e: any) => (selected = e.target.checked ? assets.map((a) => a.id) : [])"
      >全选</a-checkbox>
    </div>

    <a-upload-dragger
      v-if="auth.canOperate" :multiple="true" :show-upload-list="false" :custom-request="enqueueUpload as any" class="dragger"
    >
      <p style="margin: 8px 0"><CloudUploadOutlined style="font-size: 24px; color: #1677ff" /></p>
      <p style="margin: 0">{{ uploading ? '上传中…' : '拖拽图片 / 视频 / 文件到此处，或点击选择（可多选）' }}</p>
      <p class="hint" style="margin: 4px 0 8px">推送到设备时：图片 → Pictures，视频 → Movies，其他 → Download</p>
    </a-upload-dragger>

    <a-spin :spinning="loading">
      <a-empty v-if="!assets.length && !loading" description="暂无素材" style="margin: 32px 0" />
      <div class="grid">
        <div v-for="a in assets" :key="a.id" class="item" :class="{ checked: selected.includes(a.id) }">
          <div class="thumb">
            <img v-if="thumbs.get(a.id)" :src="thumbs.get(a.id)" :alt="a.name" />
            <VideoCameraOutlined v-else-if="isVideo(a)" class="icon" />
            <FileOutlined v-else class="icon" />
            <a-checkbox
              v-if="auth.canOperate" class="check" :checked="selected.includes(a.id)"
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
            <a-tooltip title="下载"><a-button type="text" size="small" @click="download(a)"><DownloadOutlined /></a-button></a-tooltip>
            <template v-if="auth.canOperate">
              <a-tooltip title="编辑标签"><a-button type="text" size="small" @click="openEdit(a)"><TagsOutlined /></a-button></a-tooltip>
              <a-tooltip title="推送到设备"><a-button type="text" size="small" @click="openPush([a])"><SendOutlined /></a-button></a-tooltip>
              <a-tooltip title="删除"><a-button type="text" size="small" danger @click="remove(a)"><DeleteOutlined /></a-button></a-tooltip>
            </template>
          </div>
        </div>
      </div>
    </a-spin>
  </a-card>

  <a-modal :open="!!editing" title="编辑素材" ok-text="保存" cancel-text="取消" :confirm-loading="editSaving" @ok="saveEdit" @cancel="editing = null">
    <a-form layout="vertical">
      <a-form-item label="名称"><a-input v-model:value="editForm.name" :maxlength="200" /></a-form-item>
      <a-form-item label="标签" extra="输入后回车添加，最多 20 个">
        <a-select v-model:value="editForm.tags" mode="tags" :options="allTags" placeholder="添加标签" style="width: 100%" />
      </a-form-item>
    </a-form>
  </a-modal>

  <a-modal
    :open="!!pushAssets" :title="pushAssets?.length === 1 ? `推送 ${pushAssets[0]!.name} 到设备` : `推送 ${pushAssets?.length ?? 0} 个素材到设备`"
    ok-text="推送" cancel-text="取消" :confirm-loading="pushing" @ok="doPush" @cancel="pushAssets = null"
  >
    <a-select
      v-model:value="pushTargets" mode="multiple" style="width: 100%" placeholder="选择运行中的设备" :options="runningDevices"
      :not-found-content="'没有运行中的设备'" option-filter-prop="label"
    />
    <p class="hint" style="margin-top: 8px">每台设备的每个素材是一个独立任务；文件会出现在相册和应用的选择器中。</p>
  </a-modal>

  <a-modal v-model:open="storageOpen" title="存储设置" :footer="null" width="560px">
    <a-spin :spinning="storageLoading">
      <a-form layout="vertical">
        <a-form-item label="存储位置" extra="只影响之后上传的素材；已有素材仍从原存储读取">
          <a-radio-group v-model:value="storageForm.type">
            <a-radio-button value="local">本地存储</a-radio-button>
            <a-radio-button value="s3">S3 对象存储</a-radio-button>
          </a-radio-group>
        </a-form-item>
        <template v-if="isS3">
          <a-form-item label="Endpoint" :extra="ENDPOINT_HINT">
            <a-input v-model:value="storageForm.endpoint" :placeholder="ENDPOINT_PLACEHOLDER" />
          </a-form-item>
          <a-row :gutter="12">
            <a-col :xs="24" :sm="12">
              <a-form-item label="Region" extra="R2 填 auto；OSS 填 oss-cn-hangzhou 等"><a-input v-model:value="storageForm.region" placeholder="us-east-1" /></a-form-item>
            </a-col>
            <a-col :xs="24" :sm="12">
              <a-form-item label="Bucket" required><a-input v-model:value="storageForm.bucket" placeholder="my-bucket" /></a-form-item>
            </a-col>
          </a-row>
          <a-form-item label="Access Key ID" required><a-input v-model:value="storageForm.accessKeyId" autocomplete="off" /></a-form-item>
          <a-form-item label="Secret Access Key" :required="!hasSecret" :extra="hasSecret ? '已保存，留空不修改（修改 Endpoint / Bucket / Access Key 时需重新填写）' : '加密保存，保存后不会再显示'">
            <a-input-password v-model:value="storageForm.secretAccessKey" autocomplete="new-password" :placeholder="hasSecret ? '已保存，留空不修改' : ''" />
          </a-form-item>
          <a-row :gutter="12">
            <a-col :xs="24" :sm="12">
              <a-form-item label="路径风格（Path-style）" extra="自建存储（如 SeaweedFS / MinIO）通常需要开启">
                <a-switch v-model:checked="storageForm.forcePathStyle" />
              </a-form-item>
            </a-col>
            <a-col :xs="24" :sm="12">
              <a-form-item label="前缀" extra="可选，例如 cloudphone/"><a-input v-model:value="storageForm.prefix" placeholder="cloudphone/" /></a-form-item>
            </a-col>
          </a-row>
          <a-alert type="warning" show-icon style="margin-bottom: 12px"
            message="更换 Bucket 或 Endpoint 后，之前存到 S3 的素材将无法读取（不会自动迁移）。" />
        </template>
        <a-alert
          v-if="testResult" :type="testResult.ok ? 'success' : 'error'" show-icon style="margin-bottom: 12px"
          :message="testResult.ok ? `连接正常（写入、读取、删除测试通过，耗时 ${testResult.latencyMs} ms）` : `连接失败：${testResult.error}`"
        />
        <div style="display: flex; justify-content: flex-end; gap: 8px">
          <a-button @click="storageOpen = false">取消</a-button>
          <a-button :loading="storageTesting" @click="testStorage">测试连接</a-button>
          <a-button type="primary" :loading="storageSaving" @click="saveStorage">保存</a-button>
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
.hint { color: #8c8c8c; font-size: 12px; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 12px; }
.item { border: 1px solid #f0f0f0; border-radius: 8px; overflow: hidden; background: #fff; display: flex; flex-direction: column; min-width: 0; }
.item.checked { border-color: #1677ff; box-shadow: 0 0 0 1px #1677ff; }
.thumb { position: relative; height: 140px; background: #fafafa; display: flex; align-items: center; justify-content: center; }
.thumb img { width: 100%; height: 100%; object-fit: cover; }
.icon { font-size: 40px; color: #bfbfbf; }
.check { position: absolute; top: 8px; left: 8px; }
.badge { position: absolute; top: 8px; right: 0; }
.meta { padding: 8px 10px 0; min-width: 0; flex: 1; }
.name { display: block; font-weight: 500; }
.tags { margin-top: 4px; display: flex; flex-wrap: wrap; gap: 4px 0; }
.actions { display: flex; justify-content: space-around; border-top: 1px solid #f0f0f0; padding: 2px 0; margin-top: 8px; }
@media (max-width: 640px) {
  .grid { grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 8px; }
  .thumb { height: 110px; }
  .search { width: 100%; }
}
</style>
