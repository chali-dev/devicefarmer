<script setup lang="ts">
import { message } from 'ant-design-vue'
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { api, errorText } from '../../api/client'
import type { CommentTemplate } from '../../api/types'
import { MODAL_WIDTH } from '../common/ui'

/**
 * "Insert template" for the content editor: picks a post template (话术库, kind post) and hands its text to the
 * editor's current text tab. The person edits the result before saving; nothing is generated or posted.
 */
const props = defineProps<{ /** Default persona filter (e.g. the first publish target's 账号人设); the person can clear it. */ defaultPersonaId?: string | null }>()
const emit = defineEmits<{ insert: [text: string, replace: boolean] }>()
const { t } = useI18n()
const router = useRouter()

const open = ref(false)
const templates = ref<CommentTemplate[]>([])
const loading = ref(false)
const persona = ref<string | undefined>()
const picked = ref<string | undefined>()
const replace = ref(false)

/** Personas used by the visible post templates (the template list already carries them). */
const personas = computed(() => [...new Map(templates.value.flatMap((x) => (x.persona ? [[x.persona.id, x.persona] as const] : []))).values()]
  .sort((a, b) => a.name.localeCompare(b.name)))
const shown = computed(() => templates.value.filter((x) => !persona.value || x.personaId === persona.value))
const current = computed(() => templates.value.find((x) => x.id === picked.value))
watch(persona, () => { if (current.value && !shown.value.includes(current.value)) picked.value = undefined })

async function show() {
  open.value = true
  loading.value = true
  try {
    templates.value = (await api<{ templates: CommentTemplate[] }>('GET', '/api/comment-templates?kind=post')).templates
    const pid = props.defaultPersonaId
    persona.value = pid && personas.value.some((p) => p.id === pid) ? pid : undefined
  } catch (e) { message.error(errorText(e)) } finally { loading.value = false }
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
  <a-modal v-model:open="open" :title="t('scripts.insert')" :ok-text="t('scripts.insert')" :cancel-text="t('common.cancel')" :width="MODAL_WIDTH.md" @ok="ok">
    <a-form layout="vertical">
      <a-row :gutter="12">
        <a-col :xs="24" :sm="10">
          <a-form-item :label="t('scripts.persona')">
            <a-select v-model:value="persona" allow-clear :placeholder="t('common.all')" :options="personas.map((p) => ({ value: p.id, label: p.name, title: p.description ?? undefined }))" />
          </a-form-item>
        </a-col>
        <a-col :xs="24" :sm="14">
          <a-form-item :label="t('scripts.pick')">
            <a-select v-model:value="picked" show-search option-filter-prop="label" :loading="loading" :not-found-content="t('scripts.noTemplates')"
              :options="shown.map((x) => ({ value: x.id, label: x.persona ? `${x.name} · ${x.persona.name}` : x.name }))" />
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
    <a class="small" @click="open = false; router.push({ path: '/scripts', query: { kind: 'post' } })">{{ t('scripts.manage') }}</a>
  </a-modal>
</template>

<style scoped>
.preview { white-space: pre-wrap; word-break: break-word; max-height: 200px; overflow: auto; padding: 8px; border-radius: var(--cp-radius); background: var(--cp-fill-alter); }
</style>
