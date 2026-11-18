<script setup lang="ts">
/**
 * 「AI生成草稿」 on a social account (row action in 我的媒体号 and the account form's AI 草稿 block), owner request
 * 2026-11-18: optional 主题 → 生成 = POST /api/social/accounts/:id/ai-drafts/preview (ONE draft, synchronous, nothing
 * stored) → the person edits it here: title, body (incl. the persona's fixed lines and hashtags, as it will be stored),
 * the account's 账号语言 version when that is not Chinese (written by a person, starts empty; empty = the Chinese
 * source is published), media (pre-filled with the suggested ready images; 从素材库选择 / 上传), phone preview. Then
 * 发送方式 (3 合 1 like FeedReplyModal): 存草稿 (default) / 立即发布 / 排程发布 + time = one click on
 * POST …/ai-drafts/save, which saves the content and, for the last two, distributes it through the normal distribute()
 * (feed). A refused distribution keeps the draft and says so.
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { Modal, message } from 'ant-design-vue'
import { PlusOutlined, ReloadOutlined } from '@ant-design/icons-vue'
import type { Dayjs } from 'dayjs'
import { useI18n } from 'vue-i18n'
import { api, codeText, errorText } from '../../api/client'
import { langName } from '../../api/lang'
import type { ContentMedia, MediaItem, PublishTaskItem } from '../../api/types'
import { useAuthStore } from '../../stores/auth'
import { MODAL_WIDTH } from '../common/ui'
import ContentMediaUpload from '../content/ContentMediaUpload.vue'
import MediaPicker from '../content/MediaPicker.vue'
import MediaStrip from '../content/MediaStrip.vue'
import PhonePreview from '../content/PhonePreview.vue'
import { toContentMedia } from '../media/media'

const props = defineProps<{ open: boolean; account: { id: string; handle: string; personaId: string | null } | null }>()
const emit = defineEmits<{ 'update:open': [boolean]; done: [] }>()
const { t } = useI18n()
const auth = useAuthStore()

interface Preview {
  title: string; text: string; topic: string | null; banned: string[]; model: string; token: string; media: ContentMedia[]
}
interface PreviewRes { preview: Preview; account: { id: string; userId: string; handle: string; lang: string | null; persona: string } }
type Mode = 'draft' | 'now' | 'at'

const SRC = 'zh-CN'
const MAX_MEDIA = 20
const topic = ref('')
const generating = ref(false)
const genError = ref('')
const draft = ref<PreviewRes | null>(null)
const form = ref({ title: '', body: '', trTitle: '', trBody: '' })
const media = ref<ContentMedia[]>([])
const langTab = ref<'src' | 'tr'>('src')
const mode = ref<Mode>('draft')
const at = ref<Dayjs | null>(null)
const saving = ref(false)
const result = ref<{ kind: 'draft' | 'now' | 'at' | 'kept'; err?: string; taskId?: string } | null>(null)
const pickerOpen = ref(false)

watch(() => props.open, (o) => {
  if (!o) return
  topic.value = ''
  genError.value = ''
  draft.value = null
  media.value = []
  form.value = { title: '', body: '', trTitle: '', trBody: '' }
  langTab.value = 'src'
  mode.value = 'draft'
  at.value = null
  result.value = null
})

/** The account's 账号语言 when it is not Chinese: a second, human-written version is offered. */
const trLang = computed(() => (draft.value?.account.lang && draft.value.account.lang !== SRC ? draft.value.account.lang : null))
const trMissing = computed(() => Boolean(trLang.value) && !form.value.trBody.trim() && !form.value.trTitle.trim())
const edited = computed(() => Boolean(draft.value) && (form.value.title !== draft.value!.preview.title || form.value.body !== draft.value!.preview.text))
const uploadBlocked = computed(() => (draft.value && draft.value.account.userId !== auth.user?.id ? t('content.uploadOtherOwner') : ''))
const previewText = computed(() => (langTab.value === 'tr' && form.value.trBody.trim() ? form.value.trBody : form.value.body))
const okText = computed(() => t(mode.value === 'draft' ? 'feed.saveDraft' : mode.value === 'now' ? 'feed.modeNow' : 'feed.modeAt'))
const busy = computed(() => generating.value || saving.value)

async function generate() {
  if (!props.account) return
  generating.value = true
  genError.value = ''
  try {
    const r = await api<PreviewRes>('POST', `/api/social/accounts/${props.account.id}/ai-drafts/preview`, topic.value.trim() ? { topic: topic.value.trim() } : {})
    draft.value = r
    form.value = { title: r.preview.title, body: r.preview.text, trTitle: form.value.trTitle, trBody: form.value.trBody }
    media.value = r.preview.media
    result.value = null
  } catch (e) { genError.value = errorText(e) } finally { generating.value = false }
}
function regenerate() {
  if (!edited.value) { void generate(); return }
  Modal.confirm({ title: t('social.aiDrafts.regenerateConfirm'), okText: t('social.aiDrafts.regenerate'), onOk: () => generate() })
}

function onPick(picked: ContentMedia[]) { media.value = [...media.value, ...picked.filter((p) => !media.value.some((m) => m.id === p.id))].slice(0, MAX_MEDIA) }
function onUploaded(items: ContentMedia[]) { onPick(items) }
function moveMedia(i: number, d: number) {
  const next = [...media.value]
  const [m] = next.splice(i, 1)
  next.splice(i + d, 0, m!)
  media.value = next
}
// New uploads are still processing: polled like the content editor (publishing waits for ready: publish.media_not_ready).
const processing = computed(() => media.value.filter((m) => m.status === 'processing').map((m) => m.id))
let poll: ReturnType<typeof setTimeout> | undefined
function schedulePoll() { clearTimeout(poll); if (props.open && processing.value.length) poll = setTimeout(() => void pollMedia(), 3000) }
async function pollMedia() {
  const fresh = await Promise.all(processing.value.map((id) => api<{ item: MediaItem }>('GET', `/api/media/${id}`).then((r) => r.item).catch(() => null)))
  const done = fresh.filter((x): x is MediaItem => Boolean(x) && x!.status !== 'processing')
  if (!done.length) { schedulePoll(); return }
  media.value = media.value.map((m) => { const d = done.find((x) => x.id === m.id); return d ? toContentMedia(d) : m })
}
watch([processing, () => props.open], schedulePoll)
onBeforeUnmount(() => clearTimeout(poll))

async function save() {
  if (!props.account || !draft.value) return
  if (!form.value.title.trim()) { langTab.value = 'src'; message.warning(t('content.titleRequired')); return }
  if (mode.value === 'at' && !at.value) { message.warning(t('feed.pickTime')); return }
  saving.value = true
  try {
    const r = await api<{ content: { id: string }; publish: { tasks: PublishTaskItem[]; error: { code: string | null; message: string; params: Record<string, string | number> } | null } | null }>(
      'POST', `/api/social/accounts/${props.account.id}/ai-drafts/save`, {
        title: form.value.title.trim(), body: form.value.body, mediaIds: media.value.map((m) => m.id), token: draft.value.preview.token,
        ...(trLang.value && !trMissing.value ? { translation: { lang: trLang.value, title: form.value.trTitle.trim() || undefined, body: form.value.trBody } } : {}),
        ...(mode.value !== 'draft' ? { publish: { scheduledAt: mode.value === 'at' && at.value ? at.value.toISOString() : null } } : {}),
      })
    emit('done')
    if (r.publish?.error) {
      const e = r.publish.error
      result.value = { kind: 'kept', err: codeText(e.code ?? undefined, e.params, e.message) }
    } else {
      result.value = { kind: mode.value, taskId: r.publish?.tasks[0]?.id }
      message.success(t(`social.aiDrafts.saved.${mode.value}`))
    }
  } catch (e) { message.error(errorText(e)) } finally { saving.value = false }
}
const close = () => emit('update:open', false)
</script>

<template>
  <a-modal :open="open" :title="t('social.aiDrafts.generateTitle', { handle: account?.handle ?? '' })" :width="draft ? 960 : MODAL_WIDTH.sm" :mask-closable="false" @cancel="close">
    <a-alert v-if="account && !account.personaId" type="warning" show-icon :message="t('social.aiDrafts.noPersonaGenerate')" />
    <template v-else>
      <p class="muted small">{{ t('social.aiDrafts.previewIntro') }}</p>
      <div class="topic-row">
        <a-input v-model:value="topic" :maxlength="200" allow-clear :placeholder="t('social.aiDrafts.topicPlaceholder')" :disabled="busy" @press-enter="draft ? regenerate() : generate()">
          <template #addonBefore>{{ t('social.aiDrafts.topic') }}</template>
        </a-input>
        <a-button v-if="!draft" type="primary" :loading="generating" @click="generate">{{ t('social.aiDrafts.generate') }}</a-button>
        <a-button v-else :loading="generating" :disabled="saving" @click="regenerate"><template #icon><ReloadOutlined /></template>{{ t('social.aiDrafts.regenerate') }}</a-button>
      </div>
      <div class="muted small">{{ t('social.aiDrafts.topicHintOne') }}</div>
      <a-alert v-if="generating" type="info" show-icon :message="t('social.aiDrafts.generating')" class="gap">
        <template #icon><a-spin size="small" /></template>
      </a-alert>
      <a-alert v-if="genError" type="error" show-icon :message="t('social.aiDrafts.failed', { msg: genError })" class="gap" />

      <a-row v-if="draft" :gutter="16" class="gap">
        <a-col :xs="24" :lg="15">
          <a-alert type="info" show-icon class="gap-b" :message="t('content.aiDraftNotice')"
            :description="t('social.aiDrafts.origin', { persona: draft.account.persona, model: draft.preview.model })" />
          <a-alert v-if="draft.preview.banned.length" type="warning" show-icon class="gap-b" :message="t('social.aiDrafts.bannedInDraft', { words: draft.preview.banned.join('、') })" />
          <a-tabs v-if="trLang" v-model:active-key="langTab" size="small">
            <a-tab-pane key="src" :tab="t('social.aiDrafts.sourceTab')" />
            <a-tab-pane key="tr">
              <template #tab>{{ t('social.aiDrafts.trTab', { lang: langName(trLang) }) }} <a-tag v-if="trMissing" color="warning" class="tab-tag">{{ t('social.aiDrafts.trEmpty') }}</a-tag></template>
            </a-tab-pane>
          </a-tabs>
          <a-form layout="vertical">
            <template v-if="langTab === 'src' || !trLang">
              <a-form-item :label="t('social.aiDrafts.fieldTitle')" required>
                <a-input v-model:value="form.title" :maxlength="200" />
              </a-form-item>
              <a-form-item :label="t('social.aiDrafts.fieldBody')">
                <a-textarea v-model:value="form.body" :auto-size="{ minRows: 6, maxRows: 14 }" :maxlength="2200" show-count />
              </a-form-item>
            </template>
            <template v-else>
              <div class="muted small gap-b">{{ t('social.aiDrafts.trHint', { lang: langName(trLang) }) }}</div>
              <a-form-item :label="t('social.aiDrafts.fieldTitle')">
                <a-input v-model:value="form.trTitle" :maxlength="200" :placeholder="t('social.aiDrafts.trTitlePlaceholder')" />
              </a-form-item>
              <a-form-item :label="t('social.aiDrafts.fieldBody')">
                <a-textarea v-model:value="form.trBody" :auto-size="{ minRows: 6, maxRows: 14 }" :maxlength="2200" show-count />
              </a-form-item>
            </template>
            <a-alert v-if="trLang && trMissing && mode !== 'draft'" type="warning" show-icon class="gap-b"
              :message="t('content.lang.missing', { langs: langName(trLang) })" :description="t('social.aiDrafts.trMissingHint')" />
            <a-form-item :label="t('content.fieldMedia', { n: media.length })">
              <MediaStrip :media="media" :size="72" editable @move="moveMedia" @remove="(i: number) => media.splice(i, 1)" />
              <a-space style="margin-top: 8px" wrap>
                <a-button :disabled="media.length >= MAX_MEDIA" @click="pickerOpen = true"><template #icon><PlusOutlined /></template>{{ t('content.addMedia') }}</a-button>
                <ContentMediaUpload :disabled="media.length >= MAX_MEDIA" :blocked="uploadBlocked" @uploaded="onUploaded" />
              </a-space>
              <div v-if="draft.preview.media.length" class="muted small">{{ t('social.aiDrafts.suggestedMedia') }}</div>
              <div v-if="uploadBlocked" class="muted small">{{ uploadBlocked }}</div>
              <div v-if="processing.length" class="muted small">{{ t('content.mediaProcessingHint', { n: processing.length }) }}</div>
            </a-form-item>
            <a-form-item :label="t('feed.sendMode')">
              <a-radio-group v-model:value="mode" button-style="solid">
                <a-radio-button value="draft">{{ t('feed.modeDraft') }}</a-radio-button>
                <a-radio-button value="now">{{ t('feed.modeNow') }}</a-radio-button>
                <a-radio-button value="at">{{ t('feed.modeAt') }}</a-radio-button>
              </a-radio-group>
              <a-date-picker v-if="mode === 'at'" v-model:value="at" show-time :placeholder="t('feed.pickTime')" style="width: 100%; margin-top: 8px" />
            </a-form-item>
          </a-form>
          <a-alert v-if="mode !== 'draft'" type="warning" show-icon :message="t('social.aiDrafts.liveHint')" />
          <a-alert v-if="result?.kind === 'kept'" type="error" show-icon class="gap" :message="t('social.aiDrafts.publishFailedDraftKept', { err: result.err })">
            <template #description><router-link to="/content?status=draft" @click="close">{{ t('social.aiDrafts.openDrafts') }}</router-link></template>
          </a-alert>
          <a-alert v-else-if="result" type="success" show-icon class="gap" :message="t(`social.aiDrafts.saved.${result.kind}`)">
            <template #description>
              <router-link v-if="result.taskId" :to="{ path: '/publish', query: { tab: 'queue', task: result.taskId } }" @click="close">{{ t('social.aiDrafts.openTask') }}</router-link>
              <router-link v-else to="/content?status=draft" @click="close">{{ t('social.aiDrafts.openDrafts') }}</router-link>
            </template>
          </a-alert>
        </a-col>
        <a-col :xs="24" :lg="9">
          <PhonePreview :media="media" :text="previewText" :handle="draft.account.handle" />
        </a-col>
      </a-row>
    </template>
    <template #footer>
      <a-button @click="close">{{ t('social.aiDrafts.close') }}</a-button>
      <a-button v-if="draft && !result" type="primary" :loading="saving" :disabled="generating" @click="save">{{ okText }}</a-button>
    </template>
    <MediaPicker v-model:open="pickerOpen" :exclude="media.map((m) => m.id)" @pick="onPick" />
  </a-modal>
</template>

<style scoped>
.topic-row { display: flex; gap: 8px; }
.topic-row :deep(.ant-input-group-wrapper) { flex: 1; }
.gap { margin-top: 12px; }
.gap-b { margin-bottom: 12px; }
.tab-tag { margin-inline-start: 4px; }
</style>
