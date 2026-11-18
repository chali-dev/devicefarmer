<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { PERSONA_LEVELS, PERSONA_TONES, type PersonaLengths, type PersonaLevel, type PersonaTone } from '../../api/types'
import type { VoiceForm } from './persona'

/**
 * 语气 (preset + editable note), 表情 and 长度 of one kind of the persona form (发文风格 or 评论风格). Picking a preset
 * fills its note unless the person changed the note; the length options show this kind's character range.
 */
const voice = defineModel<VoiceForm>({ required: true })
const props = defineProps<{ kind: 'post' | 'comment'; lengths: PersonaLengths | null }>()
const { t } = useI18n()

const noteOf = (tone: PersonaTone) => t(`personas.toneNotes.${tone}`)
function pickTone(tone: PersonaTone) {
  const v = voice.value
  if (!v.toneNote.trim() || PERSONA_TONES.some((x) => v.toneNote === noteOf(x))) v.toneNote = noteOf(tone)
  v.tone = tone
}
const lengthLabel = (l: PersonaLevel) => {
  const r = props.lengths?.[props.kind][l]
  return r ? t('personas.form.lengthOpt', { level: t(`personas.levels.length.${l}`), min: r[0], max: r[1] }) : t(`personas.levels.length.${l}`)
}
</script>

<template>
  <a-form-item :label="t('personas.form.tone')">
    <a-radio-group :value="voice.tone" button-style="solid" size="small" @update:value="(v: PersonaTone) => pickTone(v)">
      <a-radio-button v-for="x in PERSONA_TONES" :key="x" :value="x">{{ t(`personas.tones.${x}`) }}</a-radio-button>
    </a-radio-group>
    <a-textarea v-model:value="voice.toneNote" class="below" :maxlength="200" :auto-size="{ minRows: 1, maxRows: 3 }" />
  </a-form-item>
  <a-space :size="24" wrap>
    <a-form-item :label="t('personas.form.emoji')">
      <a-radio-group v-model:value="voice.emoji" size="small">
        <a-radio-button v-for="x in PERSONA_LEVELS" :key="x" :value="x">{{ t(`personas.levels.emoji.${x}`) }}</a-radio-button>
      </a-radio-group>
    </a-form-item>
    <a-form-item :label="t('personas.form.length')">
      <a-select v-model:value="voice.length" style="width: 200px" :options="PERSONA_LEVELS.map((x) => ({ value: x, label: lengthLabel(x) }))" />
    </a-form-item>
  </a-space>
</template>

<style scoped>
.below { margin-top: 8px; }
</style>
