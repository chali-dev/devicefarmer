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
 * tags) into the caller's personal media (scope mine). The API only lets a content use its owner's private media or
 * public media, so on someone else's content an admin uploads into THAT owner's personal media (`ownerId`, owner
 * 2026-11-18: 「上传应该先到个人的吧」; categories and tags are the owner's) and others get `blocked` (with a hint).
 * Uploaded assets are emitted in order, still `processing`.
 */
const props = defineProps<{ disabled?: boolean; blocked?: string; ownerId?: string; ownerName?: string | null }>()
const emit = defineEmits<{ uploaded: [items: ContentMedia[]] }>()
const { t } = useI18n()

const open = ref(false)
const limits = ref<MediaLimits | null>(null)
const categories = ref<MediaCategory[]>([])
const tagOptions = ref<string[]>([])

/** Another user's personal media (admin): `scope=mine&ownerId=` lists that user's categories, tags need all-users. */
const catQuery = () => (props.ownerId ? `scope=mine&ownerId=${props.ownerId}` : 'scope=mine')
const tagQuery = () => (props.ownerId ? `scope=all-users&ownerId=${props.ownerId}` : 'scope=mine')
async function loadCategories() {
  try { categories.value = (await api<{ categories: MediaCategory[] }>('GET', `/api/media/categories?${catQuery()}`)).categories }
  catch (e) { message.error(errorText(e)) }
}
async function show() {
  open.value = true
  await Promise.all([
    limits.value ? null : api<MediaLimits>('GET', '/api/media/limits').then((l) => { limits.value = l }).catch(() => undefined), // validated server-side anyway
    loadCategories(),
    api<{ tags: string[] }>('GET', `/api/media/tags?${tagQuery()}`).then((r) => { tagOptions.value = r.tags }).catch(() => { tagOptions.value = [] }),
  ])
}
function onUploaded(items: MediaItem[]) { emit('uploaded', items.map(toContentMedia)) }
</script>

<template>
  <a-tooltip :title="blocked || undefined">
    <a-button :disabled="disabled || Boolean(blocked)" @click="show"><template #icon><CloudUploadOutlined /></template>{{ t('content.uploadMedia') }}</a-button>
  </a-tooltip>
  <MediaUploader
    v-model:open="open" :scope="'mine'" :owner-id="ownerId" :scope-label="ownerId ? t('content.uploadOwnerLabel', { user: ownerName || '?' }) : t('media.tabs.mine')" :limits="limits" :categories="categories"
    :tag-options="tagOptions" @uploaded="onUploaded" @categories-changed="loadCategories"
  />
</template>
