<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { message } from 'ant-design-vue'
import { PlusOutlined } from '@ant-design/icons-vue'
import { useI18n } from 'vue-i18n'
import { api, errorText } from '../../api/client'
import type { PersonaDetail, PersonaLengths, PersonaVoice } from '../../api/types'
import { useAuthStore } from '../../stores/auth'
import { confirmDanger, DRAWER_WIDTH } from '../common/ui'
import PersonaVoiceFields from './PersonaVoiceFields.vue'
import { forgetPersona, type VoiceForm } from './persona'

/**
 * The one persona form (人设页, owner decision 2026-11-18; style and 范例 merged into one each on 2026-11-19):
 * 基本 = name, 一句话定位; 风格 = tone preset + note, emoji, length (one level: the post and the comment range both
 * follow it), 常聊话题, 禁用词 (checked on posts and comments), 常用标签 (posts only); 选填 = 目标受众, 补充说明 (always
 * shown); 范例 = one list (≤ 20, posts and comments) of the persona's templates, edited in place one by one. AI测试 is
 * only the 人设页 row action (DraftPreviewModal: a style test with an optional 主题, never stored). No language: it
 * belongs to the social account.
 * `personaId` null = new persona in `scope` (admin: `ownerId` for another user's personal one): 范例 can be written right
 * away and are created with the persona in one request (POST /api/personas `examples`, one transaction); after creating,
 * the drawer stays open on the new persona. 复制到我的人设 is a row action of the page only.
 */
const props = defineProps<{
  open: boolean; personaId: string | null; scope: 'public' | 'mine'; ownerId?: string
}>()
const emit = defineEmits<{ 'update:open': [boolean]; saved: [id: string] }>()
const { t } = useI18n()
const auth = useAuthStore()

const id = ref<string | null>(null)
const detail = ref<PersonaDetail | null>(null)
const loading = ref(false)
const saving = ref(false)
const noteOf = (tone: PersonaVoice['tone']) => t(`personas.toneNotes.${tone}`)
const voiceOf = (v?: PersonaVoice): VoiceForm => ({
  tone: v?.tone ?? 'casual', toneNote: v ? v.toneNote ?? noteOf(v.tone) : noteOf('casual'), emoji: v?.emoji ?? 'medium', length: v?.length ?? 'medium',
})
const empty = () => ({
  name: '', description: '', topics: [] as string[], bannedWords: [] as string[],
  voice: voiceOf(), hashtags: [] as string[], audience: '', notes: '',
})
const form = reactive(empty())
type Row = { id: string | null; text: string; saved: string }
const examples = ref<Row[]>([])

/** Length table (detail, or the list endpoint for a new persona) and the 范例 limit per kind. */
const lengthTable = ref<PersonaLengths | null>(null)
const table = computed(() => detail.value?.lengths ?? lengthTable.value)
const maxExamples = computed(() => detail.value?.maxExamples ?? 20)

async function load(pid: string) {
  loading.value = true
  try {
    const d = await api<PersonaDetail>('GET', `/api/personas/${pid}`)
    detail.value = d
    const s = d.persona.style
    Object.assign(form, empty(), {
      name: d.persona.name, description: d.persona.description ?? '', topics: [...s.topics], bannedWords: [...s.bannedWords],
      voice: voiceOf(s), hashtags: [...s.hashtags], audience: s.audience ?? '', notes: s.notes ?? '',
    })
    examples.value = d.examples.map((e) => ({ id: e.id, text: e.text, saved: e.text }))
  } catch (e) { message.error(errorText(e)); emit('update:open', false) } finally { loading.value = false }
}

watch(() => [props.open, props.personaId] as const, ([open, pid]) => {
  if (!open) return
  id.value = pid
  detail.value = null
  examples.value = []
  if (pid) void load(pid)
  else {
    Object.assign(form, empty())
    if (!lengthTable.value) void api<{ lengths: PersonaLengths }>('GET', '/api/personas?scope=public').then((r) => { lengthTable.value = r.lengths }).catch(() => undefined)
  }
}, { immediate: true })

async function save() {
  const name = form.name.trim()
  if (!name) { message.warning(t('personas.nameRequired')); return }
  const body: Record<string, unknown> = {
    name, description: form.description.trim() || null,
    style: {
      tone: form.voice.tone, toneNote: form.voice.toneNote.trim(), emoji: form.voice.emoji, length: form.voice.length,
      topics: form.topics, bannedWords: form.bannedWords, hashtags: form.hashtags, audience: form.audience.trim(), notes: form.notes.trim(),
    },
  }
  saving.value = true
  try {
    if (id.value) {
      await api('PATCH', `/api/personas/${id.value}`, body)
      forgetPersona(id.value)
      message.success(t('common.saved'))
    } else {
      // 范例 written before the first save are created with the persona in the same transaction
      const r = await api<{ persona: { id: string } }>('POST', '/api/personas', {
        ...body, scope: props.scope, ...(props.ownerId ? { ownerId: props.ownerId } : {}), examples: examples.value.map((x) => x.text.trim()).filter(Boolean),
      })
      id.value = r.persona.id
      message.success(t('scripts.personas.created'))
      await load(r.persona.id)
    }
    emit('saved', id.value!)
  } catch (e) { message.error(errorText(e)) } finally { saving.value = false }
}

// ---- 范例: templates of the persona (public: shared; personal: its owner's), saved one by one
function addExample() { examples.value.push({ id: null, text: '', saved: '' }) }
async function saveExample(row: Row) {
  const text = row.text.trim()
  const p = detail.value?.persona
  if (!text || !p) return
  const name = text.replace(/\s+/g, ' ').slice(0, 30)
  try {
    if (row.id) await api('PUT', `/api/comment-templates/${row.id}`, { text, name })
    else {
      const owner = p.ownerType === 'public' ? { shared: true } : p.ownerId && p.ownerId !== auth.user?.id ? { ownerId: p.ownerId } : {}
      const r = await api<{ template: { id: string } }>('POST', '/api/comment-templates', { name, text, personaId: p.id, ...owner })
      row.id = r.template.id
    }
    row.text = text; row.saved = text
    forgetPersona(p.id)
    message.success(t('common.saved'))
    emit('saved', p.id)
  } catch (e) { message.error(errorText(e)) }
}
function removeExample(i: number) {
  const row = examples.value[i]!
  if (!row.id) { examples.value.splice(i, 1); return }
  confirmDanger({
    title: t('personas.form.exampleDelete'),
    onOk: async () => {
      try {
        await api('DELETE', `/api/comment-templates/${row.id}`)
        examples.value.splice(examples.value.indexOf(row), 1)
        if (detail.value) forgetPersona(detail.value.persona.id)
        emit('saved', detail.value?.persona.id ?? '')
      } catch (e) { message.error(errorText(e)) }
    },
  })
}

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

        <!-- 风格: one style for posts and comments -->
        <a-divider orientation="left" plain>{{ t('personas.form.style') }}</a-divider>
        <PersonaVoiceFields v-model="form.voice" :lengths="table" />
        <a-form-item :label="t('personas.form.topics')" :extra="t('scripts.drafts.listHint')">
          <a-select v-model:value="form.topics" mode="tags" :open="false" :token-separators="[',', '，']" />
        </a-form-item>
        <a-form-item :label="t('personas.form.banned')" :extra="t('personas.form.bannedHint')">
          <a-select v-model:value="form.bannedWords" mode="tags" :open="false" :token-separators="[',', '，']" />
        </a-form-item>
        <a-form-item :label="t('personas.form.hashtags')" :extra="t('personas.form.hashtagsHint')">
          <a-select v-model:value="form.hashtags" mode="tags" :open="false" :token-separators="[' ', ',', '，']" />
        </a-form-item>

        <!-- 选填 (always shown) -->
        <a-divider orientation="left" plain>{{ t('personas.form.optional') }}</a-divider>
        <a-form-item :label="t('personas.form.audience')"><a-input v-model:value="form.audience" :maxlength="200" /></a-form-item>
        <a-form-item :label="t('personas.form.notes')">
          <a-textarea v-model:value="form.notes" :maxlength="1000" :auto-size="{ minRows: 2, maxRows: 6 }" show-count />
        </a-form-item>

        <!-- 范例: one list for posts and comments -->
        <a-divider orientation="left" plain>{{ t('personas.form.examples', { n: examples.length, max: maxExamples }) }}</a-divider>
        <div v-if="!examples.length" class="muted small">{{ t('personas.form.examplesEmpty') }}</div>
        <div v-for="(row, i) in examples" :key="row.id ?? `new-${i}`" class="ex-row">
          <a-textarea v-model:value="row.text" :auto-size="{ minRows: 2, maxRows: 6 }" :maxlength="2200" :placeholder="t('personas.form.examplePlaceholder')" />
          <a-space direction="vertical" :size="2">
            <!-- new persona: 范例 are saved with the persona (footer 保存) -->
            <a-button v-if="id" size="small" type="link" :disabled="!row.text.trim() || row.text.trim() === row.saved" @click="saveExample(row)">{{ t('common.save') }}</a-button>
            <a-button size="small" type="link" danger @click="removeExample(i)">{{ t('common.delete') }}</a-button>
          </a-space>
        </div>
        <a-button size="small" type="link" :disabled="examples.length >= maxExamples" @click="addExample()">
          <template #icon><PlusOutlined /></template>{{ t('personas.form.addExample') }}
        </a-button>
        <div class="muted small">{{ t(id ? 'personas.form.examplesHint' : 'personas.form.examplesWithPersona', { max: maxExamples }) }}</div>

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
.ex-row { display: flex; gap: 6px; align-items: flex-start; margin-top: 6px; }
</style>
