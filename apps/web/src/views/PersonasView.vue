<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { message } from 'ant-design-vue'
import { PlusOutlined } from '@ant-design/icons-vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { api, errorText } from '../api/client'
import { queryParam } from '../api/query'
import type { ScopedItem } from '../api/types'
import PageContainer from '../components/common/PageContainer.vue'
import SearchBar from '../components/common/SearchBar.vue'
import { useScopedList } from '../components/common/scopedList'
import { actionColumn, MODAL_WIDTH, pagination, TABLE_SIZE } from '../components/common/ui'
import DraftPreviewModal from '../components/comments/DraftPreviewModal.vue'
import PersonaFormDrawer from '../components/comments/PersonaFormDrawer.vue'
import { useAuthStore } from '../stores/auth'

/**
 * 人设 page: the scoped persona list (`/api/personas`, rules in `useScopedList` / `lib/scoped-list.ts`) with its uses
 * (账号人设 accounts → /social; 范例 count → opens the form, the 话术库 page /scripts was removed 2026-11-18) and its
 * tone; row actions 编辑 · AI测试 (preview of one draft, a style test, never stored: DraftPreviewModal) · 建立副本 · 删除
 * (提示词 / 自定义提示词 is the form's 提示词 tab since 2026-11-19; the list keeps the 「自定义提示词」 tag).
 * `?edit=<id>` opens the form of that persona (插入话术 links here). 复制到我的人设 on every row (any visible persona → a
 * personal copy with all 范例; admins pick the owner in the 全部用户 tab), then the copy's form opens.
 * Daily AI drafts are set per social account (社交号 → AI 草稿), not on personas. Public personas are managed by admins; personal ones by their owner (admins: all).
 * Create/edit = the one persona form (`PersonaFormDrawer`: 基本, 风格, 选填, 范例). No merge for personas
 * (owner decision 2026-11-18; the shared `useScopedList` merge stays for 内容分类/素材分类).
 * Tabs: 公共 / 我的 (+ admin 全部用户 with an owner filter); `?tab=` keeps the tab in the URL.
 */
const { t } = useI18n()
const auth = useAuthStore()
const route = useRoute()
const router = useRouter()

type PageTab = 'public' | 'mine' | 'all-users'
const pageTabs = computed<PageTab[]>(() => (auth.isAdmin ? ['public', 'mine', 'all-users'] : ['public', 'mine']))
const pageTab = computed<PageTab>({
  get: () => queryParam<PageTab>(route.query, 'tab', pageTabs.value) ?? 'public',
  set: (v) => { void router.replace({ query: { ...route.query, tab: v } }) },
})

const {
  tx, tab, owner, ownerId, loading, list, canEdit, load, remove,
} = useScopedList({ path: '/api/personas', listKey: 'personas', texts: 'scripts.personas' })
const isAllUsers = computed(() => pageTab.value === 'all-users')
function applyTab() {
  tab.value = pageTab.value === 'public' ? 'public' : 'mine'
  owner.value = isAllUsers.value ? 'all-users' : 'own'
  void load()
}
watch(pageTab, applyTab)
watch(ownerId, () => { if (isAllUsers.value) void load() })

// ---- admin: users for the owner filter / owner of a new personal persona
const users = ref<{ id: string; username: string; disabled: boolean }[]>([])
const userOptions = computed(() => users.value.map((u) => ({ value: u.id, label: u.username })))
onMounted(async () => {
  applyTab()
  if (auth.isAdmin) {
    try { users.value = (await api<{ users: typeof users.value }>('GET', '/api/users')).users } catch (e) { message.error(errorText(e)) }
  }
})

// ---- search (name or description, in the loaded tab)
const q = ref('')
const rows = computed(() => {
  const s = q.value.trim().toLowerCase()
  return s ? list.value.filter((p) => p.name.toLowerCase().includes(s) || (p.description ?? '').toLowerCase().includes(s)) : list.value
})
function reset() { q.value = ''; ownerId.value = undefined }

const columns = computed(() => [
  { title: t('personas.colName'), key: 'name', width: 160, ellipsis: true },
  { title: t('personas.colDesc'), key: 'description', width: 300 },
  { title: t('personas.colScope'), key: 'scope', width: 130 },
  { title: t('personas.colAccounts'), key: 'accounts', width: 80, align: 'center' as const },
  { title: t('personas.colTemplates'), key: 'count', width: 80, align: 'center' as const },
  actionColumn(300),
])
const scrollX = computed(() => columns.value.reduce((n, c) => n + (c.width ?? 0), 0))


// ---- AI测试: preview of one draft (same modal as in the form)
const previewFor = ref<ScopedItem | null>(null)
const previewOpen = ref(false)
function preview(p: ScopedItem) { previewFor.value = p; previewOpen.value = true }

// ---- create / edit: the persona form drawer
const formOpen = ref(false)
const editingId = ref<string | null>(null)
const newOwner = ref<string | undefined>()
const ownerPick = ref(false)
function openForm(p?: ScopedItem) {
  editingId.value = p?.id ?? null
  // admin, 全部用户 tab: a new personal persona needs its owner first
  if (!p && isAllUsers.value && !ownerId.value) { newOwner.value = undefined; ownerPick.value = true; return }
  newOwner.value = !p && isAllUsers.value ? ownerId.value : undefined
  formOpen.value = true
}
/** ?edit=<id> (e.g. from 插入话术): open that persona's form once, then drop the parameter. */
watch(() => route.query.edit, (id) => {
  if (typeof id !== 'string' || !id) return
  editingId.value = id
  newOwner.value = undefined
  formOpen.value = true
  const { edit: _e, ...rest } = route.query
  void router.replace({ query: rest })
}, { immediate: true })
function pickOwner() {
  if (!newOwner.value) { message.warning(t('personas.ownerRequired')); return }
  ownerPick.value = false
  formOpen.value = true
}

// ---- 复制到我的人设 (POST /api/personas/:id/copy): any visible persona → a personal copy of the caller, or (admin, 全部用户
// tab) of a picked user; then the new persona's form opens (?tab=…&edit=<id>).
const copySource = ref<{ id: string; name: string } | null>(null)
const copyOpen = ref(false)
const copyOwner = ref<string | undefined>()
const copying = ref(false)
/** Admins choose the owner in the 全部用户 tab (default: themselves); everyone else copies to themselves. */
const copyPicksOwner = computed(() => auth.isAdmin && isAllUsers.value)
function startCopy(p: { id: string; name: string }) {
  copySource.value = { id: p.id, name: p.name }
  copyOwner.value = auth.user?.id
  copyOpen.value = true
}
async function doCopy() {
  const src = copySource.value
  if (!src) return
  const owner = copyPicksOwner.value ? copyOwner.value : auth.user?.id
  if (!owner) { message.warning(t('personas.ownerRequired')); return }
  copying.value = true
  try {
    const r = await api<{ persona: { id: string; name: string } }>('POST', `/api/personas/${src.id}/copy`, owner !== auth.user?.id ? { ownerId: owner } : {})
    message.success(t('personas.copied', { name: r.persona.name }))
    copyOpen.value = false
    const tabTo: PageTab = owner === auth.user?.id ? 'mine' : 'all-users'
    if (tabTo === 'all-users') ownerId.value = owner
    const same = pageTab.value === tabTo
    await router.replace({ query: { ...route.query, tab: tabTo, edit: r.persona.id } })
    if (same) void load()
  } catch (e) { message.error(errorText(e)) } finally { copying.value = false }
}
</script>

<template>
  <PageContainer>
    <template #extra>
      <a-button v-if="canEdit" type="primary" @click="openForm()"><template #icon><PlusOutlined /></template>{{ tx('add') }}</a-button>
    </template>

    <a-card :bordered="false" class="tabs-card">
      <a-tabs v-model:active-key="pageTab">
        <a-tab-pane v-for="k in pageTabs" :key="k" :tab="t(`personas.tabs.${k}`)" />
      </a-tabs>
      <SearchBar :loading="loading" @reset="reset" @refresh="load">
        <a-input v-model:value="q" :placeholder="t('personas.searchPlaceholder')" allow-clear style="width: 240px" />
        <a-select v-if="isAllUsers" v-model:value="ownerId" :placeholder="t('personas.allOwners')" allow-clear show-search option-filter-prop="label"
          style="width: 160px" :options="userOptions" />
      </SearchBar>

      <a-table :data-source="rows" :columns="columns" row-key="id" :size="TABLE_SIZE" :loading="loading" :scroll="{ x: scrollX }"
        :locale="{ emptyText: tx('empty') }" :pagination="pagination({ defaultPageSize: 50, totalText: (n) => t('personas.total', { n }) })">
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'name'">
            <span class="strong">{{ record.name }}</span>
            <div v-if="record.hasCustomPrompt"><a-tag color="purple" class="small-tag">{{ t('personas.prompt.listTag') }}</a-tag></div>
          </template>
          <template v-else-if="column.key === 'description'">
            <span v-if="record.description" class="clamp">{{ record.description }}</span><span v-else class="muted">—</span>
            <div v-if="record.style" class="muted small">{{ t(`personas.tones.${record.style.tone}`) }}<template v-if="record.style.bannedWords.length"> · {{ t('personas.bannedCount', { n: record.style.bannedWords.length }) }}</template></div>
          </template>
          <template v-else-if="column.key === 'scope'">
            <a-tag v-if="record.ownerType === 'public'" color="blue">{{ t('scopedList.public') }}</a-tag>
            <template v-else>
              <a-tag>{{ t('scripts.personal') }}</a-tag>
              <span class="small">{{ record.ownerId === auth.user?.id ? t('scopedList.ownerOwn') : record.ownerName ?? '—' }}</span>
            </template>
          </template>
          <template v-else-if="column.key === 'accounts'">
            <router-link :to="{ path: '/social', query: { personaId: record.id } }">{{ record.accounts ?? 0 }}</router-link>
          </template>
          <template v-else-if="column.key === 'count'">
            <a v-if="record.writable" @click="openForm(record as ScopedItem)">{{ record.count }}</a><span v-else>{{ record.count }}</span>
          </template>
          <template v-else-if="column.key === 'ops'">
            <a-space v-if="record.writable" :size="0">
              <a-button type="link" size="small" @click="openForm(record as ScopedItem)">{{ t('common.edit') }}</a-button>
              <a-button type="link" size="small" @click="preview(record as ScopedItem)">{{ t('personas.aiTest') }}</a-button>
              <a-button type="link" size="small" @click="startCopy(record as ScopedItem)">{{ t('personas.copy') }}</a-button>
              <a-button type="link" size="small" danger @click="remove(record as ScopedItem)">{{ t('common.delete') }}</a-button>
            </a-space>
            <a-button v-else type="link" size="small" @click="startCopy(record as ScopedItem)">{{ t('personas.copy') }}</a-button>
          </template>
        </template>
      </a-table>
    </a-card>

    <a-modal v-model:open="ownerPick" :title="tx('add')" :ok-text="t('common.ok')" :cancel-text="t('common.cancel')" :width="MODAL_WIDTH.sm" @ok="pickOwner">
      <a-form layout="vertical">
        <a-form-item :label="t('personas.owner')" required>
          <a-select v-model:value="newOwner" show-search option-filter-prop="label" :options="userOptions" />
        </a-form-item>
      </a-form>
    </a-modal>

    <a-modal v-model:open="copyOpen" :title="t('personas.copyTitle')" :ok-text="t('personas.copy')" :cancel-text="t('common.cancel')" :width="MODAL_WIDTH.sm"
      :confirm-loading="copying" @ok="doCopy">
      <p><span class="strong">{{ copySource?.name }}</span></p>
      <a-form v-if="copyPicksOwner" layout="vertical">
        <a-form-item :label="t('personas.copyTo')" required>
          <a-select v-model:value="copyOwner" show-search option-filter-prop="label" :options="userOptions" />
        </a-form-item>
      </a-form>
      <div class="muted small">{{ t('personas.copyHint') }}</div>
    </a-modal>

    <PersonaFormDrawer v-model:open="formOpen" :persona-id="editingId" :scope="pageTab === 'public' ? 'public' : 'mine'" :owner-id="newOwner" @saved="load" />
    <DraftPreviewModal v-model:open="previewOpen" :persona-id="previewFor?.id ?? null" :persona-name="previewFor?.name" />
  </PageContainer>
</template>

<style scoped>
.tabs-card :deep(.ant-card-body) { padding-top: 4px; }
.strong { font-weight: 500; }
.small-tag { margin-top: 2px; font-size: 11px; line-height: 16px; }
.clamp { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
</style>
