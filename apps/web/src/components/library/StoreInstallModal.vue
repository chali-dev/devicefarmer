<script setup lang="ts">
import { message } from 'ant-design-vue'
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { api, codeText, errorText } from '../../api/client'
import type { RequiredApp } from '../../api/types'
import { useInstancesStore } from '../../stores/instances'
import { MODAL_WIDTH } from '../common/ui'

/**
 * 云机管理 → 安装应用 (owner 2026-11-21 「安装应用显示应用市场的包」, admin): the 应用市场 list of the picked phones'
 * source types; pick apps → per app POST /api/library/required/:id/install with the phones of its source type.
 * One phone: each app read live on it (GET /api/library/required/device/:id → 已安装 / 安装中 / 未安装).
 */
const props = defineProps<{ instanceIds: string[] | null }>()
const emit = defineEmits<{ close: [] }>()
const { t } = useI18n()
const store = useInstancesStore()

const apps = ref<RequiredApp[]>([])
const state = ref<Record<string, { installed: boolean | null; installing: boolean }>>({})
const loading = ref(false)
const submitting = ref(false)
const picked = ref<string[]>([])

const devices = computed(() => (props.instanceIds ?? []).map((id) => store.byId.get(id)).filter((d) => !!d))
const single = computed(() => (devices.value.length === 1 ? devices.value[0]! : null))
const title = computed(() => t('devices.storeInstall.title', { target: single.value?.name ?? t('devices.nDevices', { n: devices.value.length }) }))

watch(() => props.instanceIds, async (ids) => {
  apps.value = []; state.value = {}; picked.value = []
  if (!ids?.length) return
  loading.value = true
  try {
    const engines = new Set(devices.value.map((d) => d.engine))
    const r = await api<{ apps: RequiredApp[] }>('GET', '/api/library/required')
    apps.value = r.apps.filter((a) => engines.has(a.sourceType as never))
    if (ids.length === 1) {
      const s = await api<{ apps: { id: string; installed: boolean | null; installing: boolean }[] }>('GET', `/api/library/required/device/${ids[0]}`)
      state.value = Object.fromEntries(s.apps.map((a) => [a.id, a]))
    }
    picked.value = apps.value.filter(selectable).filter((a) => ids.length > 1 || state.value[a.id]?.installed === false).map((a) => a.id)
  } catch (e) { message.error(errorText(e)) }
  finally { loading.value = false }
}, { immediate: true })

/** One phone: only apps it lacks (or couldn't be read) and that aren't being installed. */
function selectable(a: RequiredApp) {
  const s = state.value[a.id]
  return !single.value || !s || (!s.installed && !s.installing)
}
function stateTag(a: RequiredApp): { color: string; text: string } | null {
  const s = state.value[a.id]
  if (!single.value || !s) return null
  if (s.installed) return { color: 'green', text: t('devices.storeInstall.installed') }
  if (s.installing) return { color: 'processing', text: t('library.state.installing') }
  if (s.installed === false) return { color: 'orange', text: t('library.required.notInstalled') }
  return { color: 'default', text: t('devices.storeInstall.unknown') }
}
function toggle(id: string, on: boolean) { picked.value = on ? [...picked.value, id] : picked.value.filter((x) => x !== id) }

async function submit() {
  if (!picked.value.length) return
  submitting.value = true
  try {
    let queued = 0
    const skipped: string[] = []
    for (const a of apps.value.filter((x) => picked.value.includes(x.id))) {
      const ids = devices.value.filter((d) => d.engine === a.sourceType).map((d) => d.id)
      if (!ids.length) continue
      const r = await api<{ taskIds: string[]; skipped: { id: string; code: string }[] }>('POST', `/api/library/required/${a.id}/install`, { instanceIds: ids })
      queued += r.taskIds.length
      skipped.push(...r.skipped.map((s) => s.code))
    }
    if (queued) message.success(t('library.required.installQueued', { n: queued }))
    if (skipped.length) message.warning(t('common.skipped', { n: skipped.length, reasons: [...new Set(skipped.map((c) => codeText(c, undefined, c)))].join(t('common.reasonSep')) }))
    emit('close')
  } catch (e) { message.error(errorText(e)) }
  finally { submitting.value = false }
}
</script>

<template>
  <a-modal :open="!!instanceIds?.length" :width="MODAL_WIDTH.sm" :title="title"
    :ok-text="picked.length ? t('devices.storeInstall.installN', { n: picked.length }) : t('common.install')" :cancel-text="t('common.cancel')"
    :ok-button-props="{ disabled: !picked.length }" :confirm-loading="submitting" @ok="submit" @cancel="emit('close')">
    <a-spin :spinning="loading">
      <div class="muted small hint">{{ t('devices.storeInstall.hint') }}</div>
      <div class="list">
        <div v-for="a in apps" :key="a.id" class="row">
          <a-checkbox :checked="picked.includes(a.id)" :disabled="!selectable(a)" @change="(e: any) => toggle(a.id, e.target.checked)">
            {{ a.name }} <span class="muted mono small">{{ a.package }}</span>
          </a-checkbox>
          <a-tag v-if="stateTag(a)" :color="stateTag(a)!.color">{{ stateTag(a)!.text }}</a-tag>
        </div>
        <a-empty v-if="!loading && !apps.length" :image-style="{ height: '40px' }" :description="t('devices.storeInstall.empty')" />
      </div>
    </a-spin>
  </a-modal>
</template>

<style scoped>
.hint { margin-bottom: 8px; }
.list { max-height: 360px; overflow-y: auto; border: 1px solid var(--cp-border); border-radius: var(--cp-radius); padding: 4px 8px; }
.row { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 6px 0; border-bottom: 1px solid var(--cp-border-secondary); }
.row:last-child { border-bottom: none; }
.row :deep(.ant-tag) { margin-inline-end: 0; }
.small { font-size: 12px; }
</style>
