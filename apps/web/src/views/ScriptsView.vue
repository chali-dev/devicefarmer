<script setup lang="ts">
import { dateLocale } from '../i18n'
import { message } from 'ant-design-vue'
import { PlusOutlined } from '@ant-design/icons-vue'
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { queryParam } from '../api/query'
import { api, errorText } from '../api/client'
import type { CommentTemplate, TemplateKind } from '../api/types'
import PageContainer from '../components/common/PageContainer.vue'
import SearchBar from '../components/common/SearchBar.vue'
import { actionColumn, confirmDanger, MODAL_WIDTH, pagination, TABLE_SIZE } from '../components/common/ui'
import { useAuthStore } from '../stores/auth'

/**
 * 话术库: reply templates (kind comment, also used by the comment reply composer) and post/caption templates
 * (kind post, inserted in the content editor), grouped by persona. Tabs like the media library: 公共话术
 * (admin-shared, API scope=shared, managed by admins only) and 个人话术 (private, scope=own; admins may also list
 * every user's with scope=all-users). A person always edits the text after inserting it.
 */
const { t } = useI18n()
const auth = useAuthStore()
const route = useRoute()
const router = useRouter()

type Tab = 'public' | 'mine'
const TABS: Tab[] = ['public', 'mine']
const tab = computed<Tab>({
  get: () => queryParam<Tab>(route.query, 'tab', TABS) ?? 'public',
  set: (v) => { void router.replace({ query: { ...route.query, tab: v } }) },
})
/** Admin, personal tab: own templates or every user's personal templates. */
const owner = ref<'own' | 'all-users'>('own')
const apiScope = computed(() => (tab.value === 'public' ? 'shared' : auth.isAdmin ? owner.value : 'own'))
const canCreate = computed(() => tab.value === 'mine' || auth.isAdmin)

const items = ref<CommentTemplate[]>([])
const loading = ref(false)
const facets = ref<{ personas: string[]; tags: string[] }>({ personas: [], tags: [] })
const filters = reactive({
  kind: (queryParam<TemplateKind>(route.query, 'kind', ['comment', 'post']) ?? 'all') as TemplateKind | 'all',
  persona: undefined as string | undefined, tag: undefined as string | undefined, q: '',
})

async function load() {
  loading.value = true
  try {
    const p = new URLSearchParams({ kind: filters.kind, scope: apiScope.value })
    for (const k of ['persona', 'tag'] as const) if (filters[k]) p.set(k, filters[k]!)
    if (filters.q.trim()) p.set('q', filters.q.trim())
    items.value = (await api<{ templates: CommentTemplate[] }>('GET', `/api/comment-templates?${p}`)).templates
  } catch (e) { message.error(errorText(e)) } finally { loading.value = false }
}
async function loadFacets() {
  try { facets.value = await api('GET', `/api/comment-templates/facets?kind=${filters.kind}&scope=${apiScope.value}`) } catch { /* suggestions only */ }
}
function onKind() { filters.persona = undefined; filters.tag = undefined; void load(); void loadFacets() }
function reset() { Object.assign(filters, { kind: 'all', persona: undefined, tag: undefined, q: '' }); owner.value = 'own'; onKind() }
onMounted(() => { void load(); void loadFacets() })
watch(apiScope, onKind)

const columns = computed(() => [
  { title: t('scripts.name'), key: 'name', width: 220 },
  { title: t('scripts.kind'), key: 'kind', width: 110 },
  { title: t('scripts.persona'), key: 'persona', width: 140 },
  { title: t('scripts.text'), key: 'text', width: 360 },
  ...(apiScope.value === 'all-users' ? [{ title: t('scripts.owner'), key: 'owner', width: 120 }] : []),
  { title: t('scripts.updated'), key: 'updated', width: 170 },
  actionColumn(200),
])
const scrollX = computed(() => columns.value.reduce((n, c) => n + (c.width ?? 0), 0))
const isOwn = (x: CommentTemplate) => x.userId === auth.user?.id

// ---- create / edit
const open = ref(false)
const saving = ref(false)
const form = reactive({ id: null as string | null, kind: 'post' as TemplateKind, name: '', persona: '', tags: [] as string[], text: '', shared: false })
function openForm(x?: CommentTemplate) {
  Object.assign(form, x
    ? { id: x.id, kind: x.kind, name: x.name, persona: x.persona ?? '', tags: [...x.tags], text: x.text, shared: x.shared }
    : { id: null, kind: filters.kind === 'all' ? 'post' : filters.kind, name: '', persona: filters.persona && filters.persona !== 'none' ? filters.persona : '', tags: [], text: '', shared: auth.isAdmin && tab.value === 'public' })
  open.value = true
}
async function save() {
  if (!form.name.trim() || !form.text.trim()) { message.warning(t('scripts.required')); return }
  saving.value = true
  try {
    const body = { kind: form.kind, name: form.name, persona: form.persona.trim() || null, tags: form.tags, text: form.text }
    if (form.id) await api('PUT', `/api/comment-templates/${form.id}`, body)
    else await api('POST', '/api/comment-templates', { ...body, shared: auth.isAdmin && form.shared })
    message.success(t('common.saved'))
    open.value = false
    const target: Tab = form.shared ? 'public' : 'mine'
    if (!form.id && target !== tab.value) tab.value = target // the list follows via the scope watcher
    else { void load(); void loadFacets() }
  } catch (e) { message.error(errorText(e)) } finally { saving.value = false }
}
/** "Save as personal": a private copy the user can edit (e.g. of a public template). */
async function duplicate(x: CommentTemplate) {
  try {
    await api('POST', '/api/comment-templates', { kind: x.kind, name: `${x.name}${t('scripts.copySuffix')}`.slice(0, 100), persona: x.persona, tags: x.tags, text: x.text })
    message.success(t('scripts.duplicated'))
    void load()
  } catch (e) { message.error(errorText(e)) }
}
async function copyText(x: CommentTemplate) {
  try { await navigator.clipboard.writeText(x.text); message.success(t('scripts.copied')) } catch (e) { message.error(errorText(e)) }
}
function remove(x: CommentTemplate) {
  confirmDanger({
    title: t('scripts.deleteConfirm', { name: x.name }),
    onOk: async () => { try { await api('DELETE', `/api/comment-templates/${x.id}`); message.success(t('common.deleted')); void load(); void loadFacets() } catch (e) { message.error(errorText(e)) } },
  })
}
</script>

<template>
  <PageContainer :title="t('scripts.title')">
    <template #extra>
      <a-button v-if="canCreate" type="primary" @click="openForm()"><template #icon><PlusOutlined /></template>{{ t('scripts.add') }}</a-button>
    </template>

    <a-card :bordered="false" class="tabs-card">
      <a-tabs v-model:active-key="tab">
        <a-tab-pane v-for="k in TABS" :key="k" :tab="t(`scripts.tabs.${k}`)" />
      </a-tabs>
      <SearchBar @reset="reset">
        <a-radio-group v-model:value="filters.kind" button-style="solid" @change="onKind">
          <a-radio-button value="all">{{ t('scripts.allKinds') }}</a-radio-button>
          <a-radio-button value="post">{{ t('scripts.kinds.post') }}</a-radio-button>
          <a-radio-button value="comment">{{ t('scripts.kinds.comment') }}</a-radio-button>
        </a-radio-group>
        <a-input-search v-model:value="filters.q" :placeholder="t('scripts.searchPlaceholder')" allow-clear style="width: 240px" @search="load" />
        <a-select v-model:value="filters.persona" :placeholder="t('scripts.persona')" allow-clear show-search style="width: 150px" @change="load">
          <a-select-option value="none">{{ t('scripts.noPersona') }}</a-select-option>
          <a-select-option v-for="p in facets.personas" :key="p" :value="p">{{ p }}</a-select-option>
        </a-select>
        <a-select v-model:value="filters.tag" :placeholder="t('scripts.tags')" allow-clear show-search style="width: 130px"
          :options="facets.tags.map((x) => ({ value: x, label: x }))" @change="load" />
        <a-select v-if="tab === 'mine' && auth.isAdmin" v-model:value="owner" style="width: 130px"
          :options="[{ value: 'own', label: t('scripts.ownerOwn') }, { value: 'all-users', label: t('scripts.ownerAll') }]" />
      </SearchBar>

      <a-table :data-source="items" :columns="columns" row-key="id" :size="TABLE_SIZE" :loading="loading" :scroll="{ x: scrollX }" :pagination="pagination({ defaultPageSize: 50, totalText: (n) => t('scripts.total', { n }) })">
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'name'">
            <div>{{ record.name }}</div>
            <a-tag v-for="tg in record.tags" :key="tg" style="margin-top: 2px">{{ tg }}</a-tag>
          </template>
          <template v-else-if="column.key === 'kind'"><a-tag :color="record.kind === 'post' ? 'blue' : 'purple'">{{ t(`scripts.kinds.${record.kind}`) }}</a-tag></template>
          <template v-else-if="column.key === 'persona'">{{ record.persona ?? '—' }}</template>
          <template v-else-if="column.key === 'text'"><div class="pre clamp">{{ record.text }}</div></template>
          <template v-else-if="column.key === 'owner'">{{ isOwn(record as CommentTemplate) ? t('scripts.ownerOwn') : record.ownerName ?? '—' }}</template>
          <template v-else-if="column.key === 'updated'">{{ new Date(record.updatedAt).toLocaleString(dateLocale()) }}</template>
          <template v-else-if="column.key === 'ops'">
            <a-space :size="0">
              <a-button type="link" size="small" @click="copyText(record as CommentTemplate)">{{ t('scripts.copy') }}</a-button>
              <a-button v-if="record.writable" type="link" size="small" @click="openForm(record as CommentTemplate)">{{ t('common.edit') }}</a-button>
              <a-button v-else-if="!isOwn(record as CommentTemplate)" type="link" size="small" @click="duplicate(record as CommentTemplate)">{{ t('scripts.duplicate') }}</a-button>
              <a-button v-if="record.writable && isOwn(record as CommentTemplate)" type="link" size="small" danger @click="remove(record as CommentTemplate)">{{ t('common.delete') }}</a-button>
              <a-dropdown v-else-if="record.writable">
                <a-button type="link" size="small">{{ t('common.more') }}</a-button>
                <template #overlay>
                  <a-menu>
                    <a-menu-item key="duplicate" @click="duplicate(record as CommentTemplate)">{{ t('scripts.duplicate') }}</a-menu-item>
                    <a-menu-item key="delete" danger @click="remove(record as CommentTemplate)">{{ t('common.delete') }}</a-menu-item>
                  </a-menu>
                </template>
              </a-dropdown>
            </a-space>
          </template>
        </template>
      </a-table>
    </a-card>

    <a-modal v-model:open="open" :title="form.id ? t('scripts.edit') : t('scripts.add')" :ok-text="t('common.save')" :cancel-text="t('common.cancel')" :confirm-loading="saving" :width="MODAL_WIDTH.md" @ok="save">
      <a-form layout="vertical">
        <a-form-item :label="t('scripts.kind')">
          <a-radio-group v-model:value="form.kind">
            <a-radio-button value="post">{{ t('scripts.kinds.post') }}</a-radio-button>
            <a-radio-button value="comment">{{ t('scripts.kinds.comment') }}</a-radio-button>
          </a-radio-group>
        </a-form-item>
        <a-form-item :label="t('scripts.name')" required><a-input v-model:value="form.name" :maxlength="100" /></a-form-item>
        <a-row :gutter="12">
          <a-col :xs="24" :sm="12">
            <a-form-item :label="t('scripts.persona')">
              <a-auto-complete v-model:value="form.persona" :options="facets.personas.map((p) => ({ value: p }))" :maxlength="50" allow-clear :placeholder="t('scripts.personaPlaceholder')" />
            </a-form-item>
          </a-col>
          <a-col :xs="24" :sm="12">
            <a-form-item :label="t('scripts.tags')">
              <a-select v-model:value="form.tags" mode="tags" :options="facets.tags.map((x) => ({ value: x }))" :token-separators="[',']" />
            </a-form-item>
          </a-col>
        </a-row>
        <a-form-item :label="t('scripts.text')" required>
          <a-textarea v-model:value="form.text" :auto-size="{ minRows: 4, maxRows: 12 }" :maxlength="5000" show-count />
        </a-form-item>
        <a-form-item v-if="auth.isAdmin && !form.id" :label="t('scripts.visibility')" :extra="form.shared ? t('scripts.publicHint') : undefined">
          <a-radio-group v-model:value="form.shared">
            <a-radio :value="true">{{ t('scripts.tabs.public') }}</a-radio>
            <a-radio :value="false">{{ t('scripts.tabs.mine') }}</a-radio>
          </a-radio-group>
        </a-form-item>
      </a-form>
    </a-modal>
  </PageContainer>
</template>

<style scoped>
.tabs-card :deep(.ant-card-body) { padding-top: 4px; }
.tabs-card :deep(.ant-tabs-nav) { margin-bottom: var(--cp-gap); }
.pre { white-space: pre-wrap; word-break: break-word; }
.clamp { display: -webkit-box; -webkit-line-clamp: 3; line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
</style>
