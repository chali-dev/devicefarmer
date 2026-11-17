<script setup lang="ts">
import { dateLocale } from '../i18n'
import { message, Modal } from 'ant-design-vue'
import { PlusOutlined } from '@ant-design/icons-vue'
import { computed, onMounted, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'
import { queryParam } from '../api/query'
import { api, errorText } from '../api/client'
import type { CommentTemplate, TemplateKind } from '../api/types'
import { useAuthStore } from '../stores/auth'

/**
 * 话术库: reply templates (kind comment, also used by the comment reply composer) and post/caption templates
 * (kind post, inserted in the content editor), grouped by persona. Private or admin-shared; a person always edits
 * the text after inserting it.
 */
const { t } = useI18n()
const auth = useAuthStore()

const items = ref<CommentTemplate[]>([])
const loading = ref(false)
const facets = ref<{ personas: string[]; tags: string[] }>({ personas: [], tags: [] })
const filters = reactive({
  kind: (queryParam<TemplateKind>(useRoute().query, 'kind', ['comment', 'post']) ?? 'all') as TemplateKind | 'all',
  persona: undefined as string | undefined, tag: undefined as string | undefined, scope: undefined as 'own' | 'shared' | undefined, q: '',
})

async function load() {
  loading.value = true
  try {
    const p = new URLSearchParams({ kind: filters.kind })
    for (const k of ['persona', 'tag', 'scope'] as const) if (filters[k]) p.set(k, filters[k]!)
    if (filters.q.trim()) p.set('q', filters.q.trim())
    items.value = (await api<{ templates: CommentTemplate[] }>('GET', `/api/comment-templates?${p}`)).templates
  } catch (e) { message.error(errorText(e)) } finally { loading.value = false }
}
async function loadFacets() {
  try { facets.value = await api('GET', `/api/comment-templates/facets?kind=${filters.kind}`) } catch { /* suggestions only */ }
}
function onKind() { filters.persona = undefined; filters.tag = undefined; void load(); void loadFacets() }
function reset() { Object.assign(filters, { kind: 'all', persona: undefined, tag: undefined, scope: undefined, q: '' }); onKind() }
onMounted(() => { void load(); void loadFacets() })

const columns = computed(() => [
  { title: t('scripts.name'), key: 'name', width: 220 },
  { title: t('scripts.kind'), key: 'kind', width: 110 },
  { title: t('scripts.persona'), key: 'persona', width: 140 },
  { title: t('scripts.text'), key: 'text' },
  { title: t('scripts.scope'), key: 'scope', width: 120 },
  { title: t('scripts.updated'), key: 'updated', width: 170 },
  { title: t('common.action'), key: 'action', width: 230 },
])

// ---- create / edit
const open = ref(false)
const saving = ref(false)
const form = reactive({ id: null as string | null, kind: 'post' as TemplateKind, name: '', persona: '', tags: [] as string[], text: '', shared: false })
function openForm(x?: CommentTemplate) {
  Object.assign(form, x
    ? { id: x.id, kind: x.kind, name: x.name, persona: x.persona ?? '', tags: [...x.tags], text: x.text, shared: x.shared }
    : { id: null, kind: filters.kind === 'all' ? 'post' : filters.kind, name: '', persona: filters.persona && filters.persona !== 'none' ? filters.persona : '', tags: [], text: '', shared: false })
  open.value = true
}
async function save() {
  if (!form.name.trim() || !form.text.trim()) { message.warning(t('scripts.required')); return }
  saving.value = true
  try {
    const body = { kind: form.kind, name: form.name, persona: form.persona.trim() || null, tags: form.tags, text: form.text }
    if (form.id) await api('PUT', `/api/comment-templates/${form.id}`, body)
    else await api('POST', '/api/comment-templates', { ...body, shared: form.shared })
    message.success(t('common.saved'))
    open.value = false
    void load(); void loadFacets()
  } catch (e) { message.error(errorText(e)) } finally { saving.value = false }
}
/** "Save as mine": a private copy the user can edit (e.g. of a shared template). */
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
  Modal.confirm({
    title: t('scripts.deleteConfirm', { name: x.name }), okType: 'danger', okText: t('common.delete'), cancelText: t('common.cancel'),
    onOk: async () => { try { await api('DELETE', `/api/comment-templates/${x.id}`); message.success(t('common.deleted')); void load(); void loadFacets() } catch (e) { message.error(errorText(e)) } },
  })
}
</script>

<template>
  <a-card :title="t('scripts.title')" size="small">
    <template #extra>
      <a-button type="primary" @click="openForm()"><PlusOutlined /> {{ t('scripts.add') }}</a-button>
    </template>

    <a-space wrap style="margin-bottom: 12px">
      <a-radio-group v-model:value="filters.kind" button-style="solid" @change="onKind">
        <a-radio-button value="all">{{ t('scripts.allKinds') }}</a-radio-button>
        <a-radio-button value="post">{{ t('scripts.kinds.post') }}</a-radio-button>
        <a-radio-button value="comment">{{ t('scripts.kinds.comment') }}</a-radio-button>
      </a-radio-group>
      <a-input-search v-model:value="filters.q" :placeholder="t('scripts.searchPlaceholder')" allow-clear style="width: 200px" @search="load" />
      <a-select v-model:value="filters.persona" :placeholder="t('scripts.persona')" allow-clear show-search style="width: 150px" @change="load">
        <a-select-option value="none">{{ t('scripts.noPersona') }}</a-select-option>
        <a-select-option v-for="p in facets.personas" :key="p" :value="p">{{ p }}</a-select-option>
      </a-select>
      <a-select v-model:value="filters.tag" :placeholder="t('scripts.tags')" allow-clear show-search style="width: 130px"
        :options="facets.tags.map((x) => ({ value: x, label: x }))" @change="load" />
      <a-select v-model:value="filters.scope" :placeholder="t('scripts.scope')" allow-clear style="width: 110px" @change="load">
        <a-select-option value="own">{{ t('scripts.scopeOwn') }}</a-select-option>
        <a-select-option value="shared">{{ t('scripts.scopeShared') }}</a-select-option>
      </a-select>
      <a-button @click="reset">{{ t('common.reset') }}</a-button>
      <span class="muted">{{ t('scripts.total', { n: items.length }) }}</span>
    </a-space>

    <a-table :data-source="items" :columns="columns" row-key="id" size="small" :loading="loading" :scroll="{ x: 1100 }" :pagination="{ pageSize: 50, hideOnSinglePage: true, size: 'small' }">
      <template #bodyCell="{ column, record }">
        <template v-if="column.key === 'name'">
          <div>{{ record.name }}</div>
          <a-tag v-for="tg in record.tags" :key="tg" class="small-tag">{{ tg }}</a-tag>
        </template>
        <template v-else-if="column.key === 'kind'"><a-tag :color="record.kind === 'post' ? 'blue' : 'purple'">{{ t(`scripts.kinds.${record.kind}`) }}</a-tag></template>
        <template v-else-if="column.key === 'persona'">{{ record.persona ?? '—' }}</template>
        <template v-else-if="column.key === 'text'"><div class="pre clamp">{{ record.text }}</div></template>
        <template v-else-if="column.key === 'scope'">
          <a-tag v-if="record.shared" color="green">{{ t('scripts.scopeShared') }}</a-tag>
          <span v-else>{{ record.userId === auth.user?.id ? t('scripts.scopeOwn') : record.ownerName ?? '—' }}</span>
        </template>
        <template v-else-if="column.key === 'updated'">{{ new Date(record.updatedAt).toLocaleString(dateLocale()) }}</template>
        <template v-else-if="column.key === 'action'">
          <a-space size="small" wrap>
            <a @click="copyText(record as CommentTemplate)">{{ t('scripts.copy') }}</a>
            <a v-if="record.userId !== auth.user?.id" @click="duplicate(record as CommentTemplate)">{{ t('scripts.duplicate') }}</a>
            <template v-if="record.writable">
              <a @click="openForm(record as CommentTemplate)">{{ t('common.edit') }}</a>
              <a class="danger" @click="remove(record as CommentTemplate)">{{ t('common.delete') }}</a>
            </template>
          </a-space>
        </template>
      </template>
    </a-table>
    <div class="muted small" style="margin-top: 8px">{{ t('scripts.hint') }}</div>
  </a-card>

  <a-modal v-model:open="open" :title="form.id ? t('scripts.edit') : t('scripts.add')" :ok-text="t('common.save')" :cancel-text="t('common.cancel')" :confirm-loading="saving" :width="640" @ok="save">
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
          <a-form-item :label="t('scripts.persona')" :extra="t('scripts.personaHint')">
            <a-auto-complete v-model:value="form.persona" :options="facets.personas.map((p) => ({ value: p }))" :maxlength="50" allow-clear />
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
      <a-form-item v-if="auth.isAdmin && !form.id" :extra="t('scripts.sharedHint')">
        <a-checkbox v-model:checked="form.shared">{{ t('scripts.shared') }}</a-checkbox>
      </a-form-item>
    </a-form>
  </a-modal>
</template>

<style scoped>
.muted { color: var(--cp-text-tertiary); }
.small { font-size: 12px; }
.small-tag { font-size: 11px; margin-top: 2px; }
.danger { color: var(--cp-error); }
.pre { white-space: pre-wrap; word-break: break-word; }
.clamp { display: -webkit-box; -webkit-line-clamp: 3; line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
</style>
