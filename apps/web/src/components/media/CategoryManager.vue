<script setup lang="ts">
import { ref, watch } from 'vue'
import { message, Modal } from 'ant-design-vue'
import { ArrowDownOutlined, ArrowUpOutlined, CheckOutlined, CloseOutlined, DeleteOutlined, EditOutlined, PlusOutlined } from '@ant-design/icons-vue'
import { useI18n } from 'vue-i18n'
import { api, errorText } from '../../api/client'
import type { MediaCategory } from '../../api/types'

/** Create / rename / reorder / delete the categories of one scope (public: admin; mine: own). */
const props = defineProps<{ scope: 'public' | 'mine'; scopeLabel: string }>()
const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ changed: [] }>()
const { t } = useI18n()

const list = ref<MediaCategory[]>([])
const loading = ref(false)
const busy = ref(false)
const newName = ref('')
const editingId = ref<string | null>(null)
const editName = ref('')

async function load() {
  loading.value = true
  try { list.value = (await api<{ categories: MediaCategory[] }>('GET', `/api/media/categories?scope=${props.scope}`)).categories }
  catch (e) { message.error(errorText(e)) }
  finally { loading.value = false }
}
watch(open, (v) => { if (v) { newName.value = ''; editingId.value = null; void load() } })

async function run(fn: () => Promise<unknown>) {
  busy.value = true
  try { await fn(); emit('changed'); await load() }
  catch (e) { message.error(errorText(e)) }
  finally { busy.value = false }
}

function add() {
  const name = newName.value.trim()
  if (!name) return
  void run(async () => { await api('POST', '/api/media/categories', { scope: props.scope, name }); newName.value = '' })
}
function startRename(c: MediaCategory) { editingId.value = c.id; editName.value = c.name }
function saveRename(c: MediaCategory) {
  const name = editName.value.trim()
  if (!name || name === c.name) { editingId.value = null; return }
  void run(async () => { await api('PUT', `/api/media/categories/${c.id}`, { name }); editingId.value = null })
}
/** Swap with the neighbour, then renumber 0..n-1 (only changed rows are written). */
function move(i: number, d: -1 | 1) {
  const j = i + d
  if (j < 0 || j >= list.value.length) return
  const next = [...list.value]
  ;[next[i], next[j]] = [next[j]!, next[i]!]
  void run(async () => {
    for (const [idx, c] of next.entries()) if (c.sort !== idx) await api('PUT', `/api/media/categories/${c.id}`, { sort: idx })
  })
}
function remove(c: MediaCategory) {
  Modal.confirm({
    title: t('media.categories.confirmDelete', { name: c.name }), content: t('media.categories.deleteContent'),
    okType: 'danger', okText: t('common.delete'), cancelText: t('common.cancel'),
    onOk: () => run(() => api('DELETE', `/api/media/categories/${c.id}`)),
  })
}
</script>

<template>
  <a-modal v-model:open="open" :title="t('media.categories.title', { scope: scopeLabel })" :footer="null" width="520px">
    <div class="add">
      <a-input v-model:value="newName" :maxlength="50" :placeholder="t('media.categories.namePlaceholder')" @press-enter="add" />
      <a-button type="primary" :loading="busy" :disabled="!newName.trim()" @click="add"><PlusOutlined /> {{ t('media.categories.add') }}</a-button>
    </div>
    <a-spin :spinning="loading">
      <a-empty v-if="!list.length && !loading" :description="t('media.categories.empty')" />
      <div v-for="(c, i) in list" :key="c.id" class="row">
        <template v-if="editingId === c.id">
          <a-input v-model:value="editName" size="small" :maxlength="50" class="grow" @press-enter="saveRename(c)" />
          <a-button type="text" size="small" @click="saveRename(c)"><CheckOutlined /></a-button>
          <a-button type="text" size="small" @click="editingId = null"><CloseOutlined /></a-button>
        </template>
        <template v-else>
          <span class="grow">{{ c.name }} <span class="hint">{{ t('media.categories.count', { n: c.count }) }}</span></span>
          <a-tooltip :title="t('media.categories.moveUp')"><a-button type="text" size="small" :disabled="i === 0 || busy" @click="move(i, -1)"><ArrowUpOutlined /></a-button></a-tooltip>
          <a-tooltip :title="t('media.categories.moveDown')"><a-button type="text" size="small" :disabled="i === list.length - 1 || busy" @click="move(i, 1)"><ArrowDownOutlined /></a-button></a-tooltip>
          <a-tooltip :title="t('media.categories.rename')"><a-button type="text" size="small" @click="startRename(c)"><EditOutlined /></a-button></a-tooltip>
          <a-tooltip :title="t('common.delete')"><a-button type="text" size="small" danger @click="remove(c)"><DeleteOutlined /></a-button></a-tooltip>
        </template>
      </div>
    </a-spin>
  </a-modal>
</template>

<style scoped>
.add { display: flex; gap: 8px; margin-bottom: 12px; }
.row { display: flex; align-items: center; gap: 4px; padding: 6px 0; border-bottom: 1px solid var(--cp-border-secondary); }
.grow { flex: 1; min-width: 0; }
.hint { color: var(--cp-text-tertiary); font-size: 12px; margin-left: 6px; }
</style>
