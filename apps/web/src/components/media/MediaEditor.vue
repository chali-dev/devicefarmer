<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { PlayCircleOutlined } from '@ant-design/icons-vue'
import { useI18n } from 'vue-i18n'
import { MODAL_WIDTH } from '../common/ui'
import MediaCropper from './MediaCropper.vue'
import { defaultRect, EDITOR_ASPECTS, encodePreview, fmtSize, lockedRatio, plan, type EditSettings, type PendingFile, type Rect } from './media'

/**
 * Edit-before-upload: crop (move/resize, aspect presets), size and quality per file, with a
 * client-side preview of the result. Nothing is uploaded until 保存 (this file) or 保存全部.
 * 取消 drops the current file; closing the dialog drops all files still in it.
 */
const props = defineProps<{ items: PendingFile[] }>()
const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ save: [uids: number[]]; discard: [uids: number[]] }>()
const { t } = useI18n()

const currentUid = ref<number | null>(null)
const cur = computed(() => props.items.find((i) => i.uid === currentUid.value) ?? props.items[0] ?? null)
watch(() => props.items.length, (n) => { if (!n) open.value = false })

const aspectOptions = computed(() => EDITOR_ASPECTS.map((a) => ({ value: a, label: t(`media.aspect_${a.replace(/[:.]/g, '')}`) })))
const sizeOptions = computed(() => [{ value: 'original', label: t('media.sizeOriginal') }, { value: 1080, label: '1080p' }, { value: 720, label: '720p' }])
const qualityOptions = computed(() => (['original', 'high', 'medium', 'low'] as const).map((q) => ({ value: q, label: t(`media.quality_${q}`) })))

const ratio = computed(() => (cur.value?.dims ? lockedRatio(cur.value.settings.aspect, cur.value.dims.w, cur.value.dims.h) : null))
/** The crop box shown: the stored rect, or the default box for the preset once the size is known. */
const rect = computed<Rect | null>({
  get: () => (cur.value?.dims ? cur.value.rect ?? defaultRect(cur.value.dims.w, cur.value.dims.h, ratio.value) : null),
  set: (v) => { if (cur.value) cur.value.rect = v },
})
function setAspect(i: PendingFile, a: EditSettings['aspect']) {
  if (i.settings.aspect === a) return
  i.settings.aspect = a
  i.rect = null // re-fit: largest centred box of the new preset
}
function applyToAll() {
  const c = cur.value
  if (!c) return
  for (const i of props.items) {
    if (i === c || !i.processable) continue
    setAspect(i, c.settings.aspect)
    i.settings.maxSize = c.settings.maxSize
    i.settings.quality = c.settings.quality
  }
}

const result = computed(() => (cur.value?.dims && cur.value.processable ? plan(cur.value.dims.w, cur.value.dims.h, cur.value.settings, cur.value.rect, cur.value.video) : null))

// ------------------------------------------------------------ preview (debounced canvas render + encode)
const frame = shallowRef<HTMLImageElement | HTMLVideoElement | null>(null)
/** Bumped on every new frame (video seek), since the element itself stays the same. */
const frameTick = ref(0)
function onFrame(el: HTMLImageElement | HTMLVideoElement) { frame.value = el; frameTick.value++ }
/** `owned`: an object URL made here (revoked on replace), not the file's own URL. */
const preview = shallowRef<{ url: string; size: number | null; owned: boolean } | null>(null)
const rendering = ref(false)
let timer: ReturnType<typeof setTimeout> | undefined
let seq = 0
function setPreview(p: typeof preview.value) {
  if (preview.value?.owned) URL.revokeObjectURL(preview.value.url)
  preview.value = p
}
async function render() {
  const c = cur.value, r = result.value, src = frame.value
  const my = ++seq
  if (!c || !src) { setPreview(null); return }
  if (!c.processable || !r?.any) {
    // Uploaded as is: an image previews as itself, a video needs no preview.
    setPreview(c.video ? null : { url: c.url, size: c.file.size, owned: false })
    return
  }
  rendering.value = true
  try {
    // Video: only a picture of the cropped frame (scaled down), no client-side transcoding.
    const out = c.video ? scaleTo(r.out, 480) : r.out
    const blob = await encodePreview(src, r.box, out, c.video ? 'jpeg' : c.formatId, c.video ? 'high' : c.settings.quality)
    if (my !== seq || !blob) return
    setPreview({ url: URL.createObjectURL(blob), size: c.video ? null : blob.size, owned: true })
  } finally { if (my === seq) rendering.value = false }
}
const scaleTo = (o: { w: number; h: number }, max: number) => {
  const s = Math.min(1, max / Math.max(o.w, o.h))
  return { w: Math.max(1, Math.round(o.w * s)), h: Math.max(1, Math.round(o.h * s)) }
}
// `result` is a new object whenever settings/rect/dims change; debounce so dragging stays smooth.
watch([() => cur.value?.uid, result, () => cur.value?.settings.quality, frameTick], () => {
  clearTimeout(timer)
  timer = setTimeout(() => void render(), 250)
})
watch(() => cur.value?.uid, () => { frame.value = null; setPreview(null) })
onBeforeUnmount(() => { clearTimeout(timer); setPreview(null) })

const estimate = computed(() => {
  const c = cur.value, r = result.value
  if (!c || c.video || !r?.any || !preview.value?.size) return null
  const size = preview.value.size
  const pngPalette = c.formatId === 'png' && (c.settings.quality === 'medium' || c.settings.quality === 'low')
  // Same rule as the server: a re-encode that isn't smaller and changes nothing visible keeps the upload.
  const kept = !!r?.any && !r.cropped && !r.resized && size >= c.file.size
  return { size: kept ? c.file.size : size, pct: Math.round(((kept ? c.file.size : size) / c.file.size) * 100), pngPalette, kept }
})
const pixelPct = computed(() => {
  const c = cur.value, r = result.value
  return c?.dims && r ? Math.round(((r.out.w * r.out.h) / (c.dims.w * c.dims.h)) * 100) : 100
})

function discardCurrent() { if (cur.value) emit('discard', [cur.value.uid]) }
function saveCurrent() { if (cur.value) emit('save', [cur.value.uid]) }
function saveAll() { emit('save', props.items.map((i) => i.uid)) }
function close() { emit('discard', props.items.map((i) => i.uid)) }
</script>

<template>
  <a-modal
    :open="open" :title="t('media.editorTitle')" :width="MODAL_WIDTH.lg" :mask-closable="false" destroy-on-close
    @cancel="close"
  >
    <div v-if="items.length > 1" class="strip">
      <button
        v-for="i in items" :key="i.uid" type="button" class="strip-item" :class="{ active: cur?.uid === i.uid }"
        :title="i.file.name" @click="currentUid = i.uid"
      >
        <img v-if="!i.video" :src="i.url" alt="">
        <span v-else class="strip-video"><PlayCircleOutlined /></span>
        <span class="strip-name">{{ i.file.name }}</span>
      </button>
    </div>

    <template v-if="cur">
      <a-row :gutter="16">
        <a-col :xs="24" :md="15">
          <MediaCropper
            :key="cur.uid" v-model:rect="rect" v-model:dims="cur.dims" :src="cur.url" :video="cur.video" :ratio="ratio"
            :disabled="!cur.processable" @frame="onFrame"
          />
          <div class="muted small" style="margin-top: 6px">
            <a-typography-text :content="cur.file.name" :ellipsis="{ tooltip: cur.file.name }" style="max-width: 60%" />
            <span v-if="cur.processable"> · {{ t('media.editorCropHint') }}</span>
          </div>
        </a-col>
        <a-col :xs="24" :md="9">
          <div class="preview-head">{{ t('media.editorPreview') }}<a-spin v-if="rendering" size="small" style="margin-left: 8px" /></div>
          <div class="preview">
            <img v-if="preview" :src="preview.url" alt="">
            <span v-else class="muted small">{{ cur.video && !result?.any ? t('media.editorAsUploaded') : '…' }}</span>
          </div>
          <dl class="facts">
            <dt>{{ t('media.editorSource') }}</dt>
            <dd>{{ cur.dims ? `${cur.dims.w}×${cur.dims.h}` : '…' }} · {{ fmtSize(cur.file.size) }}</dd>
            <template v-if="cur.processable && result">
              <dt>{{ t('media.editorOutput') }}</dt>
              <dd>
                {{ result.out.w }}×{{ result.out.h }}
                <template v-if="estimate"> · {{ estimate.pngPalette ? t('media.editorEstUpper', { size: fmtSize(estimate.size) }) : t('media.editorEst', { size: fmtSize(estimate.size), pct: estimate.pct }) }}</template>
              </dd>
            </template>
          </dl>
          <div class="muted small note">
            <template v-if="!cur.processable">{{ t('media.processUnsupported') }}</template>
            <template v-else-if="!result?.any">{{ t('media.editorAsUploaded') }}</template>
            <template v-else-if="cur.video">{{ t('media.editorVideoNote', { pct: pixelPct }) }}</template>
            <template v-else-if="estimate?.kept">{{ t('media.editorKept') }}</template>
            <template v-else-if="estimate?.pngPalette">{{ t('media.editorPngNote') }}</template>
            <template v-else>{{ t('media.editorEstNote') }}</template>
          </div>
        </a-col>
      </a-row>

      <a-form v-if="cur.processable" layout="vertical" class="controls">
        <a-form-item :label="t('media.processCrop')">
          <a-radio-group :value="cur.settings.aspect" size="small" button-style="solid" @update:value="(v: EditSettings['aspect']) => setAspect(cur!, v)">
            <a-radio-button v-for="o in aspectOptions" :key="o.value" :value="o.value">{{ o.label }}</a-radio-button>
          </a-radio-group>
        </a-form-item>
        <a-row :gutter="16">
          <a-col :xs="24" :sm="10">
            <a-form-item :label="t('media.processSize')">
              <a-radio-group v-model:value="cur.settings.maxSize" size="small" button-style="solid">
                <a-radio-button v-for="o in sizeOptions" :key="o.value" :value="o.value">{{ o.label }}</a-radio-button>
              </a-radio-group>
            </a-form-item>
          </a-col>
          <a-col :xs="24" :sm="14">
            <a-form-item :label="t('media.processQuality')">
              <a-radio-group v-model:value="cur.settings.quality" size="small" button-style="solid">
                <a-radio-button v-for="o in qualityOptions" :key="o.value" :value="o.value">{{ o.label }}</a-radio-button>
              </a-radio-group>
            </a-form-item>
          </a-col>
        </a-row>
      </a-form>
    </template>

    <template #footer>
      <div class="footer">
        <a-tooltip v-if="items.length > 1" :title="t('media.editorApplyAllHint')">
          <a-button :disabled="!cur?.processable" @click="applyToAll">{{ t('media.editorApplyAll') }}</a-button>
        </a-tooltip>
        <span class="grow" />
        <a-button @click="discardCurrent">{{ t('common.cancel') }}</a-button>
        <a-button :type="items.length > 1 ? 'default' : 'primary'" @click="saveCurrent">{{ t('common.save') }}</a-button>
        <a-button v-if="items.length > 1" type="primary" @click="saveAll">{{ t('media.editorSaveAll', { n: items.length }) }}</a-button>
      </div>
    </template>
  </a-modal>
</template>

<style scoped>
.strip { display: flex; gap: 8px; overflow-x: auto; padding-bottom: 8px; margin-bottom: 12px; border-bottom: 1px solid var(--cp-border-secondary); }
.strip-item {
  flex: none; display: flex; flex-direction: column; align-items: center; gap: 4px; width: 84px; padding: 4px;
  border: 1px solid var(--cp-border-secondary); border-radius: var(--cp-radius); background: var(--cp-bg-container); cursor: pointer; color: inherit;
}
.strip-item.active { border-color: var(--cp-primary); box-shadow: 0 0 0 1px var(--cp-primary); }
.strip-item img, .strip-video { width: 72px; height: 48px; object-fit: cover; border-radius: 2px; background: var(--cp-fill-alter); }
.strip-video { display: flex; align-items: center; justify-content: center; font-size: 20px; color: var(--cp-text-secondary); }
.strip-name { font-size: 12px; width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.preview-head { font-weight: 500; margin-bottom: 6px; display: flex; align-items: center; }
.preview {
  display: flex; align-items: center; justify-content: center; height: 200px; padding: 8px;
  background: var(--cp-fill-alter); border-radius: var(--cp-radius);
  /* checkerboard so transparency in PNG/WebP previews is visible */
  background-image: conic-gradient(var(--cp-border-secondary) 25%, transparent 0 50%, var(--cp-border-secondary) 0 75%, transparent 0);
  background-size: 16px 16px;
}
.preview img { max-width: 100%; max-height: 184px; display: block; }
.facts { display: grid; grid-template-columns: auto 1fr; gap: 2px 8px; margin: 8px 0 4px; font-size: 13px; }
.facts dt { color: var(--cp-text-secondary); }
.facts dd { margin: 0; font-variant-numeric: tabular-nums; }
/* fixed/reserved heights so the controls below don't jump while the preview and notes change */
.facts { min-height: 4.4em; align-content: start; }
.note { line-height: 1.5; min-height: 4.5em; }
.controls { margin-top: var(--cp-gap); }
.controls :deep(.ant-form-item) { margin-bottom: 8px; }
.footer { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.grow { flex: 1; }
</style>
