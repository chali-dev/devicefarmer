<script setup lang="ts">
import { message } from 'ant-design-vue'
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { api, codeText, errorText } from '../../api/client'
import type { RequiredApp, RequiredTarget } from '../../api/types'
import { statusLabel } from '../common/status'
import { MODAL_WIDTH } from '../common/ui'

/**
 * 应用市场 → row 安装 (owner 2026-11-21 「安装按钮每个应用列都有，点击选设备批量安装」): the phones of the app's source
 * type, the app read live on each (GET /api/library/required/:id/targets); phones that have it are hidden (counted);
 * the picked ones get a `required-apps` task for this app (POST …/:id/install {instanceIds}), which asks the source's
 * app store to install it.
 */
const props = defineProps<{ app: RequiredApp | null; label: string }>()
const emit = defineEmits<{ close: [] }>()
const { t } = useI18n()

const devices = ref<RequiredTarget[]>([])
const loading = ref(false)
const submitting = ref(false)
const picked = ref<string[]>([])
const q = ref('')

watch(() => props.app, async (a) => {
  devices.value = []; picked.value = []; q.value = ''
  if (!a) return
  loading.value = true
  try {
    devices.value = (await api<{ devices: RequiredTarget[] }>('GET', `/api/library/required/${a.id}/targets`)).devices
    picked.value = devices.value.filter(selectable).map((d) => d.id)
  }
  catch (e) { message.error(errorText(e)) }
  finally { loading.value = false }
}, { immediate: true })

const selectable = (d: RequiredTarget) => d.state === 'missing'
const label = (d: RequiredTarget) => `${d.name} - ${d.users.length ? d.users.join(t('common.listSep')) : t('library.unassigned')}`
const okCount = computed(() => devices.value.filter((d) => d.state === 'installed').length)
const shown = computed(() => {
  const s = q.value.trim().toLowerCase()
  return devices.value.filter((d) => d.state !== 'installed' && (!s || label(d).toLowerCase().includes(s)))
    .sort((a, b) => Number(selectable(b)) - Number(selectable(a)))
})
const shownSelectable = computed(() => shown.value.filter(selectable).map((d) => d.id))
const allChecked = computed(() => shownSelectable.value.length > 0 && shownSelectable.value.every((id) => picked.value.includes(id)))
const someChecked = computed(() => !allChecked.value && shownSelectable.value.some((id) => picked.value.includes(id)))
function toggleAll(on: boolean) {
  const ids = new Set(shownSelectable.value)
  picked.value = on ? [...new Set([...picked.value, ...ids])] : picked.value.filter((id) => !ids.has(id))
}
function toggle(id: string, on: boolean) {
  picked.value = on ? [...picked.value, id] : picked.value.filter((x) => x !== id)
}

function note(d: RequiredTarget): string {
  if (d.state === 'installing') return t('library.state.installing')
  if (d.state === 'offline' || d.state === 'busy') {
    const why = d.reason === 'adb' ? t('library.reason.adb') : d.reason === 'probe' ? t('library.required.probeFailed') : d.reason ? statusLabel('instance', d.reason) : ''
    return `${t(`library.state.${d.state}`)}${why ? ` · ${why}` : ''}`
  }
  return ''
}

async function submit() {
  if (!props.app || !picked.value.length) return
  submitting.value = true
  try {
    const r = await api<{ taskIds: string[]; skipped: { id: string; code: string }[] }>('POST', `/api/library/required/${props.app.id}/install`, { instanceIds: picked.value })
    if (r.taskIds.length) message.success(t('library.required.installQueued', { n: r.taskIds.length }))
    if (r.skipped.length) message.warning(t('common.skipped', { n: r.skipped.length, reasons: [...new Set(r.skipped.map((s) => codeText(s.code, undefined, s.code)))].join(t('common.reasonSep')) }))
    emit('close')
  } catch (e) { message.error(errorText(e)) }
  finally { submitting.value = false }
}
</script>

<template>
  <a-modal :open="!!app" :width="MODAL_WIDTH.md" :title="t('library.required.installTitle', { name: app?.name ?? '', source: label })"
    :ok-text="picked.length ? t('library.installN', { n: picked.length }) : t('common.install')" :cancel-text="t('common.cancel')"
    :ok-button-props="{ disabled: !picked.length }" :confirm-loading="submitting" @ok="submit" @cancel="emit('close')">
    <a-spin :spinning="loading" :tip="t('library.required.reading')">
      <div class="bar">
        <a-checkbox :checked="allChecked" :indeterminate="someChecked" :disabled="!shownSelectable.length" @change="(e: any) => toggleAll(e.target.checked)">{{ t('library.selectAll') }}</a-checkbox>
        <a-input-search v-model:value="q" allow-clear :placeholder="t('library.searchDevices')" style="flex: 1" />
        <span class="muted">{{ t('library.selected', { n: picked.length }) }}</span>
      </div>
      <div class="list">
        <div v-for="d in shown" :key="d.id" class="row" :class="{ off: !selectable(d) }">
          <a-checkbox :checked="picked.includes(d.id)" :disabled="!selectable(d)" @change="(e: any) => toggle(d.id, e.target.checked)">{{ label(d) }}</a-checkbox>
          <span class="tags">
            <a-tag v-if="d.state === 'missing'" color="orange">{{ t('library.required.notInstalled') }}</a-tag>
            <span v-else-if="note(d)" class="muted">{{ note(d) }}</span>
          </span>
        </div>
        <a-empty v-if="!loading && !shown.length" :image-style="{ height: '40px' }" :description="t('library.required.noTargets')" />
      </div>
      <div v-if="okCount" class="muted small">{{ t('library.required.hiddenOk', { n: okCount }) }}</div>
    </a-spin>
  </a-modal>
</template>

<style scoped>
.bar { display: flex; align-items: center; gap: 12px; margin-bottom: 8px; }
.list { max-height: 360px; overflow-y: auto; border: 1px solid var(--cp-border); border-radius: var(--cp-radius); padding: 4px 8px; }
.row { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 6px 0; border-bottom: 1px solid var(--cp-border-secondary); }
.row:last-child { border-bottom: none; }
.tags { flex-shrink: 0; text-align: right; display: flex; align-items: center; gap: 4px; }
.tags :deep(.ant-tag) { margin-inline-end: 0; }
.small { font-size: 12px; margin-top: 6px; }
</style>
