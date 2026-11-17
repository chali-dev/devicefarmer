<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { message } from 'ant-design-vue'
import { ArrowDownOutlined, ArrowUpOutlined, CheckOutlined, CloseOutlined, DeleteOutlined, EditOutlined, MergeCellsOutlined, PlusOutlined } from '@ant-design/icons-vue'
import { useI18n } from 'vue-i18n'
import { api, errorText } from '../../api/client'
import type { Persona } from '../../api/types'
import { useAuthStore } from '../../stores/auth'
import { confirmDanger, MODAL_WIDTH } from '../common/ui'

/**
 * 人设管理 (same pattern as the media CategoryManager): public personas (admins edit, users read) and personal ones
 * (own; admins may also list every user's). Add / edit name + description / reorder / merge / delete.
 */
const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ changed: [] }>()
const { t } = useI18n()
const auth = useAuthStore()

const tab = ref<'public' | 'mine'>('public')
const owner = ref<'own' | 'all-users'>('own')
const publicList = ref<Persona[]>([])
const personalList = ref<Persona[]>([])
const loading = ref(false)
const busy = ref(false)
const draft = ref({ name: '', description: '' })
const editingId = ref<string | null>(null)
const edit = ref({ name: '', description: '' })

const allUsers = computed(() => tab.value === 'mine' && auth.isAdmin && owner.value === 'all-users')
const list = computed(() => (tab.value === 'public' ? publicList.value : personalList.value))
const canEdit = computed(() => tab.value === 'mine' || auth.isAdmin)

async function load() {
  loading.value = true
  try {
    const get = (q: string) => api<{ personas: Persona[] }>('GET', `/api/personas?${q}`).then((r) => r.personas)
    ;[publicList.value, personalList.value] = await Promise.all([get('scope=public'), get(allUsers.value ? 'scope=all-users' : 'scope=mine')])
  } catch (e) { message.error(errorText(e)) } finally { loading.value = false }
}
watch(open, (v) => { if (v) { draft.value = { name: '', description: '' }; editingId.value = null; void load() } })
watch(owner, () => { void load() })
watch(tab, () => { editingId.value = null })

async function run(fn: () => Promise<unknown>) {
  busy.value = true
  try { await fn(); emit('changed'); await load() } catch (e) { message.error(errorText(e)) } finally { busy.value = false }
}

function add() {
  const name = draft.value.name.trim()
  if (!name) return
  void run(async () => {
    await api('POST', '/api/personas', { scope: tab.value, name, description: draft.value.description.trim() || null })
    draft.value = { name: '', description: '' }
  })
}
function startEdit(p: Persona) { editingId.value = p.id; edit.value = { name: p.name, description: p.description ?? '' } }
function saveEdit(p: Persona) {
  const name = edit.value.name.trim()
  const description = edit.value.description.trim() || null
  if (!name || (name === p.name && description === p.description)) { editingId.value = null; return }
  void run(async () => { await api('PATCH', `/api/personas/${p.id}`, { name, description }); editingId.value = null })
}
/** Swap with the neighbour, then renumber 0..n-1 (only changed rows are written). */
function move(i: number, d: -1 | 1) {
  const j = i + d
  if (j < 0 || j >= list.value.length) return
  const next = [...list.value]
  ;[next[i], next[j]] = [next[j]!, next[i]!]
  void run(async () => {
    for (const [idx, p] of next.entries()) if (p.sort !== idx) await api('PATCH', `/api/personas/${p.id}`, { sort: idx })
  })
}
function remove(p: Persona) {
  confirmDanger({
    title: t('scripts.personas.confirmDelete', { name: p.name }), content: p.count ? t('scripts.personas.deleteContent', { n: p.count }) : undefined,
    onOk: () => run(() => api('DELETE', `/api/personas/${p.id}`)),
  })
}

// ---- merge: public → public; personal → the same owner's or a public persona
const merging = ref<Persona | null>(null)
const mergeInto = ref<string | undefined>()
const mergeTargets = computed(() => {
  const src = merging.value
  if (!src) return []
  const own = src.ownerType === 'user' ? personalList.value.filter((p) => p.ownerId === src.ownerId) : []
  return [...own, ...publicList.value].filter((p) => p.id !== src.id)
    .map((p) => ({ value: p.id, label: p.ownerType === 'public' && src.ownerType === 'user' ? `${p.name} · ${t('scripts.public')}` : p.name }))
})
function startMerge(p: Persona) { merging.value = p; mergeInto.value = undefined }
async function doMerge() {
  const src = merging.value
  if (!src || !mergeInto.value) return
  await run(async () => {
    const r = await api<{ moved: number }>('POST', `/api/personas/${src.id}/merge`, { into: mergeInto.value })
    message.success(t('scripts.personas.mergeOk', { n: r.moved }))
    merging.value = null
  })
}
</script>

<template>
  <a-modal v-model:open="open" :title="t('scripts.personas.manage')" :footer="null" :width="MODAL_WIDTH.md">
    <a-tabs v-model:active-key="tab" size="small">
      <a-tab-pane key="public" :tab="t('scripts.personas.tabs.public')" />
      <a-tab-pane key="mine" :tab="t('scripts.personas.tabs.mine')" />
      <template v-if="tab === 'mine' && auth.isAdmin" #rightExtra>
        <a-select v-model:value="owner" size="small" style="width: 120px"
          :options="[{ value: 'own', label: t('scripts.ownerOwn') }, { value: 'all-users', label: t('scripts.ownerAll') }]" />
      </template>
    </a-tabs>
    <div v-if="canEdit && !allUsers" class="add">
      <a-input v-model:value="draft.name" :maxlength="50" :placeholder="t('scripts.personas.namePlaceholder')" class="name" @press-enter="add" />
      <a-input v-model:value="draft.description" :maxlength="200" :placeholder="t('scripts.personas.descPlaceholder')" class="grow" @press-enter="add" />
      <a-button type="primary" :loading="busy" :disabled="!draft.name.trim()" @click="add"><template #icon><PlusOutlined /></template>{{ t('scripts.personas.add') }}</a-button>
    </div>
    <a-spin :spinning="loading">
      <a-empty v-if="!list.length && !loading" :description="t('scripts.personas.empty')" />
      <div v-for="(p, i) in list" :key="p.id" class="row">
        <template v-if="editingId === p.id">
          <a-input v-model:value="edit.name" size="small" :maxlength="50" class="name" @press-enter="saveEdit(p)" />
          <a-input v-model:value="edit.description" size="small" :maxlength="200" :placeholder="t('scripts.personas.descPlaceholder')" class="grow" @press-enter="saveEdit(p)" />
          <a-button type="text" size="small" :aria-label="t('common.save')" @click="saveEdit(p)"><CheckOutlined /></a-button>
          <a-button type="text" size="small" :aria-label="t('common.cancel')" @click="editingId = null"><CloseOutlined /></a-button>
        </template>
        <template v-else>
          <div class="grow">
            <div class="ellipsis">
              {{ p.name }}
              <span class="muted small count">{{ t('scripts.personas.count', { n: p.count }) }}</span>
              <span v-if="allUsers && p.ownerName" class="muted small count">· {{ p.ownerName }}</span>
            </div>
            <div v-if="p.description" class="muted small ellipsis">{{ p.description }}</div>
          </div>
          <template v-if="p.writable">
            <template v-if="!allUsers">
              <a-tooltip :title="t('scripts.personas.moveUp')"><a-button type="text" size="small" :disabled="i === 0 || busy" @click="move(i, -1)"><ArrowUpOutlined /></a-button></a-tooltip>
              <a-tooltip :title="t('scripts.personas.moveDown')"><a-button type="text" size="small" :disabled="i === list.length - 1 || busy" @click="move(i, 1)"><ArrowDownOutlined /></a-button></a-tooltip>
            </template>
            <a-tooltip :title="t('common.edit')"><a-button type="text" size="small" @click="startEdit(p)"><EditOutlined /></a-button></a-tooltip>
            <a-tooltip :title="t('scripts.personas.merge')"><a-button type="text" size="small" @click="startMerge(p)"><MergeCellsOutlined /></a-button></a-tooltip>
            <a-tooltip :title="t('common.delete')"><a-button type="text" size="small" danger @click="remove(p)"><DeleteOutlined /></a-button></a-tooltip>
          </template>
        </template>
      </div>
    </a-spin>
  </a-modal>

  <a-modal :open="!!merging" :title="merging ? t('scripts.personas.mergeTitle', { name: merging.name }) : ''" :width="MODAL_WIDTH.sm"
    :ok-text="t('scripts.personas.merge')" :cancel-text="t('common.cancel')" :ok-button-props="{ disabled: !mergeInto }" :confirm-loading="busy"
    @ok="doMerge" @cancel="merging = null">
    <a-select v-model:value="mergeInto" show-search option-filter-prop="label" style="width: 100%" :options="mergeTargets" />
  </a-modal>
</template>

<style scoped>
.add { display: flex; gap: 8px; margin-bottom: 12px; flex-wrap: wrap; }
.row { display: flex; align-items: center; gap: 4px; padding: 6px 0; border-bottom: 1px solid var(--cp-border-secondary); }
.name { width: 180px; max-width: 100%; }
.grow { flex: 1; min-width: 0; }
.add .grow { min-width: 160px; }
.count { margin-left: 6px; }
</style>
