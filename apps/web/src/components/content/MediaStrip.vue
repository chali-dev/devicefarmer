<script setup lang="ts">
import { onBeforeUnmount, watch } from 'vue'
import { ArrowLeftOutlined, ArrowRightOutlined, CloseOutlined, LoadingOutlined, PictureOutlined, PlayCircleFilled } from '@ant-design/icons-vue'
import { useI18n } from 'vue-i18n'
import type { ContentMedia, MediaItem } from '../../api/types'
import { fmtDuration, useThumbs } from '../media/media'

/** Row of media thumbnails (content / publish task). `editable` adds reorder + remove controls. */
const props = withDefaults(defineProps<{ media: ContentMedia[]; size?: number; editable?: boolean; max?: number }>(), { size: 48, editable: false, max: 0 })
const emit = defineEmits<{ move: [index: number, delta: number]; remove: [index: number] }>()
const { t } = useI18n()
const thumbs = useThumbs()
const asItem = (m: ContentMedia) => ({ ...m, updatedAt: '' }) as unknown as MediaItem
watch(() => props.media, (m) => { void thumbs.load(m.map(asItem)) }, { immediate: true })
onBeforeUnmount(() => thumbs.dispose())
const shown = () => (props.max ? props.media.slice(0, props.max) : props.media)
</script>

<template>
  <div class="strip">
    <div v-for="(m, i) in shown()" :key="m.id" class="cell" :style="{ width: `${size}px` }" :title="m.name">
      <div class="thumb" :style="{ width: `${size}px`, height: `${size}px` }">
        <img v-if="thumbs.get(asItem(m))" :src="thumbs.get(asItem(m))" :alt="m.name" />
        <LoadingOutlined v-else-if="m.status === 'processing'" class="ph" spin />
        <PictureOutlined v-else class="ph" />
        <span v-if="m.fileType === 'video'" class="badge"><PlayCircleFilled /> {{ fmtDuration(m.duration) }}</span>
        <span v-if="m.status !== 'ready'" class="state" :class="{ failed: m.status === 'failed' }">{{ t(`media.statuses.${m.status}`) }}</span>
      </div>
      <div v-if="editable" class="ctl">
        <a-button size="small" type="text" :disabled="i === 0" :aria-label="t('content.moveUp')" @click="emit('move', i, -1)"><ArrowLeftOutlined /></a-button>
        <a-button size="small" type="text" :disabled="i === media.length - 1" :aria-label="t('content.moveDown')" @click="emit('move', i, 1)"><ArrowRightOutlined /></a-button>
        <a-button size="small" type="text" danger :aria-label="t('content.removeMedia')" @click="emit('remove', i)"><CloseOutlined /></a-button>
      </div>
    </div>
    <span v-if="max && media.length > max" class="more">+{{ media.length - max }}</span>
  </div>
</template>

<style scoped>
.strip { display: flex; flex-wrap: wrap; gap: 6px; align-items: flex-start; }
.cell { display: flex; flex-direction: column; align-items: center; }
.thumb {
  position: relative; border-radius: 4px; overflow: hidden; background: var(--cp-fill-alter);
  display: flex; align-items: center; justify-content: center; border: 1px solid var(--cp-border-secondary);
}
.thumb img { width: 100%; height: 100%; object-fit: cover; }
.ph { color: var(--cp-text-quaternary); }
.badge {
  position: absolute; left: 2px; bottom: 2px; font-size: 10px; line-height: 14px; padding: 0 3px; border-radius: 3px;
  background: rgba(0, 0, 0, 0.6); color: #fff;
}
.state { position: absolute; top: 2px; right: 2px; font-size: 10px; padding: 0 3px; border-radius: 3px; background: var(--cp-bg-container); color: var(--cp-warning); }
.state.failed { color: var(--cp-error); }
.ctl { display: flex; }
.more { align-self: center; color: var(--cp-text-secondary); font-size: 12px; }
</style>
