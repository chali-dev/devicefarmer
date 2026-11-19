<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { PERSONA_LEVELS, PERSONA_TONES, type PersonaLengths, type PersonaLevel, type PersonaTone } from '../../api/types'
import type { VoiceForm } from './persona'

/**
 * 语气 (preset + editable note), 表情 and 长度 of the persona form's one 风格. Picking a preset always fills its note with
 * the preset text (owner 2026-11-19: switching 语气 must visibly change it; the note stays editable afterwards); each
 * length option shows its post and its comment character range (one level drives both).
 */
const voice = defineModel<VoiceForm>({ required: true })
const props = defineProps<{ lengths: PersonaLengths | null }>()
const { t } = useI18n()

const noteOf = (tone: PersonaTone) => t(`personas.toneNotes.${tone}`)
function pickTone(tone: PersonaTone) {
  const v = voice.value
  v.toneNote = noteOf(tone)
  v.tone = tone
}
const lengthLabel = (l: PersonaLevel) => {
  const p = props.lengths?.post[l]
  const c = props.lengths?.comment[l]
  return p && c
    ? t('personas.form.lengthOpt', { level: t(`personas.levels.length.${l}`), pmin: p[0], pmax: p[1], cmin: c[0], cmax: c[1] })
    : t(`personas.levels.length.${l}`)
}
</script>

<template>
  <a-form-item :label="t('personas.form.tone')">
    <a-radio-group :value="voice.tone" button-style="solid" size="small" @update:value="(v: PersonaTone) => pickTone(v)">
      <a-radio-button v-for="x in PERSONA_TONES" :key="x" :value="x">{{ t(`personas.tones.${x}`) }}</a-radio-button>
    </a-radio-group>
    <a-textarea v-model:value="voice.toneNote" class="below" :maxlength="200" :auto-size="{ minRows: 1, maxRows: 3 }" />
  </a-form-item>
  <a-form-item :label="t('personas.form.emoji')">
    <a-radio-group v-model:value="voice.emoji" size="small">
      <a-radio-button v-for="x in PERSONA_LEVELS" :key="x" :value="x">{{ t(`personas.levels.emoji.${x}`) }}</a-radio-button>
    </a-radio-group>
  </a-form-item>
  <a-form-item :label="t('personas.form.length')">
    <a-select v-model:value="voice.length" :options="PERSONA_LEVELS.map((x) => ({ value: x, label: lengthLabel(x) }))" />
  </a-form-item>
</template>

<style scoped>
.below { margin-top: 8px; }
</style>
