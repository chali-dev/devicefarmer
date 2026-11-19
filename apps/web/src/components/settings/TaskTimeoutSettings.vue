<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { message } from 'ant-design-vue'
import { useI18n } from 'vue-i18n'
import { api, errorText } from '../../api/client'

/**
 * 系统配置 → 任务超时 (admin, owner 2026-11-19 「一个配置一行」): the timeout of one attempt per task type, one row each
 * with its own 保存 (PUT /api/settings/task-timeouts/:type; an empty input = back to the default). Applies to tasks
 * created from then on.
 */
interface Item { type: string; timeoutMin: number | null; defaultMin: number | null; custom: boolean; min: number; max: number }

const { t } = useI18n()
const items = ref<Item[]>([])
const values = reactive<Record<string, number | null>>({})
const busy = reactive<Record<string, boolean>>({})

function fill(r: { items: Item[] }) {
  items.value = r.items
  for (const i of r.items) values[i.type] = i.timeoutMin
}
onMounted(async () => { try { fill(await api('GET', '/api/settings/task-timeouts')) } catch (e) { message.error(errorText(e)) } })

async function save(i: Item) {
  busy[i.type] = true
  try {
    const v = values[i.type]
    fill(await api('PUT', `/api/settings/task-timeouts/${i.type}`, { timeoutMin: v ?? null }))
    message.success(t('common.saved'))
  } catch (e) { message.error(errorText(e)) }
  finally { busy[i.type] = false }
}
</script>

<template>
  <a-spin :spinning="!items.length">
    <div class="timeouts">
      <div v-for="i in items" :key="i.type" class="row">
        <span class="label">{{ t(`settings.timeouts.types.${i.type}`) }}</span>
        <a-input-number
          v-model:value="values[i.type]" :min="i.min" :max="i.max" :precision="0" :addon-after="t('settings.timeouts.min')"
          :placeholder="i.defaultMin === null ? t('settings.timeouts.none') : String(i.defaultMin)" style="width: 160px"
        />
        <a-button type="primary" size="small" :loading="busy[i.type]" @click="save(i)">{{ t('common.save') }}</a-button>
        <span v-if="i.custom" class="muted small">{{ i.defaultMin === null ? t('settings.timeouts.defaultNone') : t('settings.timeouts.default', { n: i.defaultMin }) }}</span>
      </div>
    </div>
  </a-spin>
</template>

<style scoped>
.timeouts { display: flex; flex-direction: column; gap: 12px; }
.row { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 12px; }
.label { width: 140px; flex: none; color: var(--cp-text); }
</style>
