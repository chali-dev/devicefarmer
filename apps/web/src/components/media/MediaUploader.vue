<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { CloudUploadOutlined, DeleteOutlined, ReloadOutlined } from '@ant-design/icons-vue'
import { useI18n } from 'vue-i18n'
import { errorText } from '../../api/client'
import type { MediaCategory, MediaLimits } from '../../api/types'
import { acceptAttr, allExts, fmtSize, precheck, xhrUpload } from './media'

/** Multi-file upload: drag & drop, client pre-check, 2 parallel XHRs with progress, retry. */
const props = defineProps<{ scope: 'public' | 'mine'; scopeLabel: string; limits: MediaLimits | null; categories: MediaCategory[] }>()
const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ uploaded: [] }>()
const { t } = useI18n()

interface Entry { uid: number; file: File; state: 'waiting' | 'uploading' | 'done' | 'error'; pct: number; error: string; abort?: () => void }
const entries = ref<Entry[]>([])
const categoryId = ref<string | undefined>(undefined)
let uid = 0
const CONCURRENCY = 2

watch(open, (v) => { if (v && !entries.value.some((e) => e.state === 'uploading' || e.state === 'waiting')) entries.value = [] })

const stats = computed(() => ({
  total: entries.value.length,
  done: entries.value.filter((e) => e.state === 'done').length,
  failed: entries.value.filter((e) => e.state === 'error').length,
  busy: entries.value.some((e) => e.state === 'uploading' || e.state === 'waiting'),
}))

function add(file: File) {
  const e = reactive<Entry>({ uid: ++uid, file, state: 'waiting', pct: 0, error: '' })
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
  <a-modal v-model:open="open" :title="t('media.uploadTitle', { scope: scopeLabel })" :footer="null" width="640px" :mask-closable="!stats.busy">
    <a-form-item v-if="categories.length" :label="t('media.uploadCategory')" style="margin-bottom: 12px">
      <a-select
        v-model:value="categoryId" allow-clear :placeholder="t('media.uncategorized')" style="width: 240px"
        :options="categories.map((c) => ({ value: c.id, label: c.name }))"
      />
    </a-form-item>
    <a-upload-dragger :multiple="true" :show-upload-list="false" :before-upload="add" :accept="accept">
      <p style="margin: 8px 0"><CloudUploadOutlined class="upload-icon" /></p>
      <p style="margin: 0">{{ t('media.drop') }}</p>
      <p class="hint" style="margin: 4px 8px 8px">{{ hint }}</p>
    </a-upload-dragger>
    <p class="hint" style="margin: 8px 0">{{ t('media.processingNote') }}</p>

    <div v-if="entries.length" class="files">
      <div class="files-head">
        <span>{{ t('media.uploadSummary', stats) }}</span>
        <a-space>
          <a-button v-if="stats.failed" size="small" @click="retryFailed"><ReloadOutlined /> {{ t('media.retryFailed') }}</a-button>
          <a-button v-if="stats.done" size="small" @click="clearDone">{{ t('media.clearDone') }}</a-button>
        </a-space>
      </div>
      <div v-for="e in entries" :key="e.uid" class="file">
        <div class="file-row">
          <a-typography-text class="file-name" :content="e.file.name" :ellipsis="{ tooltip: e.file.name }" />
          <span class="hint">{{ fmtSize(e.file.size) }}</span>
          <a-tooltip v-if="e.state === 'error'" :title="t('media.retry')">
            <a-button type="text" size="small" @click="retry(e)"><ReloadOutlined /></a-button>
          </a-tooltip>
          <a-button v-if="e.state !== 'done'" type="text" size="small" @click="remove(e)"><DeleteOutlined /></a-button>
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
</template>

<style scoped>
.upload-icon { font-size: 24px; color: var(--cp-primary); }
.hint { color: var(--cp-text-tertiary); font-size: 12px; }
.files { max-height: 320px; overflow: auto; border-top: 1px solid var(--cp-border-secondary); padding-top: 8px; }
.files-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; gap: 8px; flex-wrap: wrap; }
.file { padding: 4px 0; }
.file-row { display: flex; align-items: center; gap: 8px; min-width: 0; }
.file-name { flex: 1; min-width: 0; }
.err { color: var(--cp-error); font-size: 12px; }
</style>
