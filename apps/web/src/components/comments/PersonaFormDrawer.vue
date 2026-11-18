<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { message } from 'ant-design-vue'
import { PlusOutlined } from '@ant-design/icons-vue'
import { useI18n } from 'vue-i18n'
import { api, errorText } from '../../api/client'
import { PERSONA_LEVELS, PERSONA_TONES, type PersonaDetail, type PersonaExample, type PersonaLevel, type PersonaTone, type TemplateKind } from '../../api/types'
import { useAuthStore } from '../../stores/auth'
import { confirmDanger, DRAWER_WIDTH } from '../common/ui'
import DraftRunInfo from './DraftRunInfo.vue'
import { forgetPersona } from './persona'

/**
 * The one persona form (人设页, owner decision 2026-11-18): 基本 (name, 一句话定位), 风格 for posts AND replies (tone preset
 * with an editable note, emoji, length, topics, banned words), 范例 (≤ 5 post + ≤ 5 reply examples = 话术库 templates of
 * the persona, edited in place), 更多 (hashtags, audience, fixed opening/closing, notes) and AI 草稿 in one row (on/off,
 * per day, public: who gets the drafts, generate one now). No language: it belongs to the social account.
 * `personaId` null = new persona in `scope` (admin: `ownerId` for another user's personal one); after creating, the
 * drawer stays open on the new persona so examples can be added.
 */
const props = defineProps<{
  open: boolean; personaId: string | null; scope: 'public' | 'mine'; ownerId?: string
  users: { id: string; username: string; disabled: boolean }[]
}>()
const emit = defineEmits<{ 'update:open': [boolean]; saved: [id: string] }>()
const { t } = useI18n()
const auth = useAuthStore()
const MAX_EXAMPLES = 5

const id = ref<string | null>(null)
const detail = ref<PersonaDetail | null>(null)
const loading = ref(false)
const saving = ref(false)
const generating = ref(false)
const empty = () => ({
  name: '', description: '',
  tone: 'casual' as PersonaTone, toneNote: '', emoji: 'medium' as PersonaLevel, length: 'medium' as PersonaLevel,
  topics: [] as string[], bannedWords: [] as string[], hashtags: [] as string[], audience: '', opening: '', closing: '', notes: '',
  draftEnabled: false, draftsPerDay: 4, draftOwnerId: undefined as string | undefined,
})
const form = reactive(empty())
type Row = { id: string | null; text: string; saved: string }
const examples = reactive<Record<TemplateKind, Row[]>>({ post: [], comment: [] })

const isPublic = computed(() => (detail.value ? detail.value.persona.ownerType === 'public' : props.scope === 'public'))
const lengths = computed(() => detail.value?.lengths)
const toneNoteDefault = (tone: PersonaTone) => t(`personas.toneNotes.${tone}`)
/** Length table for a new persona (no detail yet). */
const lengthTable = ref<PersonaDetail['lengths'] | null>(null)
const table = computed(() => lengths.value ?? lengthTable.value)

async function load(pid: string) {
  loading.value = true
  try {
    const d = await api<PersonaDetail>('GET', `/api/personas/${pid}`)
    detail.value = d
    const s = d.persona.style
    Object.assign(form, empty(), {
      name: d.persona.name, description: d.persona.description ?? '',
      tone: s.tone, toneNote: s.toneNote ?? toneNoteDefault(s.tone), emoji: s.emoji, length: s.length,
      topics: [...s.topics], bannedWords: [...s.bannedWords], hashtags: [...s.hashtags],
      audience: s.audience ?? '', opening: s.opening ?? '', closing: s.closing ?? '', notes: s.notes ?? '',
      draftEnabled: d.persona.draftEnabled, draftsPerDay: d.persona.draftsPerDay, draftOwnerId: d.persona.draftOwnerId ?? undefined,
    })
    const rows = (xs: PersonaExample[]) => xs.map((e) => ({ id: e.id, text: e.text, saved: e.text }))
    examples.post = rows(d.examples.post)
    examples.comment = rows(d.examples.comment)
  } catch (e) { message.error(errorText(e)); emit('update:open', false) } finally { loading.value = false }
}

watch(() => [props.open, props.personaId] as const, ([open, pid]) => {
  if (!open) return
  id.value = pid
  detail.value = null
  examples.post = []; examples.comment = []
  if (pid) void load(pid)
  else {
    Object.assign(form, empty(), { toneNote: toneNoteDefault('casual') })
    if (!lengths.value) void api<{ lengths: PersonaDetail['lengths'] }>('GET', '/api/personas?scope=public').then((r) => { lengthTable.value = r.lengths }).catch(() => undefined)
  }
}, { immediate: true })

/** A preset brings its own note; a note the person changed stays. */
function pickTone(tone: PersonaTone) {
  if (!form.toneNote.trim() || PERSONA_TONES.some((x) => form.toneNote === toneNoteDefault(x))) form.toneNote = toneNoteDefault(tone)
  form.tone = tone
}

const userOptions = computed(() => props.users.filter((u) => !u.disabled).map((u) => ({ value: u.id, label: u.username })))
const lengthLabel = (l: PersonaLevel) => {
  const tb = table.value
  return tb ? t('personas.form.lengthOpt', { level: t(`personas.levels.length.${l}`), post: tb.post[l].join('–'), reply: tb.comment[l].join('–') }) : t(`personas.levels.length.${l}`)
}

async function save() {
  const name = form.name.trim()
  if (!name) { message.warning(t('personas.nameRequired')); return }
  const body: Record<string, unknown> = {
    name, description: form.description.trim() || null,
    style: {
      tone: form.tone, toneNote: form.toneNote.trim(), emoji: form.emoji, length: form.length,
      topics: form.topics, bannedWords: form.bannedWords, hashtags: form.hashtags,
      audience: form.audience.trim(), opening: form.opening.trim(), closing: form.closing.trim(), notes: form.notes.trim(),
    },
    draftEnabled: form.draftEnabled, draftsPerDay: form.draftsPerDay,
    ...(isPublic.value ? { draftOwnerId: form.draftOwnerId ?? null } : {}),
  }
  saving.value = true
  try {
    if (id.value) {
      await api('PATCH', `/api/personas/${id.value}`, body)
      forgetPersona(id.value)
      message.success(t('common.saved'))
    } else {
      const r = await api<{ persona: { id: string } }>('POST', '/api/personas', { ...body, scope: props.scope, ...(props.ownerId ? { ownerId: props.ownerId } : {}) })
      id.value = r.persona.id
      message.success(t('scripts.personas.created'))
      await load(r.persona.id)
    }
    emit('saved', id.value!)
  } catch (e) { message.error(errorText(e)) } finally { saving.value = false }
}

// ---- 范例: 话术库 templates of the persona (public: shared; personal: its owner's), saved one by one
function addExample(kind: TemplateKind) { examples[kind].push({ id: null, text: '', saved: '' }) }
async function saveExample(kind: TemplateKind, row: Row) {
  const text = row.text.trim()
  const p = detail.value?.persona
  if (!text || !p) return
  const name = text.replace(/\s+/g, ' ').slice(0, 30)
  try {
    if (row.id) await api('PUT', `/api/comment-templates/${row.id}`, { text, name })
    else {
      const owner = p.ownerType === 'public' ? { shared: true } : p.ownerId && p.ownerId !== auth.user?.id ? { ownerId: p.ownerId } : {}
      const r = await api<{ template: { id: string } }>('POST', '/api/comment-templates', { kind, name, text, personaId: p.id, ...owner })
      row.id = r.template.id
    }
    row.text = text; row.saved = text
    forgetPersona(p.id)
    message.success(t('common.saved'))
    emit('saved', p.id)
  } catch (e) { message.error(errorText(e)) }
}
function removeExample(kind: TemplateKind, i: number) {
  const row = examples[kind][i]!
  if (!row.id) { examples[kind].splice(i, 1); return }
  confirmDanger({
    title: t('personas.form.exampleDelete'),
    onOk: async () => {
      try {
        await api('DELETE', `/api/comment-templates/${row.id}`)
        examples[kind].splice(examples[kind].indexOf(row), 1)
        if (detail.value) forgetPersona(detail.value.persona.id)
        emit('saved', detail.value?.persona.id ?? '')
      } catch (e) { message.error(errorText(e)) }
    },
  })
}

async function generate() {
  if (!id.value) return
  generating.value = true
  try {
    await api('POST', `/api/personas/${id.value}/drafts/generate`)
    message.success(t('scripts.drafts.generated'))
    await load(id.value)
    emit('saved', id.value)
  } catch (e) { message.error(errorText(e)) } finally { generating.value = false }
}
const lastRun = computed(() => detail.value?.persona.runs?.[0] ?? null)
</script>

<template>
  <a-drawer :open="open" :title="id ? t('personas.edit') : t('scripts.personas.add')" :width="DRAWER_WIDTH.md" destroy-on-close @close="emit('update:open', false)">
    <a-spin :spinning="loading">
      <a-form layout="vertical">
        <!-- 基本 -->
        <a-form-item :label="t('personas.colName')" required>
          <a-input v-model:value="form.name" :maxlength="50" :placeholder="t('scripts.personas.namePlaceholder')" />
        </a-form-item>
        <a-form-item :label="t('personas.form.positioning')">
          <a-input v-model:value="form.description" :maxlength="100" show-count :placeholder="t('personas.form.positioningPlaceholder')" />
        </a-form-item>

        <!-- 风格 (posts and replies) -->
        <a-divider orientation="left" plain>{{ t('personas.form.style') }}</a-divider>
        <a-form-item :label="t('personas.form.tone')">
          <a-radio-group :value="form.tone" button-style="solid" size="small" @update:value="(v: PersonaTone) => pickTone(v)">
            <a-radio-button v-for="x in PERSONA_TONES" :key="x" :value="x">{{ t(`personas.tones.${x}`) }}</a-radio-button>
          </a-radio-group>
          <a-textarea v-model:value="form.toneNote" class="below" :maxlength="200" :auto-size="{ minRows: 1, maxRows: 3 }" />
        </a-form-item>
        <a-space :size="24" wrap>
          <a-form-item :label="t('personas.form.emoji')">
            <a-radio-group v-model:value="form.emoji" size="small">
              <a-radio-button v-for="x in PERSONA_LEVELS" :key="x" :value="x">{{ t(`personas.levels.emoji.${x}`) }}</a-radio-button>
            </a-radio-group>
          </a-form-item>
          <a-form-item :label="t('personas.form.length')">
            <a-select v-model:value="form.length" style="width: 260px" :options="PERSONA_LEVELS.map((x) => ({ value: x, label: lengthLabel(x) }))" />
          </a-form-item>
        </a-space>
        <a-form-item :label="t('personas.form.topics')" :extra="t('scripts.drafts.listHint')">
          <a-select v-model:value="form.topics" mode="tags" :open="false" :token-separators="[',', '，']" />
        </a-form-item>
        <a-form-item :label="t('personas.form.banned')" :extra="t('personas.form.bannedHint')">
          <a-select v-model:value="form.bannedWords" mode="tags" :open="false" :token-separators="[',', '，']" />
        </a-form-item>

        <a-collapse ghost class="sections">
          <!-- 范例 -->
          <a-collapse-panel key="examples" :header="t('personas.form.examples', { post: examples.post.length, reply: examples.comment.length })">
            <div v-if="!id" class="muted small">{{ t('personas.form.examplesAfterSave') }}</div>
            <template v-else>
              <div v-for="kind in (['post', 'comment'] as const)" :key="kind" class="ex-block">
                <div class="ex-head">
                  <b>{{ t(`personas.form.examples_${kind}`) }}</b>
                  <a-button size="small" type="link" :disabled="examples[kind].length >= MAX_EXAMPLES" @click="addExample(kind)">
                    <template #icon><PlusOutlined /></template>{{ t('personas.form.addExample') }}
                  </a-button>
                </div>
                <div v-if="!examples[kind].length" class="muted small">{{ t('personas.form.examplesEmpty') }}</div>
                <div v-for="(row, i) in examples[kind]" :key="row.id ?? `new-${i}`" class="ex-row">
                  <a-textarea v-model:value="row.text" :auto-size="{ minRows: 2, maxRows: 6 }" :maxlength="kind === 'post' ? 2200 : 500" />
                  <a-space direction="vertical" :size="2">
                    <a-button size="small" type="link" :disabled="!row.text.trim() || row.text.trim() === row.saved" @click="saveExample(kind, row)">{{ t('common.save') }}</a-button>
                    <a-button size="small" type="link" danger @click="removeExample(kind, i)">{{ t('common.delete') }}</a-button>
                  </a-space>
                </div>
              </div>
              <div class="muted small">{{ t('personas.form.examplesHint') }}</div>
            </template>
          </a-collapse-panel>
          <!-- 更多 -->
          <a-collapse-panel key="more" :header="t('personas.form.more')">
            <a-form-item :label="t('personas.form.hashtags')">
              <a-select v-model:value="form.hashtags" mode="tags" :open="false" :token-separators="[' ', ',', '，']" />
            </a-form-item>
            <a-form-item :label="t('personas.form.audience')"><a-input v-model:value="form.audience" :maxlength="200" /></a-form-item>
            <a-form-item :label="t('personas.form.opening')"><a-input v-model:value="form.opening" :maxlength="200" /></a-form-item>
            <a-form-item :label="t('personas.form.closing')"><a-input v-model:value="form.closing" :maxlength="200" /></a-form-item>
            <a-form-item :label="t('personas.form.notes')">
              <a-textarea v-model:value="form.notes" :maxlength="1000" :auto-size="{ minRows: 2, maxRows: 6 }" show-count />
            </a-form-item>
          </a-collapse-panel>
        </a-collapse>

        <!-- AI 草稿: one row -->
        <a-divider orientation="left" plain>{{ t('personas.form.ai') }}</a-divider>
        <div class="ai-row">
          <a-switch v-model:checked="form.draftEnabled" />
          <span>{{ t('personas.form.aiPerDay') }}</span>
          <a-input-number v-model:value="form.draftsPerDay" :min="1" :max="10" :precision="0" size="small" style="width: 70px" />
          <template v-if="isPublic">
            <span>{{ t('personas.form.aiOwner') }}</span>
            <a-select v-model:value="form.draftOwnerId" allow-clear show-search option-filter-prop="label" size="small" style="width: 160px" :options="userOptions" />
          </template>
          <a-button size="small" :disabled="!id" :loading="generating" @click="generate">{{ t('scripts.drafts.generate') }}</a-button>
        </div>
        <div class="muted small ai-hint">{{ t('personas.form.aiHint') }}</div>
        <DraftRunInfo v-if="lastRun" :run="lastRun" />
      </a-form>
    </a-spin>
    <template #footer>
      <a-space>
        <a-button @click="emit('update:open', false)">{{ t('common.cancel') }}</a-button>
        <a-button type="primary" :loading="saving" @click="save">{{ t('common.save') }}</a-button>
      </a-space>
    </template>
  </a-drawer>
</template>

<style scoped>
.below { margin-top: 8px; }
.sections :deep(.ant-collapse-header) { padding-inline-start: 0 !important; }
.ex-block { margin-bottom: 12px; }
.ex-head { display: flex; align-items: center; justify-content: space-between; }
.ex-row { display: flex; gap: 6px; align-items: flex-start; margin-top: 6px; }
.ai-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.ai-hint { margin: 6px 0; }
</style>
