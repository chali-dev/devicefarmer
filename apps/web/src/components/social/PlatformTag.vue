<script setup lang="ts">
import { FacebookOutlined, InstagramOutlined, PlaySquareOutlined, ShareAltOutlined, YoutubeOutlined } from '@ant-design/icons-vue'
import { computed } from 'vue'

/** Platform badge. Unknown (newly registered) platforms fall back to a generic icon and the raw id. */
const props = defineProps<{ platform: string; name?: string }>()
const ICONS: Record<string, unknown> = { instagram: InstagramOutlined, youtube: YoutubeOutlined, tiktok: PlaySquareOutlined, facebook: FacebookOutlined }
const NAMES: Record<string, string> = { instagram: 'Instagram', youtube: 'YouTube', tiktok: 'TikTok', facebook: 'Facebook' }
const icon = computed(() => ICONS[props.platform] ?? ShareAltOutlined)
</script>

<template>
  <a-tag class="platform-tag">
    <component :is="icon" />
    <span>{{ name ?? NAMES[platform] ?? platform }}</span>
  </a-tag>
</template>

<style scoped>
.platform-tag { display: inline-flex; align-items: center; gap: 4px; margin-inline-end: 0; }
</style>
