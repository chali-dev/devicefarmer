<script setup lang="ts">
import { ref, watch } from 'vue'
import { ArrowDownOutlined, ArrowUpOutlined, CheckOutlined, CloseOutlined, DeleteOutlined, EditOutlined, MergeCellsOutlined, PlusOutlined } from '@ant-design/icons-vue'
import { useI18n } from 'vue-i18n'
import type { ScopedItem } from '../../api/types'
import { useAuthStore } from '../../stores/auth'
import { useScopedList } from './scopedList'
import { MODAL_WIDTH } from './ui'

/**
 * Dialog of a scoped name list (内容分类 `/api/content-categories`, 素材分类 `/api/media/categories`; 人设 has its own page
 * /personas on the same `useScopedList`): public rows (admins edit, users read) and personal ones (own; admins may also
 * list every user's). Add / edit name + description / reorder / merge / delete. `texts` is the i18n prefix of the list's
 * own labels (manage, tabs.*, add, count, …). `mergeIntoPublic: false` = a personal row merges only into the same
 * owner's rows (media categories). `initialTab` = tab shown when the dialog opens.
 */
const props = withDefaults(defineProps<{ path: string; listKey: string; texts: string; mergeIntoPublic?: boolean; initialTab?: 'public' | 'mine' }>(), {
  mergeIntoPublic: true, initialTab: undefined,
})
const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ changed: [] }>()
const { t } = useI18n()
const auth = useAuthStore()
const {
  tx, tab, owner, loading, busy, allUsers, list, canEdit, load, create, update, move, remove, merging, mergeInto, mergeTargets, startMerge, doMerge,
} = useScopedList({ path: props.path, listKey: props.listKey, texts: props.texts, mergeIntoPublic: props.mergeIntoPublic, onChanged: () => emit('changed') })

const draft = ref({ name: '', description: '' })
const editingId = ref<string | null>(null)
const edit = ref({ name: '', description: '' })

watch(open, (v) => {
  if (!v) return
  draft.value = { name: '', description: '' }
  editingId.value = null
  if (props.initialTab) tab.value = props.initialTab
  void load()
})
watch(owner, () => { void load() })
watch(tab, () => { editingId.value = null })

async function add() {
  const name = draft.value.name.trim()
  if (!name) return
  if (await create(name, draft.value.description.trim() || null)) draft.value = { name: '', description: '' }
}
function startEdit(p: ScopedItem) { editingId.value = p.id; edit.value = { name: p.name, description: p.description ?? '' } }
async function saveEdit(p: ScopedItem) {
  if (await update(p, edit.value.name.trim(), edit.value.description.trim() || null)) editingId.value = null
}
</script>

<template>
  <a-modal v-model:open="open" :title="tx('manage')" :footer="null" :width="MODAL_WIDTH.md">
    <a-tabs v-model:active-key="tab" size="small">
      <a-tab-pane key="public" :tab="tx('tabs.public')" />
      <a-tab-pane key="mine" :tab="tx('tabs.mine')" />
      <template v-if="tab === 'mine' && auth.isAdmin" #rightExtra>
        <a-select v-model:value="owner" size="small" style="width: 120px"
          :options="[{ value: 'own', label: t('scopedList.ownerOwn') }, { value: 'all-users', label: t('scopedList.ownerAll') }]" />
      </template>
    </a-tabs>
    <div v-if="canEdit && !allUsers" class="add">
      <a-input v-model:value="draft.name" :maxlength="50" :placeholder="tx('namePlaceholder')" class="name" @press-enter="add" />
      <a-input v-model:value="draft.description" :maxlength="200" :placeholder="tx('descPlaceholder')" class="grow" @press-enter="add" />
      <a-button type="primary" :loading="busy" :disabled="!draft.name.trim()" @click="add"><template #icon><PlusOutlined /></template>{{ tx('add') }}</a-button>
    </div>
    <a-spin :spinning="loading">
      <a-empty v-if="!list.length && !loading" :description="tx('empty')" />
      <div v-for="(p, i) in list" :key="p.id" class="row">
        <template v-if="editingId === p.id">
          <a-input v-model:value="edit.name" size="small" :maxlength="50" class="name" @press-enter="saveEdit(p)" />
          <a-input v-model:value="edit.description" size="small" :maxlength="200" :placeholder="tx('descPlaceholder')" class="grow" @press-enter="saveEdit(p)" />
          <a-button type="text" size="small" :aria-label="t('common.save')" @click="saveEdit(p)"><CheckOutlined /></a-button>
          <a-button type="text" size="small" :aria-label="t('common.cancel')" @click="editingId = null"><CloseOutlined /></a-button>
        </template>
        <template v-else>
          <div class="grow">
            <div class="ellipsis">
              {{ p.name }}
              <span class="muted small count">{{ tx('count', { n: p.count }) }}</span>
              <span v-if="allUsers && p.ownerName" class="muted small count">· {{ p.ownerName }}</span>
            </div>
            <div v-if="p.description" class="muted small ellipsis">{{ p.description }}</div>
          </div>
          <template v-if="p.writable">
            <template v-if="!allUsers">
              <a-tooltip :title="t('scopedList.moveUp')"><a-button type="text" size="small" :disabled="i === 0 || busy" @click="move(list, i, -1)"><ArrowUpOutlined /></a-button></a-tooltip>
              <a-tooltip :title="t('scopedList.moveDown')"><a-button type="text" size="small" :disabled="i === list.length - 1 || busy" @click="move(list, i, 1)"><ArrowDownOutlined /></a-button></a-tooltip>
            </template>
            <a-tooltip :title="t('common.edit')"><a-button type="text" size="small" @click="startEdit(p)"><EditOutlined /></a-button></a-tooltip>
            <a-tooltip :title="t('scopedList.merge')"><a-button type="text" size="small" @click="startMerge(p)"><MergeCellsOutlined /></a-button></a-tooltip>
            <a-tooltip :title="t('common.delete')"><a-button type="text" size="small" danger @click="remove(p)"><DeleteOutlined /></a-button></a-tooltip>
          </template>
        </template>
      </div>
    </a-spin>
  </a-modal>

  <a-modal :open="!!merging" :title="merging ? tx('mergeTitle', { name: merging.name }) : ''" :width="MODAL_WIDTH.sm"
    :ok-text="t('scopedList.merge')" :cancel-text="t('common.cancel')" :ok-button-props="{ disabled: !mergeInto }" :confirm-loading="busy"
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
