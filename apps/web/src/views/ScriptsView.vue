<script setup lang="ts">
import { dateLocale } from '../i18n'
import { message } from 'ant-design-vue'
import { PlusOutlined } from '@ant-design/icons-vue'
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { queryParam } from '../api/query'
import { api, errorText } from '../api/client'
import type { CommentTemplate, Persona, TemplateKind } from '../api/types'
import PageContainer from '../components/common/PageContainer.vue'
import PersonaManager from '../components/comments/PersonaManager.vue'
import VNodes from '../components/common/VNodes'
import SearchBar from '../components/common/SearchBar.vue'
import { actionColumn, confirmDanger, MODAL_WIDTH, pagination, TABLE_SIZE } from '../components/common/ui'
import { useAuthStore } from '../stores/auth'

/**
 * 话术库: reply templates (kind comment, also used by the comment reply composer) and post/caption templates
 * (kind post, inserted in the content editor), grouped by persona (人设, managed lists: public + personal). Tabs like
 * the media library: 公共话术 (admin-shared, API scope=shared, managed by admins only) and 个人话术 (private, scope=own;
 * admins may also list every user's with scope=all-users). A shared template only takes a public persona, a private one
 * a public persona or one of its owner's. A person always edits the text after inserting it.
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
const facets = ref<{ tags: string[] }>({ tags: [] })
const filters = reactive({
  kind: (queryParam<TemplateKind>(route.query, 'kind', ['comment', 'post']) ?? 'all') as TemplateKind | 'all',
  personaId: undefined as string | undefined, tag: undefined as string | undefined, q: '',
})

// ---- personas (人设): public ones + own (admin, all-users: every user's personal ones)
const publicPersonas = ref<Persona[]>([])
const personalPersonas = ref<Persona[]>([])
const getPersonas = (q: string) => api<{ personas: Persona[] }>('GET', `/api/personas?${q}`).then((r) => r.personas)
async function loadPersonas() {
  try { [publicPersonas.value, personalPersonas.value] = await Promise.all([getPersonas('scope=public'), getPersonas(apiScope.value === 'all-users' ? 'scope=all-users' : 'scope=mine')]) }
  catch (e) { message.error(errorText(e)) }
}
const myId = computed(() => auth.user?.id)
/** Select options grouped 公共人设 / 个人人设; the description is the option's tooltip. */
function personaGroups(pub: Persona[], own: Persona[]) {
  const opt = (p: Persona) => ({ value: p.id, label: p.ownerId && p.ownerId !== myId.value && p.ownerName ? `${p.name} · ${p.ownerName}` : p.name, title: p.description ?? undefined })
  return [
    ...(pub.length ? [{ label: t('scripts.personas.tabs.public'), options: pub.map(opt) }] : []),
    ...(own.length ? [{ label: t('scripts.personas.tabs.mine'), options: own.map(opt) }] : []),
  ]
}
const filterOptions = computed(() => [
  { value: 'none', label: t('scripts.noPersona') },
  ...personaGroups(publicPersonas.value, tab.value === 'public' ? [] : personalPersonas.value),
])
const managerOpen = ref(false)
function personasChanged() { void loadPersonas(); void load() }

async function load() {
  loading.value = true
  try {
    const p = new URLSearchParams({ kind: filters.kind, scope: apiScope.value })
    for (const k of ['personaId', 'tag'] as const) if (filters[k]) p.set(k, filters[k]!)
    if (filters.q.trim()) p.set('q', filters.q.trim())
    items.value = (await api<{ templates: CommentTemplate[] }>('GET', `/api/comment-templates?${p}`)).templates
  } catch (e) { message.error(errorText(e)) } finally { loading.value = false }
}
async function loadFacets() {
  try { facets.value = await api('GET', `/api/comment-templates/facets?kind=${filters.kind}&scope=${apiScope.value}`) } catch { /* suggestions only */ }
}
function onKind() { filters.tag = undefined; void load(); void loadFacets() }
function reset() { Object.assign(filters, { kind: 'all', personaId: undefined, tag: undefined, q: '' }); owner.value = 'own'; onKind() }
onMounted(() => { void load(); void loadFacets(); void loadPersonas() })
watch(apiScope, () => { filters.personaId = undefined; void loadPersonas(); onKind() })

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
const form = reactive({
  id: null as string | null, kind: 'post' as TemplateKind, name: '', personaId: undefined as string | undefined, tags: [] as string[], text: '', shared: false,
  /** owner of a personal template (admins may edit other users'); its personas are offered besides the public ones */
  ownerId: null as string | null,
})
const ownerPersonas = ref<Persona[]>([])
const formPersonaOptions = computed(() => personaGroups(publicPersonas.value, form.shared ? [] : ownerPersonas.value))
async function loadOwnerPersonas() {
  const o = form.ownerId ?? myId.value
  try { ownerPersonas.value = await getPersonas(o === myId.value ? 'scope=mine' : `scope=all-users&ownerId=${o}`) } catch (e) { message.error(errorText(e)) }
}
async function openForm(x?: CommentTemplate) {
  const pre = [...publicPersonas.value, ...personalPersonas.value].find((p) => p.id === filters.personaId && (p.ownerType === 'public' || p.ownerId === myId.value))
  Object.assign(form, x
    ? { id: x.id, kind: x.kind, name: x.name, personaId: x.personaId ?? undefined, tags: [...x.tags], text: x.text, shared: x.shared, ownerId: x.userId }
    : { id: null, kind: filters.kind === 'all' ? 'post' : filters.kind, name: '', personaId: undefined, tags: [], text: '', shared: auth.isAdmin && tab.value === 'public', ownerId: null })
  if (!x && pre && (pre.ownerType === 'public' || !form.shared)) form.personaId = pre.id
  newPersona.value = ''
  open.value = true
  await loadOwnerPersonas()
}
// A shared template only takes a public persona.
watch(() => form.shared, (v) => { if (v && form.personaId && !publicPersonas.value.some((p) => p.id === form.personaId)) form.personaId = undefined })
/** 新建人设 from the persona select: public for a shared template, else a personal one of the template's owner. */
const newPersona = ref('')
async function addPersona() {
  const name = newPersona.value.trim()
  if (!name) return
  const o = form.ownerId ?? myId.value
  try {
    const r = await api<{ persona: Persona }>('POST', '/api/personas', form.shared ? { scope: 'public', name } : { scope: 'mine', name, ...(o !== myId.value ? { ownerId: o } : {}) })
    newPersona.value = ''
    message.success(t('scripts.personas.created'))
    await Promise.all([loadPersonas(), loadOwnerPersonas()])
    form.personaId = r.persona.id
  } catch (e) { message.error(errorText(e)) }
}
async function save() {
  if (!form.name.trim() || !form.text.trim()) { message.warning(t('scripts.required')); return }
  saving.value = true
  try {
    const body = { kind: form.kind, name: form.name, personaId: form.personaId ?? null, tags: form.tags, text: form.text }
    if (form.id) await api('PUT', `/api/comment-templates/${form.id}`, body)
    else await api('POST', '/api/comment-templates', { ...body, shared: auth.isAdmin && form.shared })
    message.success(t('common.saved'))
    open.value = false
    const target: Tab = form.shared ? 'public' : 'mine'
    if (!form.id && target !== tab.value) tab.value = target // the list follows via the scope watcher
    else { void load(); void loadFacets(); void loadPersonas() }
  } catch (e) { message.error(errorText(e)) } finally { saving.value = false }
}
/**
 * 另存为个人 / 建立副本: a new private copy owned by the current user (of a public, another user's or an own template).
 * The persona is kept when the copy may use it (public or the current user's own).
 */
async function duplicate(x: CommentTemplate, done = 'scripts.duplicated') {
  const personaId = x.persona && (x.persona.ownerType === 'public' || x.persona.ownerId === myId.value) ? x.persona.id : null
  try {
    await api('POST', '/api/comment-templates', { kind: x.kind, name: `${x.name}${t('scripts.copySuffix')}`.slice(0, 100), personaId, tags: x.tags, text: x.text })
    message.success(t(done))
    void load()
  } catch (e) { message.error(errorText(e)) }
}
function remove(x: CommentTemplate) {
  confirmDanger({
    title: t('scripts.deleteConfirm', { name: x.name }),
    onOk: async () => { try { await api('DELETE', `/api/comment-templates/${x.id}`); message.success(t('common.deleted')); void load(); void loadFacets(); void loadPersonas() } catch (e) { message.error(errorText(e)) } },
  })
}
</script>

<template>
  <PageContainer :title="t('scripts.title')">
    <template #extra>
      <a-button @click="managerOpen = true">{{ t('scripts.personas.manage') }}</a-button>
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
        <a-select v-model:value="filters.personaId" :placeholder="t('scripts.persona')" allow-clear show-search option-filter-prop="label" style="width: 160px"
          :options="filterOptions" @change="load" />
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
          <template v-else-if="column.key === 'persona'">
            <a-tooltip v-if="record.persona" :title="record.persona.description">{{ record.persona.name }}</a-tooltip>
            <span v-else class="muted">—</span>
          </template>
          <template v-else-if="column.key === 'text'"><div class="pre clamp">{{ record.text }}</div></template>
          <template v-else-if="column.key === 'owner'">{{ isOwn(record as CommentTemplate) ? t('scripts.ownerOwn') : record.ownerName ?? '—' }}</template>
          <template v-else-if="column.key === 'updated'">{{ new Date(record.updatedAt).toLocaleString(dateLocale()) }}</template>
          <template v-else-if="column.key === 'ops'">
            <a-space :size="0">
              <a-button v-if="record.writable" type="link" size="small" @click="openForm(record as CommentTemplate)">{{ t('common.edit') }}</a-button>
              <a-button v-else-if="!isOwn(record as CommentTemplate)" type="link" size="small" @click="duplicate(record as CommentTemplate)">{{ t('scripts.duplicate') }}</a-button>
              <a-button v-if="tab === 'mine' && isOwn(record as CommentTemplate)" type="link" size="small" @click="duplicate(record as CommentTemplate, 'scripts.copyMade')">{{ t('scripts.makeCopy') }}</a-button>
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
              <a-select v-model:value="form.personaId" :options="formPersonaOptions" allow-clear show-search option-filter-prop="label" :placeholder="t('scripts.noPersona')">
                <template #dropdownRender="{ menuNode }">
                  <VNodes :vnodes="menuNode" />
                  <template v-if="!form.shared || auth.isAdmin">
                    <a-divider style="margin: 4px 0" />
                    <div class="new-persona">
                      <a-input v-model:value="newPersona" size="small" :maxlength="50" :placeholder="t('scripts.personas.namePlaceholder')" @press-enter="addPersona" />
                      <a-button type="link" size="small" :disabled="!newPersona.trim()" @click="addPersona"><template #icon><PlusOutlined /></template>{{ t('scripts.personas.add') }}</a-button>
                    </div>
                  </template>
                </template>
              </a-select>
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
    <PersonaManager v-model:open="managerOpen" @changed="personasChanged" />
  </PageContainer>
</template>

<style scoped>
.tabs-card :deep(.ant-card-body) { padding-top: 4px; }
.tabs-card :deep(.ant-tabs-nav) { margin-bottom: var(--cp-gap); }
.pre { white-space: pre-wrap; word-break: break-word; }
.new-persona { display: flex; gap: 4px; padding: 4px 8px; }
.clamp { display: -webkit-box; -webkit-line-clamp: 3; line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
</style>
