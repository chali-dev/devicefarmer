<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { getToken, responseError, errorText } from '../../api/client'
import { MODAL_WIDTH } from '../common/ui'

/** Screenshot the cloud phone took for a reply (test-mode run or device send), loaded with the session token. */
const open = defineModel<boolean>('open', { required: true })
const props = defineProps<{ replyId: string | null }>()
const { t } = useI18n()
const src = ref<string | null>(null)
const error = ref<string | null>(null)

function setSrc(url: string | null) { if (src.value) URL.revokeObjectURL(src.value); src.value = url }
watch(() => [open.value, props.replyId] as const, async ([o, id]) => {
  setSrc(null); error.value = null
  if (!o || !id) return
  try {
    const res = await fetch(`/api/comment-replies/${id}/evidence`, { headers: { authorization: `Bearer ${getToken()}` } })
    if (!res.ok) throw await responseError(res)
    setSrc(URL.createObjectURL(await res.blob()))
  } catch (e) { error.value = errorText(e) }
}, { immediate: true })
onBeforeUnmount(() => setSrc(null))
</script>

<template>
  <a-modal v-model:open="open" :title="t('feed.evidenceTitle')" :width="MODAL_WIDTH.sm" :footer="null">
    <a-alert v-if="error" type="error" :message="error" />
    <a-spin v-else :spinning="!src">
      <img v-if="src" :src="src" :alt="t('feed.evidenceTitle')" class="shot">
      <div v-else class="placeholder" />
    </a-spin>
  </a-modal>
</template>

<style scoped>
.shot { display: block; max-width: 100%; max-height: 70vh; margin: 0 auto; border-radius: var(--cp-radius); }
.placeholder { height: 240px; }
</style>
