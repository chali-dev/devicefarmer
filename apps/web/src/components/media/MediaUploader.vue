<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { CloudUploadOutlined, DeleteOutlined, ReloadOutlined } from '@ant-design/icons-vue'
import { useI18n } from 'vue-i18n'
import { errorText } from '../../api/client'
import type { MediaCategory, MediaCropAspect, MediaLimits, MediaProcessOptions } from '../../api/types'
import { MODAL_WIDTH } from '../common/ui'
import MediaCropper from './MediaCropper.vue'
import { acceptAttr, allExts, fmtSize, isProcessable, isVideoFile, outputSize, precheck, xhrUpload } from './media'

/**
 * Multi-file upload: drag & drop, client pre-check, 2 parallel XHRs with progress, retry.
 * Optional crop/compress (done by the server): one set of options for the batch, crop position
 * per file. With options set, files wait for "start upload" so the crop can be positioned.
 */
const props = defineProps<{ scope: 'public' | 'mine'; scopeLabel: string; limits: MediaLimits | null; categories: MediaCategory[] }>()
const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ uploaded: [] }>()
const { t } = useI18n()

interface Entry {
  uid: number; file: File; state: 'ready' | 'waiting' | 'uploading' | 'done' | 'error'; pct: number; error: string; abort?: () => void
  pos: { x: number; y: number }; dims: { w: number; h: number } | null
}
const entries = ref<Entry[]>([])
const categoryId = ref<string | undefined>(undefined)
let uid = 0
const CONCURRENCY = 2

const aspect = ref<MediaCropAspect>('original')
const maxSize = ref<'original' | 1080 | 720>('original')
const quality = ref<'original' | 'high' | 'medium' | 'low'>('original')
const processing = computed(() => aspect.value !== 'original' || maxSize.value !== 'original' || quality.value !== 'original')
const aspectOptions = computed(() => ([
  ['original', 'aspectOriginal'], ['1:1', 'aspect11'], ['4:5', 'aspect45'], ['9:16', 'aspect916'], ['16:9', 'aspect169'], ['1.91:1', 'aspect191'],
] as const).map(([value, key]) => ({ value, label: t(`media.${key}`) })))
const sizeOptions = computed(() => [{ value: 'original', label: t('media.sizeOriginal') }, { value: 1080, label: '1080p' }, { value: 720, label: '720p' }])
const qualityOptions = computed(() => (['original', 'high', 'medium', 'low'] as const).map((q) => ({ value: q, label: t(`media.quality_${q}`) })))
const canProcess = (e: Entry) => isProcessable(e.file, props.limits)

function processOptions(e: Entry): MediaProcessOptions | null {
  if (!processing.value || !canProcess(e)) return null
  const o: MediaProcessOptions = {}
  if (aspect.value !== 'original') o.crop = { aspect: aspect.value, x: e.pos.x, y: e.pos.y }
  if (maxSize.value !== 'original') o.maxSize = maxSize.value
  if (quality.value !== 'original') o.quality = quality.value
  return o
}

const selectedUid = ref<number | null>(null)
const selected = computed(() => entries.value.find((e) => e.uid === selectedUid.value && e.state === 'ready') ?? entries.value.find((e) => e.state === 'ready') ?? null)
const resultHint = computed(() => {
  const e = selected.value
  if (!e?.dims || !processing.value) return ''
  const o = outputSize(e.dims.w, e.dims.h, aspect.value, maxSize.value === 'original' ? null : maxSize.value, isVideoFile(e.file, props.limits))
  return t('media.processHint', { from: `${e.dims.w}×${e.dims.h}`, to: `${o.w}×${o.h}` })
})
const readyCount = computed(() => entries.value.filter((e) => e.state === 'ready').length)
function startReady() {
  for (const e of entries.value) if (e.state === 'ready') e.state = 'waiting'
  pump()
}

watch(open, (v) => { if (v && !entries.value.some((e) => e.state === 'uploading' || e.state === 'waiting' || e.state === 'ready')) entries.value = [] })

const stats = computed(() => ({
  total: entries.value.length,
  done: entries.value.filter((e) => e.state === 'done').length,
  failed: entries.value.filter((e) => e.state === 'error').length,
  busy: entries.value.some((e) => e.state === 'uploading' || e.state === 'waiting'),
}))

function add(file: File) {
  const e = reactive<Entry>({ uid: ++uid, file, state: processing.value ? 'ready' : 'waiting', pct: 0, error: '', pos: { x: 0.5, y: 0.5 }, dims: null })
  if (props.limits) {
    const bad = precheck(file, props.limits)
    if (bad) { e.state = 'error'; e.error = t(bad.key, bad.params) }
  }
  entries.value.push(e)
  pump()
  return false // keep ant's own upload out of it
}

function pump() {
  const active = entries.value.filter((e) => e.state === 'uploading').length
  const next = entries.value.filter((e) => e.state === 'waiting').slice(0, Math.max(0, CONCURRENCY - active))
  for (const e of next) void start(e)
}

async function start(e: Entry) {
  e.state = 'uploading'
  e.pct = 0
  e.error = ''
  const fields: Record<string, string> = { scope: props.scope }
  if (categoryId.value) fields.categoryId = categoryId.value
  const proc = processOptions(e)
  if (proc) fields.process = JSON.stringify(proc)
  const up = xhrUpload(fields, e.file, (p) => { e.pct = p })
  e.abort = up.abort
  try {
    await up.promise
    e.state = 'done'
  } catch (err) {
    e.state = 'error'
    e.error = errorText(err)
  } finally {
    e.abort = undefined
    pump()
    if (!stats.value.busy && stats.value.done) emit('uploaded')
  }
}

function retry(e: Entry) {
  if (props.limits && precheck(e.file, props.limits)) return
  e.state = 'waiting'
  pump()
}
function retryFailed() { for (const e of entries.value) if (e.state === 'error') retry(e) }
function remove(e: Entry) {
  e.abort?.()
  entries.value = entries.value.filter((x) => x.uid !== e.uid)
}
function clearDone() { entries.value = entries.value.filter((e) => e.state !== 'done') }

const hint = computed(() => props.limits
  ? t('media.dropHint', { imageExts: allExts(props.limits, 'image'), imageMb: props.limits.image.maxMb, videoExts: allExts(props.limits, 'video'), videoMb: props.limits.video.maxMb })
  : '')
const accept = computed(() => (props.limits ? acceptAttr(props.limits) : 'image/*,video/*'))

onBeforeUnmount(() => { for (const e of entries.value) e.abort?.() })
</script>

<template>
  <a-modal v-model:open="open" :title="t('media.uploadTitle', { scope: scopeLabel })" :footer="null" :width="MODAL_WIDTH.md" :mask-closable="!stats.busy">
    <a-form-item v-if="categories.length" :label="t('media.uploadCategory')">
      <a-select
        v-model:value="categoryId" allow-clear :placeholder="t('media.uncategorized')" style="width: 240px; max-width: 100%"
        :options="categories.map((c) => ({ value: c.id, label: c.name }))"
      />
    </a-form-item>
    <a-form layout="vertical">
      <a-row :gutter="12">
        <a-col :xs="24" :sm="8"><a-form-item :label="t('media.processCrop')"><a-select v-model:value="aspect" :options="aspectOptions" /></a-form-item></a-col>
        <a-col :xs="12" :sm="8"><a-form-item :label="t('media.processSize')"><a-select v-model:value="maxSize" :options="sizeOptions" /></a-form-item></a-col>
        <a-col :xs="12" :sm="8"><a-form-item :label="t('media.processQuality')"><a-select v-model:value="quality" :options="qualityOptions" /></a-form-item></a-col>
      </a-row>
    </a-form>
    <a-upload-dragger :multiple="true" :show-upload-list="false" :before-upload="add" :accept="accept">
      <p style="margin: 8px 0"><CloudUploadOutlined class="upload-icon" /></p>
      <p style="margin: 0">{{ t('media.drop') }}</p>
      <p class="muted small" style="margin: 4px 8px 8px">{{ hint }}</p>
    </a-upload-dragger>

    <div v-if="selected" class="crop">
      <MediaCropper
        v-if="canProcess(selected)" :key="selected.uid" v-model:pos="selected.pos" v-model:dims="selected.dims"
        :file="selected.file" :video="isVideoFile(selected.file, limits)" :aspect="aspect"
      />
      <div class="crop-foot">
        <span class="muted small">{{ canProcess(selected) ? resultHint : t('media.processUnsupported') }}</span>
        <a-button type="primary" size="small" @click="startReady">{{ t('media.startUpload', { n: readyCount }) }}</a-button>
      </div>
    </div>

    <div v-if="entries.length" class="files">
      <div class="files-head">
        <span>{{ t('media.uploadSummary', stats) }}</span>
        <a-space>
          <a-button v-if="stats.failed" size="small" @click="retryFailed"><template #icon><ReloadOutlined /></template>{{ t('media.retryFailed') }}</a-button>
          <a-button v-if="stats.done" size="small" @click="clearDone">{{ t('media.clearDone') }}</a-button>
        </a-space>
      </div>
      <div
        v-for="e in entries" :key="e.uid" class="file"
        :class="{ pickable: e.state === 'ready', active: e.state === 'ready' && selected?.uid === e.uid }" @click="selectedUid = e.uid"
      >
        <div class="file-row">
          <a-typography-text class="file-name" :content="e.file.name" :ellipsis="{ tooltip: e.file.name }" />
          <span class="muted small nowrap">{{ fmtSize(e.file.size) }}</span>
          <a-tooltip v-if="e.state === 'error'" :title="t('media.retry')">
            <a-button type="text" size="small" :aria-label="t('media.retry')" @click.stop="retry(e)"><ReloadOutlined /></a-button>
          </a-tooltip>
          <a-button v-if="e.state !== 'done'" type="text" size="small" :aria-label="t('common.delete')" @click.stop="remove(e)"><DeleteOutlined /></a-button>
        </div>
        <div v-if="e.state === 'ready'" class="muted small">{{ t('media.pendingStart') }}</div>
        <a-progress
          v-else-if="e.state !== 'error'" :percent="e.pct" size="small"
          :status="e.state === 'done' ? 'success' : e.state === 'uploading' ? 'active' : 'normal'"
          :format="e.state === 'waiting' ? () => t('media.waiting') : undefined"
        />
        <div v-else class="err">{{ e.error }}</div>
      </div>
    </div>
  </a-modal>
</template>

<style scoped>
.upload-icon { font-size: 24px; color: var(--cp-primary); }
.files { max-height: 320px; overflow: auto; border-top: 1px solid var(--cp-border-secondary); padding-top: 8px; margin-top: var(--cp-gap); }
.files-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; gap: 8px; flex-wrap: wrap; }
.file { padding: 4px 0; }
.file-row { display: flex; align-items: center; gap: 8px; min-width: 0; }
.file-name { flex: 1; min-width: 0; }
.err { color: var(--cp-error); font-size: 12px; }
.crop { margin-top: var(--cp-gap); }
.crop-foot { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-top: 8px; flex-wrap: wrap; }
.file.pickable { cursor: pointer; border-radius: var(--cp-radius); padding: 4px 6px; }
.file.active { background: var(--cp-primary-bg); }
</style>
