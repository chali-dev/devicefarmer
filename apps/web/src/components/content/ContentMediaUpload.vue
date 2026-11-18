<script setup lang="ts">
import { ref } from 'vue'
import { message } from 'ant-design-vue'
import { CloudUploadOutlined } from '@ant-design/icons-vue'
import { useI18n } from 'vue-i18n'
import { api, errorText } from '../../api/client'
import type { ContentMedia, MediaCategory, MediaItem, MediaLimits } from '../../api/types'
import MediaUploader from '../media/MediaUploader.vue'
import { toContentMedia } from '../media/media'

/**
 * 「上传」 in the content editor: the 素材库's own upload (MediaUploader → MediaEditor: crop/compress, name, category,
 * tags) into the caller's personal media (scope mine). The API only lets a content use its owner's private media, so
 * the editor passes `blocked` (with a hint) when the content belongs to someone else. Uploaded assets are emitted in
 * order, still `processing`.
 */
defineProps<{ disabled?: boolean; blocked?: string }>()
const emit = defineEmits<{ uploaded: [items: ContentMedia[]] }>()
const { t } = useI18n()

const open = ref(false)
const limits = ref<MediaLimits | null>(null)
const categories = ref<MediaCategory[]>([])
const tagOptions = ref<string[]>([])

async function loadCategories() {
  try { categories.value = (await api<{ categories: MediaCategory[] }>('GET', '/api/media/categories?scope=mine')).categories }
  catch (e) { message.error(errorText(e)) }
}
async function show() {
  open.value = true
  await Promise.all([
    limits.value ? null : api<MediaLimits>('GET', '/api/media/limits').then((l) => { limits.value = l }).catch(() => undefined), // validated server-side anyway
    loadCategories(),
    api<{ tags: string[] }>('GET', '/api/media/tags?scope=mine').then((r) => { tagOptions.value = r.tags }).catch(() => { tagOptions.value = [] }),
  ])
}
function onUploaded(items: MediaItem[]) { emit('uploaded', items.map(toContentMedia)) }
</script>

<template>
  <a-tooltip :title="blocked || undefined">
    <a-button :disabled="disabled || Boolean(blocked)" @click="show"><template #icon><CloudUploadOutlined /></template>{{ t('content.uploadMedia') }}</a-button>
  </a-tooltip>
  <MediaUploader
    v-model:open="open" scope="mine" :scope-label="t('media.tabs.mine')" :limits="limits" :categories="categories"
    :tag-options="tagOptions" @uploaded="onUploaded" @categories-changed="loadCategories"
  />
</template>
