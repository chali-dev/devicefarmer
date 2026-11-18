<script setup lang="ts">
import { computed, ref } from 'vue'
import { canonicalLang, COMMON_LANGS, langName } from '../../api/lang'

/**
 * One BCP-47 language (账号语言): the given languages first (e.g. 配置语系), then common ones; any other valid code
 * can be typed and is offered in its canonical form. Emits null when cleared.
 */
const props = withDefaults(defineProps<{ modelValue: string | null | undefined; extra?: string[]; placeholder?: string; allowClear?: boolean; size?: 'small' | 'middle' }>(), {
  extra: () => [], placeholder: undefined, allowClear: true, size: 'middle',
})
const emit = defineEmits<{ 'update:modelValue': [string | null] }>()
const typed = ref('')
const label = (l: string) => `${langName(l)} (${l})`
const options = computed(() => {
  const c = canonicalLang(typed.value)
  const list = [...new Set([...(props.modelValue ? [props.modelValue] : []), ...props.extra, ...COMMON_LANGS, ...(c ? [c] : [])])]
  return list.map((l) => ({ value: l, label: label(l) }))
})
const filterOption = (input: string, o?: { value: string; label: string }) => {
  const q = input.trim().toLowerCase()
  return !!o && (o.label.toLowerCase().includes(q) || o.value.toLowerCase().includes(q) || o.value === canonicalLang(input))
}
</script>

<template>
  <a-select :value="modelValue ?? undefined" show-search :allow-clear="allowClear" :size="size" :options="options" :filter-option="filterOption" :placeholder="placeholder"
    @search="(v: string) => (typed = v)" @change="(v: unknown) => { typed = ''; emit('update:modelValue', typeof v === 'string' ? v : null) }" />
</template>
