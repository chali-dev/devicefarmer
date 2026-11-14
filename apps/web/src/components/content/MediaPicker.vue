<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
import { message } from 'ant-design-vue'
import { CheckCircleFilled, PictureOutlined, PlayCircleFilled } from '@ant-design/icons-vue'
import { useI18n } from 'vue-i18n'
import { api, errorText } from '../../api/client'
import type { ContentMedia, MediaItem } from '../../api/types'
import { fmtDuration, useThumbs } from '../media/media'

/** Picks ready assets from the media library (my media / public / favorites) for a content. */
const props = defineProps<{ open: boolean; exclude: string[] }>()
const emit = defineEmits<{ 'update:open': [boolean]; pick: [ContentMedia[]] }>()
const { t } = useI18n()

type Scope = 'mine' | 'public' | 'favorites'
const scope = ref<Scope>('mine')
const q = ref('')
const type = ref<'' | 'image' | 'video'>('')
const page = ref(1)
const items = ref<MediaItem[]>([])
const total = ref(0)
const loading = ref(false)
const picked = ref<Map<string, MediaItem>>(new Map())
let thumbs = useThumbs()

async function load() {
  loading.value = true
  try {
    const p = new URLSearchParams({ scope: scope.value, page: String(page.value), pageSize: '24', status: 'ready' })
    if (q.value.trim()) p.set('q', q.value.trim())
    if (type.value) p.set('type', type.value)
    const r = await api<{ items: MediaItem[]; total: number }>('GET', `/api/media?${p}`)
    items.value = r.items
    total.value = r.total
    void thumbs.load(r.items)
  } catch (e) { message.error(errorText(e)) } finally { loading.value = false }
}

watch(() => props.open, (o) => {
  if (!o) return
  picked.value = new Map()
  page.value = 1
  thumbs.dispose(); thumbs = useThumbs()
  void load()
})
watch([scope, type], () => { page.value = 1; void load() })
onBeforeUnmount(() => thumbs.dispose())

function toggle(m: MediaItem) {
  if (props.exclude.includes(m.id)) return
  const next = new Map(picked.value)
  if (next.has(m.id)) next.delete(m.id)
  else next.set(m.id, m)
  picked.value = next
}

function ok() {
  emit('pick', [...picked.value.values()].map((m) => ({
    id: m.id, name: m.name, fileType: m.fileType, status: m.status, ownerType: m.ownerType, width: m.width, height: m.height, duration: m.duration, thumbnailUrl: m.thumbnailUrl,
  })))
  emit('update:open', false)
}
</script>

<template>
  <a-modal :open="open" :title="t('content.picker.title')" width="820px" :ok-text="t('content.picker.add', { n: picked.size })" :ok-button-props="{ disabled: !picked.size }"
    :cancel-text="t('common.cancel')" @ok="ok" @cancel="emit('update:open', false)">
    <a-space wrap style="margin-bottom: 12px">
      <a-radio-group v-model:value="scope" button-style="solid" size="small">
        <a-radio-button value="mine">{{ t('media.tabs.mine') }}</a-radio-button>
        <a-radio-button value="public">{{ t('media.tabs.public') }}</a-radio-button>
        <a-radio-button value="favorites">{{ t('media.tabs.favorites') }}</a-radio-button>
      </a-radio-group>
      <a-select v-model:value="type" size="small" style="width: 110px">
        <a-select-option value="">{{ t('common.all') }}</a-select-option>
        <a-select-option value="image">{{ t('media.image') }}</a-select-option>
        <a-select-option value="video">{{ t('media.video') }}</a-select-option>
      </a-select>
      <a-input-search v-model:value="q" size="small" allow-clear :placeholder="t('media.searchPlaceholder')" style="width: 200px" @search="page = 1; load()" />
      <span class="hint">{{ t('content.picker.readyOnly') }}</span>
    </a-space>
    <a-spin :spinning="loading">
      <a-empty v-if="!items.length" />
      <div class="grid">
        <div v-for="m in items" :key="m.id" class="tile" :class="{ on: picked.has(m.id), off: exclude.includes(m.id) }" :title="m.name" role="button" tabindex="0"
          @click="toggle(m)" @keydown.enter.prevent="toggle(m)">
          <div class="img">
            <img v-if="thumbs.get(m)" :src="thumbs.get(m)" :alt="m.name" />
            <PictureOutlined v-else class="ph" />
            <span v-if="m.fileType === 'video'" class="badge"><PlayCircleFilled /> {{ fmtDuration(m.duration) }}</span>
            <CheckCircleFilled v-if="picked.has(m.id)" class="check" />
          </div>
          <div class="name">{{ m.name }}</div>
          <div v-if="exclude.includes(m.id)" class="hint">{{ t('content.picker.already') }}</div>
        </div>
      </div>
      <a-pagination v-if="total > 24" v-model:current="page" :total="total" :page-size="24" size="small" style="margin-top: 12px; text-align: right" @change="load" />
    </a-spin>
  </a-modal>
</template>

<style scoped>
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 10px; }
.tile { cursor: pointer; border: 1px solid var(--cp-border-secondary); border-radius: 6px; padding: 4px; }
.tile.on { border-color: var(--cp-primary); box-shadow: 0 0 0 1px var(--cp-primary); }
.tile.off { opacity: 0.5; cursor: default; }
.img { position: relative; height: 90px; background: var(--cp-fill-alter); display: flex; align-items: center; justify-content: center; border-radius: 4px; overflow: hidden; }
.img img { width: 100%; height: 100%; object-fit: cover; }
.ph { font-size: 28px; color: var(--cp-text-quaternary); }
.badge { position: absolute; left: 4px; bottom: 4px; font-size: 11px; padding: 0 4px; border-radius: 3px; background: rgba(0, 0, 0, 0.6); color: #fff; }
.check { position: absolute; top: 4px; right: 4px; font-size: 18px; color: var(--cp-primary); background: var(--cp-bg-container); border-radius: 50%; }
.name { font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 4px; }
.hint { color: var(--cp-text-tertiary); font-size: 12px; }
</style>
