<script setup lang="ts">
import { message } from 'ant-design-vue'
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { api, errorText } from '../../api/client'
import type { CommentTemplate } from '../../api/types'

/**
 * "Insert template" for the content editor: picks a post template (话术库, kind post) and hands its text to the
 * editor for one field. The person edits the result before saving; nothing is generated or posted.
 */
export type InsertTarget = 'body' | 'ytDescription' | 'igCaption' | 'ttCaption' | 'fbCaption'
const TARGETS: InsertTarget[] = ['body', 'ytDescription', 'igCaption', 'ttCaption', 'fbCaption']

const emit = defineEmits<{ insert: [target: InsertTarget, text: string, replace: boolean] }>()
const { t } = useI18n()
const router = useRouter()

const open = ref(false)
const templates = ref<CommentTemplate[]>([])
const loading = ref(false)
const persona = ref<string | undefined>()
const picked = ref<string | undefined>()
const target = ref<InsertTarget>('body')
const replace = ref(false)

const personas = computed(() => [...new Set(templates.value.map((x) => x.persona).filter((p): p is string => !!p))].sort())
const shown = computed(() => templates.value.filter((x) => !persona.value || x.persona === persona.value))
const current = computed(() => templates.value.find((x) => x.id === picked.value))
watch(persona, () => { if (current.value && !shown.value.includes(current.value)) picked.value = undefined })

async function show() {
  open.value = true
  loading.value = true
  try { templates.value = (await api<{ templates: CommentTemplate[] }>('GET', '/api/comment-templates?kind=post')).templates } catch (e) { message.error(errorText(e)) } finally { loading.value = false }
}
function ok() {
  if (!current.value) { message.warning(t('scripts.pick')); return }
  emit('insert', target.value, current.value.text, replace.value)
  message.info(t('scripts.insertOk'))
  open.value = false
}
</script>

<template>
  <a-button size="small" @click="show">{{ t('scripts.insert') }}</a-button>
  <a-modal v-model:open="open" :title="t('scripts.insert')" :ok-text="t('scripts.insert')" :cancel-text="t('common.cancel')" :width="600" @ok="ok">
    <a-form layout="vertical">
      <a-row :gutter="12">
        <a-col :xs="24" :sm="10">
          <a-form-item :label="t('scripts.persona')">
            <a-select v-model:value="persona" allow-clear :placeholder="t('common.all')" :options="personas.map((p) => ({ value: p, label: p }))" />
          </a-form-item>
        </a-col>
        <a-col :xs="24" :sm="14">
          <a-form-item :label="t('scripts.pick')">
            <a-select v-model:value="picked" show-search option-filter-prop="label" :loading="loading" :not-found-content="t('scripts.noTemplates')"
              :options="shown.map((x) => ({ value: x.id, label: x.persona ? `${x.name} · ${x.persona}` : x.name }))" />
          </a-form-item>
        </a-col>
      </a-row>
      <a-form-item v-if="current" :label="t('scripts.preview')"><div class="preview">{{ current.text }}</div></a-form-item>
      <a-row :gutter="12">
        <a-col :xs="24" :sm="14">
          <a-form-item :label="t('scripts.insertTarget')">
            <a-select v-model:value="target" :options="TARGETS.map((x) => ({ value: x, label: t(`scripts.targets.${x}`) }))" />
          </a-form-item>
        </a-col>
        <a-col :xs="24" :sm="10">
          <a-form-item label=" ">
            <a-radio-group v-model:value="replace">
              <a-radio :value="false">{{ t('scripts.append') }}</a-radio>
              <a-radio :value="true">{{ t('scripts.replace') }}</a-radio>
            </a-radio-group>
          </a-form-item>
        </a-col>
      </a-row>
    </a-form>
    <div class="muted">
      {{ t('scripts.hint') }} <a @click="open = false; router.push({ path: '/scripts', query: { kind: 'post' } })">{{ t('scripts.manage') }}</a>
    </div>
  </a-modal>
</template>

<style scoped>
.preview { white-space: pre-wrap; word-break: break-word; max-height: 200px; overflow: auto; padding: 8px; border-radius: 6px; background: var(--cp-fill-alter); }
.muted { color: var(--cp-text-tertiary); font-size: 12px; }
</style>
