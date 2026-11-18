<script setup lang="ts">
import { message, Modal } from 'ant-design-vue'
import dayjs, { type Dayjs } from 'dayjs'
import { computed, h, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { api, codeText, errorText, type ErrorParams } from '../../api/client'
import { POST_TYPES, type PostType, type PublishPlatform } from '../../api/types'
import { MODAL_WIDTH } from '../common/ui'

/**
 * 批量发布 (内容管理 批量操作 → 发布, POST /api/contents/batch {action:'publish'}): every selected content goes to its own
 * 发布目标 (content_targets, enabled platforms, minus accounts it was already published to), now or all at the same
 * time. Opening runs a dry run (same request with dryRun) for the summary: N contents × their account counts, and the
 * contents that will be skipped with the reason (draft, archived, no targets, all published, unfinished publish tasks).
 * Drafts are skipped unless 包含草稿 is ticked (they become 待发布 when published, like a single 分发). The real run
 * validates each content again like 分发 (media rules, banned words …) and reports refusals per content.
 */
const props = defineProps<{ open: boolean; ids: string[]; titles: Map<string, string> }>()
const emit = defineEmits<{ 'update:open': [boolean]; done: [] }>()
const { t } = useI18n()

interface Skip { id: string; code: string; params?: ErrorParams }
interface PublishResult { ok: string[]; skipped: Skip[]; changed: number; publish?: { tasks: number; items: { id: string; accounts: number }[] } }

const form = reactive({ when: 'now' as 'now' | 'at', at: null as Dayjs | null, postType: 'feed' as PostType, includeDrafts: false })
const preview = ref<PublishResult | null>(null)
const loading = ref(false)
const saving = ref(false)
const platforms = ref<PublishPlatform[]>([])
const postTypes = computed(() => POST_TYPES.filter((x) => platforms.value.some((p) => p.postTypes.includes(x))))
const defaultAt = () => dayjs().add(90, 'minute').startOf('hour')
const pastDay = (d: Dayjs) => d.isBefore(dayjs(), 'day')
const title = (id: string) => props.titles.get(id) ?? id
const reason = (s: Skip) => codeText(s.code, s.params, s.code)

const body = (dryRun: boolean) => ({
  ids: props.ids, action: 'publish', dryRun, includeDrafts: form.includeDrafts, postType: form.postType,
  scheduledAt: form.when === 'at' && form.at ? form.at.toISOString() : null,
})
async function runPreview() {
  loading.value = true
  try { preview.value = await api<PublishResult>('POST', '/api/contents/batch', body(true)) } catch (e) { preview.value = null; message.error(errorText(e)) }
  finally { loading.value = false }
}
watch(() => props.open, async (o) => {
  if (!o) return
  Object.assign(form, { when: 'now', at: null, postType: 'feed', includeDrafts: false })
  preview.value = null
  void runPreview()
  try { platforms.value = (await api<{ platforms: PublishPlatform[] }>('GET', '/api/publish/platforms')).platforms } catch { /* feed only */ }
})
watch(() => form.includeDrafts, () => { if (props.open) void runPreview() })
function onWhen() { if (form.when === 'at' && !form.at) form.at = defaultAt() }

const items = computed(() => preview.value?.publish?.items ?? [])
const tasks = computed(() => preview.value?.publish?.tasks ?? 0)
const ready = computed(() => items.value.length > 0 && (form.when === 'now' || !!form.at))

async function submit() {
  if (form.when === 'at' && !form.at) { message.warning(t('distribute.pickTime')); return }
  saving.value = true
  try {
    const r = await api<PublishResult>('POST', '/api/contents/batch', body(false))
    const done = t('content.batchPublish.done', { n: r.changed, tasks: r.publish?.tasks ?? 0 })
    if (r.skipped.length) {
      Modal.warning({
        title: t('content.batch.skippedTitle', { ok: r.ok.length, skipped: r.skipped.length }),
        content: h('div', [
          h('p', done),
          h('ul', { style: 'padding-inline-start: 18px; margin: 0; max-height: 240px; overflow: auto' }, r.skipped.map((x) => h('li', `${title(x.id)}: ${reason(x)}`))),
        ]),
      })
    } else message.success(done)
    emit('update:open', false)
    emit('done')
  } catch (e) { message.error(errorText(e)) } finally { saving.value = false }
}
</script>

<template>
  <a-modal :open="open" :title="t('content.batchPublish.title', { n: ids.length })" :width="MODAL_WIDTH.md" :confirm-loading="saving"
    :ok-text="form.when === 'at' ? t('content.batchPublish.submitAt', { tasks }) : t('content.batchPublish.submitNow', { tasks })"
    :ok-button-props="{ disabled: !ready || loading }" :cancel-text="t('common.cancel')" @ok="submit" @cancel="emit('update:open', false)">
    <a-divider orientation="left" plain>{{ t('distribute.schedule') }}</a-divider>
    <a-space wrap>
      <a-radio-group v-model:value="form.when" @change="onWhen">
        <a-radio value="now">{{ t('distribute.now') }}</a-radio>
        <a-radio value="at">{{ t('content.batchPublish.sameTime') }}</a-radio>
      </a-radio-group>
      <a-date-picker v-if="form.when === 'at'" v-model:value="form.at" show-time format="YYYY-MM-DD HH:mm" :disabled-date="pastDay" />
    </a-space>
    <template v-if="postTypes.length > 1">
      <a-divider orientation="left" plain>{{ t('distribute.postType') }}</a-divider>
      <a-radio-group v-model:value="form.postType" button-style="solid">
        <a-radio-button v-for="pt in postTypes" :key="pt" :value="pt">{{ t(`publish.type.${pt}`) }}</a-radio-button>
      </a-radio-group>
      <a-alert v-if="form.postType === 'story'" type="info" show-icon :message="t('distribute.storyNoCaption')" style="margin-top: 8px" />
    </template>
    <div class="drafts"><a-checkbox v-model:checked="form.includeDrafts">{{ t('content.batchPublish.includeDrafts') }}</a-checkbox></div>

    <a-divider orientation="left" plain>{{ t('content.batchPublish.summary') }}</a-divider>
    <a-spin :spinning="loading">
      <template v-if="preview">
        <p><b>{{ t('content.batchPublish.willPublish', { n: items.length, tasks }) }}</b></p>
        <ul v-if="items.length" class="list">
          <li v-for="x in items" :key="x.id">{{ title(x.id) }} <span class="muted">× {{ t('content.batchPublish.accounts', { n: x.accounts }) }}</span></li>
        </ul>
        <template v-if="preview.skipped.length">
          <p class="skip-head">{{ t('content.batchPublish.willSkip', { n: preview.skipped.length }) }}</p>
          <ul class="list">
            <li v-for="x in preview.skipped" :key="x.id">{{ title(x.id) }}: <span class="muted">{{ reason(x) }}</span></li>
          </ul>
        </template>
      </template>
    </a-spin>
    <div class="muted small">{{ t('content.batchPublish.checkHint') }}</div>
    <a-alert type="warning" show-icon :message="t('distribute.liveNotice')" style="margin-top: 12px" />
  </a-modal>
</template>

<style scoped>
.list { padding-inline-start: 18px; margin: 0 0 8px; max-height: 200px; overflow: auto; }
.skip-head { margin: 8px 0 4px; color: var(--cp-warning); }
.drafts { margin-top: 12px; }
</style>
