<script setup lang="ts">
import { message } from 'ant-design-vue'
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { PersonaDetail } from '../../api/types'
import { MODAL_WIDTH } from '../common/ui'
import { loadPersona } from '../comments/persona'

/**
 * 插入话术 for the content editor: lists only the 发文范例 of the target accounts' 账号人设 (the 话术库 page was removed,
 * owner decision 2026-11-18) and hands the picked text to the editor's current text tab. The person edits the result
 * before saving; nothing is generated or posted. Without a persona on the target accounts it says to set one first.
 */
const props = defineProps<{ /** 账号人设 of the selected publish targets (+ an AI draft's persona), first = default. */ personaIds: string[] }>()
const emit = defineEmits<{ insert: [text: string, replace: boolean] }>()
const { t } = useI18n()

const open = ref(false)
const loading = ref(false)
const personas = ref<PersonaDetail[]>([])
const persona = ref<string | undefined>()
const picked = ref<string | undefined>()
const replace = ref(false)

const examples = computed(() => personas.value.find((p) => p.persona.id === persona.value)?.examples.post ?? [])
const current = computed(() => examples.value.find((x) => x.id === picked.value))
watch(persona, () => { picked.value = undefined })

async function show() {
  open.value = true
  picked.value = undefined
  loading.value = true
  try {
    const all = await Promise.allSettled(props.personaIds.map((id) => loadPersona(id)))
    personas.value = all.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []))
    persona.value = personas.value[0]?.persona.id
  } finally { loading.value = false }
}
function ok() {
  if (!current.value) { message.warning(t('scripts.pick')); return }
  emit('insert', current.value.text, replace.value)
  message.info(t('scripts.insertOk'))
  open.value = false
}
</script>

<template>
  <a-button size="small" @click="show">{{ t('scripts.insert') }}</a-button>
  <a-modal v-model:open="open" :title="t('scripts.insert')" :ok-text="t('scripts.insert')" :cancel-text="t('common.cancel')" :width="MODAL_WIDTH.md"
    :ok-button-props="{ disabled: !current }" @ok="ok">
    <a-spin :spinning="loading">
      <div v-if="!loading && !personas.length" class="muted">
        {{ t('personas.card.noPersonaPost') }} <router-link to="/social" @click="open = false">{{ t('personas.card.toSocial') }}</router-link>
      </div>
      <a-form v-else layout="vertical">
        <a-row :gutter="12">
          <a-col :xs="24" :sm="10">
            <a-form-item :label="t('scripts.persona')">
              <a-select v-model:value="persona" :options="personas.map((p) => ({ value: p.persona.id, label: p.persona.name, title: p.persona.description ?? undefined }))" />
            </a-form-item>
          </a-col>
          <a-col :xs="24" :sm="14">
            <a-form-item :label="t('scripts.pick')">
              <a-select v-model:value="picked" show-search option-filter-prop="label" :not-found-content="t('scripts.noTemplates')"
                :options="examples.map((x) => ({ value: x.id, label: x.name }))" />
            </a-form-item>
          </a-col>
        </a-row>
        <a-form-item v-if="current" :label="t('scripts.preview')"><div class="preview">{{ current.text }}</div></a-form-item>
        <a-form-item>
          <a-radio-group v-model:value="replace">
            <a-radio :value="false">{{ t('scripts.append') }}</a-radio>
            <a-radio :value="true">{{ t('scripts.replace') }}</a-radio>
          </a-radio-group>
        </a-form-item>
      </a-form>
      <router-link v-if="personas.find((p) => p.persona.id === persona)?.persona.writable" class="small" :to="{ path: '/personas', query: { edit: persona } }" @click="open = false">{{ t('scripts.manage') }}</router-link>
    </a-spin>
  </a-modal>
</template>

<style scoped>
.preview { white-space: pre-wrap; word-break: break-word; max-height: 200px; overflow: auto; padding: 8px; border-radius: var(--cp-radius); background: var(--cp-fill-alter); }
</style>
