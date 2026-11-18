<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { PersonaDetail } from '../../api/types'
import { bannedHits, charCount, loadPersona } from './persona'

/**
 * Persona card next to a post editor (`kind` post: 发文风格) or a comment composer (`kind` comment: 评论风格): 定位,
 * the style of this kind (语气, 表情, length range) and the shared 禁用词. Live hints on the text being written: banned
 * words (the API refuses them on save/schedule with persona.banned_word) and, for comments, a gentle note when the text
 * is outside the comment length range (never blocking). With `insertable` it lists the persona's 范例 of this kind;
 * 插入 hands the text to the composer (the person edits it). Without a persona an insertable card says to set one on
 * the account first (link to 社交号).
 */
const props = defineProps<{ personaId: string | null | undefined; kind: 'post' | 'comment'; text?: string; insertable?: boolean }>()
const emit = defineEmits<{ insert: [text: string, templateId: string] }>()
const { t } = useI18n()

const d = ref<PersonaDetail | null>(null)
watch(() => props.personaId, async (id) => {
  d.value = null
  if (!id) return
  try { d.value = await loadPersona(id) } catch { d.value = null }
}, { immediate: true })

const style = computed(() => d.value?.persona.style)
const voice = computed(() => style.value?.[props.kind])
const range = computed(() => (d.value && voice.value ? d.value.lengths[props.kind][voice.value.length] : null))
const hits = computed(() => bannedHits(style.value?.bannedWords, props.text ?? ''))
const n = computed(() => charCount(props.text ?? ''))
const lengthNote = computed(() => {
  if (props.kind !== 'comment' || !range.value || !n.value) return null
  const [min, max] = range.value
  return n.value < min || n.value > max ? t('personas.card.lengthOff', { min, max, n: n.value }) : null
})
const examples = computed(() => (props.insertable && d.value ? d.value.examples[props.kind] : []))
const showExamples = ref(false)
</script>

<template>
  <div v-if="d && style && voice" class="persona-card">
    <div class="head">
      <span class="muted small">{{ t(`personas.card.title_${kind}`) }}</span>
      <b>{{ d.persona.name }}</b>
      <a-tag v-if="d.persona.ownerType === 'public'" color="blue" class="chip">{{ t('scopedList.public') }}</a-tag>
    </div>
    <div v-if="d.persona.description" class="line">{{ d.persona.description }}</div>
    <div class="line small">
      <span class="muted">{{ t('personas.form.tone') }}</span> {{ t(`personas.tones.${voice.tone}`) }}
      <span class="muted"> · {{ t('personas.form.emoji') }}</span> {{ t(`personas.levels.emoji.${voice.emoji}`) }}
      <span v-if="range" class="muted"> · {{ t(`personas.card.length.${kind}`, { min: range[0], max: range[1] }) }}</span>
    </div>
    <div v-if="voice.toneNote" class="line small muted">{{ voice.toneNote }}</div>
    <div v-if="style.bannedWords.length" class="line small">
      <span class="muted">{{ t('personas.form.banned') }}</span>
      <a-tag v-for="w in style.bannedWords" :key="w" :color="hits.includes(w) ? 'red' : undefined" class="chip">{{ w }}</a-tag>
    </div>
    <a-alert v-if="hits.length" type="error" show-icon class="note" :message="t('personas.card.bannedHit', { words: hits.join('、') })" />
    <a-alert v-if="lengthNote" type="info" show-icon class="note" :message="lengthNote" />
    <template v-if="examples.length">
      <a class="small" @click="showExamples = !showExamples">{{ t(`personas.card.examples.${kind}`, { n: examples.length }) }}</a>
      <div v-if="showExamples" class="examples">
        <div v-for="e in examples" :key="e.id" class="example">
          <div class="ex-text">{{ e.text }}</div>
          <a class="small" @click="emit('insert', e.text, e.id)">{{ t('personas.card.insert') }}</a>
        </div>
      </div>
    </template>
  </div>
  <div v-else-if="insertable && !personaId" class="muted small no-persona">
    {{ t('personas.card.noPersona') }} <router-link to="/social">{{ t('personas.card.toSocial') }}</router-link>
  </div>
</template>

<style scoped>
.persona-card { border: 1px solid var(--cp-border-secondary); border-radius: var(--cp-radius); background: var(--cp-fill-alter); padding: 8px 12px; margin-bottom: 12px; }
.head { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.line { margin-top: 4px; word-break: break-word; }
.chip { margin-inline-end: 4px; }
.note { margin-top: 6px; }
.examples { margin-top: 4px; display: flex; flex-direction: column; gap: 6px; }
.example { display: flex; gap: 8px; align-items: flex-start; justify-content: space-between; border-top: 1px dashed var(--cp-border-secondary); padding-top: 6px; }
.ex-text { white-space: pre-wrap; word-break: break-word; font-size: 13px; flex: 1; }
.no-persona { margin-bottom: 12px; }
</style>
