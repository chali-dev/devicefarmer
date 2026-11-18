<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { message } from 'ant-design-vue'
import { useI18n } from 'vue-i18n'
import { api, errorText } from '../../api/client'
import { langName } from '../../api/lang'
import type { CommentTemplate, PersonaBrief, PersonaDraftSettings } from '../../api/types'
import { useAuthStore } from '../../stores/auth'
import { DRAWER_WIDTH } from '../common/ui'
import DraftRunInfo from './DraftRunInfo.vue'

/**
 * 人设内容设定 (人设每日草稿, AI): brief, drafts per day, draft owner (public personas), "generate one now" and the
 * last runs. AI only writes drafts; people review, edit and publish them.
 */
const props = defineProps<{ personaId: string | null }>()
const emit = defineEmits<{ close: []; changed: [] }>()
const { t } = useI18n()
const auth = useAuthStore()

const s = ref<PersonaDraftSettings | null>(null)
const loading = ref(false)
const saving = ref(false)
const generating = ref(false)
const form = ref({ draftEnabled: false, draftsPerDay: 4, draftOwnerId: undefined as string | undefined, brief: {} as Required<Omit<PersonaBrief, 'lang'>> & { lang: string | undefined } })
const templates = ref<CommentTemplate[]>([])
const users = ref<{ id: string; username: string; disabled: boolean }[]>([])
const languages = ref<string[]>([])

const emptyBrief = () => ({ tone: '', topics: [], audience: '', lang: undefined, hashtags: [], bannedWords: [], exampleTemplateIds: [], notes: '' })

async function load(id: string) {
  loading.value = true
  try {
    const [d, tpl] = await Promise.all([
      api<{ drafts: PersonaDraftSettings }>('GET', `/api/personas/${id}/drafts`),
      api<{ templates: CommentTemplate[] }>('GET', '/api/comment-templates?kind=post'),
    ])
    // Chinese + the languages bound to the accounts that can use the persona (personal: its owner's; public: all).
    const langs = await api<{ languages: string[] }>('GET', `/api/contents/languages${d.drafts.ownerType === 'user' && d.drafts.ownerId ? `?ownerId=${d.drafts.ownerId}` : ''}`)
    s.value = d.drafts
    templates.value = tpl.templates
    languages.value = langs.languages
    if (d.drafts.ownerType === 'public' && auth.isAdmin && !users.value.length) {
      users.value = (await api<{ users: { id: string; username: string; disabled: boolean }[] }>('GET', '/api/users')).users
    }
    const b = d.drafts.brief
    form.value = {
      draftEnabled: d.drafts.draftEnabled, draftsPerDay: d.drafts.draftsPerDay, draftOwnerId: d.drafts.draftOwnerId ?? undefined,
      brief: { ...emptyBrief(), ...b, lang: b.lang ?? undefined } as typeof form.value.brief,
    }
  } catch (e) { message.error(errorText(e)); emit('close') } finally { loading.value = false }
}
watch(() => props.personaId, (id) => { if (id) void load(id); else s.value = null }, { immediate: true })

/** Examples: post scripts visible to the persona (public: shared only; personal: shared + the owner's). */
const exampleOptions = computed(() => templates.value
  .filter((x) => x.shared || (s.value?.ownerType === 'user' && x.userId === s.value.ownerId))
  .map((x) => ({ value: x.id, label: x.shared ? x.name : `${x.name} · ${x.ownerName ?? ''}` })))
const userOptions = computed(() => users.value.filter((u) => !u.disabled).map((u) => ({ value: u.id, label: u.username })))

async function save() {
  if (!s.value) return
  saving.value = true
  try {
    const b = form.value.brief
    const body: Record<string, unknown> = {
      draftEnabled: form.value.draftEnabled, draftsPerDay: form.value.draftsPerDay,
      brief: { ...b, lang: b.lang ?? null, tone: b.tone.trim(), audience: b.audience.trim(), notes: b.notes.trim() },
    }
    if (s.value.ownerType === 'public') body.draftOwnerId = form.value.draftOwnerId ?? null
    s.value = (await api<{ drafts: PersonaDraftSettings }>('PUT', `/api/personas/${s.value.id}/drafts`, body)).drafts
    message.success(t('common.saved'))
    emit('changed')
  } catch (e) { message.error(errorText(e)) } finally { saving.value = false }
}

async function generate() {
  if (!s.value) return
  generating.value = true
  try {
    await api('POST', `/api/personas/${s.value.id}/drafts/generate`)
    message.success(t('scripts.drafts.generated'))
    await load(s.value.id)
  } catch (e) { message.error(errorText(e)) } finally { generating.value = false }
}
</script>

<template>
  <a-drawer :open="!!personaId" :title="s ? t('scripts.drafts.title', { name: s.name }) : ''" :width="DRAWER_WIDTH.md" destroy-on-close @close="emit('close')">
    <a-spin :spinning="loading">
      <template v-if="s">
        <a-alert type="warning" show-icon :message="t('scripts.drafts.notice')" class="gap" />
        <a-form layout="vertical">
          <a-space :size="24" wrap>
            <a-form-item :label="t('scripts.drafts.enabled')"><a-switch v-model:checked="form.draftEnabled" /></a-form-item>
            <a-form-item :label="t('scripts.drafts.perDay')"><a-input-number v-model:value="form.draftsPerDay" :min="1" :max="10" :precision="0" /></a-form-item>
          </a-space>
          <a-form-item v-if="s.ownerType === 'public'" :label="t('scripts.drafts.owner')" :extra="t('scripts.drafts.ownerHint')">
            <a-select v-model:value="form.draftOwnerId" allow-clear show-search option-filter-prop="label" :options="userOptions"
              :placeholder="s.draftOwnerName ?? undefined" />
          </a-form-item>
          <div v-else class="muted small gap">
            {{ t('scripts.drafts.ownerPersonal', { name: s.draftOwnerName ?? '—' }) }}<span v-if="s.draftOwnerDisabled">{{ t('scripts.drafts.ownerDisabled') }}</span>
          </div>
          <a-form-item :label="t('scripts.drafts.lang')">
            <a-select v-model:value="form.brief.lang" allow-clear :placeholder="t('scripts.drafts.langDefault')"
              :options="languages.map((l) => ({ value: l, label: `${langName(l)} (${l})` }))" />
          </a-form-item>
          <a-form-item :label="t('scripts.drafts.tone')"><a-input v-model:value="form.brief.tone" :maxlength="200" /></a-form-item>
          <a-form-item :label="t('scripts.drafts.audience')"><a-input v-model:value="form.brief.audience" :maxlength="200" /></a-form-item>
          <a-form-item :label="t('scripts.drafts.topics')" :extra="t('scripts.drafts.listHint')">
            <a-select v-model:value="form.brief.topics" mode="tags" :open="false" :max-tag-text-length="30" />
          </a-form-item>
          <a-form-item :label="t('scripts.drafts.hashtags')">
            <a-select v-model:value="form.brief.hashtags" mode="tags" :open="false" :token-separators="[' ', ',']" />
          </a-form-item>
          <a-form-item :label="t('scripts.drafts.banned')">
            <a-select v-model:value="form.brief.bannedWords" mode="tags" :open="false" :token-separators="[',']" />
          </a-form-item>
          <a-form-item :label="t('scripts.drafts.examples')">
            <a-select v-model:value="form.brief.exampleTemplateIds" mode="multiple" :max-count="5" show-search option-filter-prop="label" :options="exampleOptions" />
          </a-form-item>
          <a-form-item :label="t('scripts.drafts.notes')"><a-textarea v-model:value="form.brief.notes" :maxlength="1000" :auto-size="{ minRows: 2, maxRows: 6 }" show-count /></a-form-item>
          <a-space wrap>
            <a-button type="primary" :loading="saving" @click="save">{{ t('common.save') }}</a-button>
            <a-button :loading="generating" @click="generate">{{ t('scripts.drafts.generate') }}</a-button>
          </a-space>
        </a-form>
        <a-divider orientation="left" plain>{{ t('scripts.drafts.runs') }}</a-divider>
        <a-empty v-if="!s.runs.length" />
        <div v-for="r in s.runs" :key="r.id" class="run"><DraftRunInfo :run="r" /></div>
      </template>
    </a-spin>
  </a-drawer>
</template>

<style scoped>
.gap { margin-bottom: 16px; }
.run { padding: 4px 0; }
</style>
