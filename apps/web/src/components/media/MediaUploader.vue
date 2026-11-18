<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { CloudUploadOutlined, DeleteOutlined, ReloadOutlined } from '@ant-design/icons-vue'
import { useI18n } from 'vue-i18n'
import { errorText } from '../../api/client'
import type { MediaCategory, MediaItem, MediaLimits, MediaProcessOptions } from '../../api/types'
import { MODAL_WIDTH } from '../common/ui'
import MediaEditor from './MediaEditor.vue'
import { acceptAttr, allExts, fileStem, fmtSize, formatOf, isVideoFile, metaFields, precheck, processOptions, xhrUpload, type PendingFile, type UploadMeta } from './media'

/**
 * Multi-file upload: drag & drop / picker → nothing is sent yet; the files open in MediaEditor
 * (crop, size, quality, preview; name, category, tags). 保存 there queues the file here: 2 parallel XHRs with progress,
 * retry. Crop/compress itself runs on the server (media-process job) with the chosen options.
 * `uploaded` fires when the queue is idle again, with the assets uploaded since the last time, in the order they were saved
 * (still `processing`).
 */
/** ownerId (admin, scope mine): upload into that user's personal media. */
const props = defineProps<{ scope: 'public' | 'mine'; ownerId?: string; scopeLabel: string; limits: MediaLimits | null; categories: MediaCategory[]; tagOptions: string[] }>()
const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ uploaded: [items: MediaItem[]]; categoriesChanged: [] }>()
const { t } = useI18n()

interface Entry {
  uid: number; file: File; process: MediaProcessOptions | null; meta: UploadMeta | null
  state: 'waiting' | 'uploading' | 'done' | 'error'; pct: number; error: string; abort?: () => void
  /** The created asset once uploaded; `reported` once it was passed on with `uploaded`. */
  item?: MediaItem; reported?: boolean
}
const entries = ref<Entry[]>([])
const pending = ref<PendingFile[]>([])
const editorOpen = ref(false)
let uid = 0
const CONCURRENCY = 2

watch(open, (v) => { if (v && !entries.value.some((e) => e.state === 'uploading' || e.state === 'waiting')) entries.value = [] })

const stats = computed(() => ({
  total: entries.value.length,
  done: entries.value.filter((e) => e.state === 'done').length,
  failed: entries.value.filter((e) => e.state === 'error').length,
  busy: entries.value.some((e) => e.state === 'uploading' || e.state === 'waiting'),
}))

/** Picked file: rejected ones are listed with the reason, the rest go to the editor. */
function add(file: File) {
  const bad = props.limits ? precheck(file, props.limits) : null
  if (bad) entries.value.push(reactive<Entry>({ uid: ++uid, file, process: null, meta: null, state: 'error', pct: 0, error: t(bad.key, bad.params) }))
  else {
    const fmt = formatOf(file, props.limits)
    pending.value.push(reactive<PendingFile>({
      uid: ++uid, file, url: URL.createObjectURL(file), video: isVideoFile(file, props.limits), processable: Boolean(fmt?.processable), formatId: fmt?.id ?? '',
      settings: { aspect: 'free', maxSize: 'original', quality: 'original' }, rect: null, dims: null,
      meta: { name: fileStem(file.name), categoryId: undefined, tags: [] },
    }))
    editorOpen.value = true
  }
  return false // keep ant's own upload out of it
}

function dropPending(uids: number[]) {
  for (const p of pending.value) if (uids.includes(p.uid)) URL.revokeObjectURL(p.url)
  pending.value = pending.value.filter((p) => !uids.includes(p.uid))
}
function save(uids: number[]) {
  for (const p of pending.value.filter((x) => uids.includes(x.uid))) {
    const proc = p.processable ? processOptions(p.settings, p.rect, p.dims, p.video) : null
    entries.value.push(reactive<Entry>({ uid: p.uid, file: p.file, process: proc, meta: { ...p.meta, tags: [...p.meta.tags] }, state: 'waiting', pct: 0, error: '' }))
  }
  dropPending(uids)
  pump()
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
  const fields: Record<string, string> = { scope: props.scope, ...(props.ownerId ? { ownerId: props.ownerId } : {}), ...(e.meta ? metaFields(e.meta) : {}) }
  if (e.process) fields.process = JSON.stringify(e.process)
  const up = xhrUpload(fields, e.file, (p) => { e.pct = p })
  e.abort = up.abort
  try {
    e.item = await up.promise
    e.state = 'done'
  } catch (err) {
    e.state = 'error'
    e.error = errorText(err)
  } finally {
    e.abort = undefined
    pump()
    if (!stats.value.busy) {
      const fresh = entries.value.filter((x) => x.state === 'done' && x.item && !x.reported)
      for (const x of fresh) x.reported = true
      if (fresh.length) emit('uploaded', fresh.map((x) => x.item!))
    }
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
/** Short summary of what the server will do, shown on the queued row. */
function processText(p: MediaProcessOptions | null) {
  if (!p) return ''
  return [p.crop ? t('media.processCrop') : '', p.maxSize ? `${p.maxSize}p` : '', p.quality ? t(`media.quality_${p.quality}`) : ''].filter(Boolean).join(' · ')
}

onBeforeUnmount(() => {
  for (const e of entries.value) e.abort?.()
  dropPending(pending.value.map((p) => p.uid))
})
</script>

<template>
  <a-modal v-model:open="open" :title="t('media.uploadTitle', { scope: scopeLabel })" :footer="null" :width="MODAL_WIDTH.md" :mask-closable="!stats.busy">
    <a-upload-dragger :multiple="true" :show-upload-list="false" :before-upload="add" :accept="accept">
      <p style="margin: 8px 0"><CloudUploadOutlined class="upload-icon" /></p>
      <p style="margin: 0">{{ t('media.drop') }}</p>
      <p class="muted small" style="margin: 4px 8px 8px">{{ hint }}</p>
      <p class="muted small" style="margin: 0 8px 8px">{{ t('media.dropEditHint') }}</p>
    </a-upload-dragger>

    <div v-if="entries.length" class="files">
      <div class="files-head">
        <span>{{ t('media.uploadSummary', stats) }}</span>
        <a-space>
          <a-button v-if="stats.failed" size="small" @click="retryFailed"><template #icon><ReloadOutlined /></template>{{ t('media.retryFailed') }}</a-button>
          <a-button v-if="stats.done" size="small" @click="clearDone">{{ t('media.clearDone') }}</a-button>
        </a-space>
      </div>
      <div v-for="e in entries" :key="e.uid" class="file">
        <div class="file-row">
          <a-typography-text class="file-name" :content="e.meta?.name || e.file.name" :ellipsis="{ tooltip: e.file.name }" />
          <span v-if="e.process" class="muted small nowrap">{{ processText(e.process) }}</span>
          <span class="muted small nowrap">{{ fmtSize(e.file.size) }}</span>
          <a-tooltip v-if="e.state === 'error'" :title="t('media.retry')">
            <a-button type="text" size="small" :aria-label="t('media.retry')" @click.stop="retry(e)"><ReloadOutlined /></a-button>
          </a-tooltip>
          <a-button v-if="e.state !== 'done'" type="text" size="small" :aria-label="t('common.delete')" @click.stop="remove(e)"><DeleteOutlined /></a-button>
        </div>
        <a-progress
          v-if="e.state !== 'error'" :percent="e.pct" size="small"
          :status="e.state === 'done' ? 'success' : e.state === 'uploading' ? 'active' : 'normal'"
          :format="e.state === 'waiting' ? () => t('media.waiting') : undefined"
        />
        <div v-else class="err">{{ e.error }}</div>
      </div>
    </div>
  </a-modal>
  <MediaEditor
    v-model:open="editorOpen" :items="pending" :scope="scope" :owner-id="ownerId" :categories="categories" :tag-options="tagOptions"
    @save="save" @discard="dropPending" @categories-changed="emit('categoriesChanged')"
  />
</template>

<style scoped>
.upload-icon { font-size: 24px; color: var(--cp-primary); }
.files { max-height: 320px; overflow-y: auto; overflow-x: hidden; border-top: 1px solid var(--cp-border-secondary); padding-top: 8px; margin-top: var(--cp-gap); }
.files-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; gap: 8px; flex-wrap: wrap; }
.file { padding: 4px 0; }
.file-row { display: flex; align-items: center; gap: 8px; min-width: 0; }
.file-name { flex: 1; min-width: 0; }
.err { color: var(--cp-error); font-size: 12px; }
</style>
