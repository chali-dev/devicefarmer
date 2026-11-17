<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import type { PostType } from '../../api/types'

/** Post type badge (帖子 / Reels / 限动). */
defineProps<{ type: PostType }>()
const { t } = useI18n()
const COLORS: Record<PostType, string> = { feed: 'blue', reel: 'magenta', story: 'gold' }
</script>

<template>
  <a-tag :color="COLORS[type]" class="post-type-tag">{{ t(`publish.type.${type}`) }}</a-tag>
</template>

<style scoped>
.post-type-tag { margin-inline-end: 0; }
</style>
