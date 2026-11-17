<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import {
  BookOutlined, EllipsisOutlined, HeartOutlined, LeftOutlined, MessageOutlined, PictureOutlined, PlayCircleFilled, RightOutlined, SendOutlined,
} from '@ant-design/icons-vue'
import { useI18n } from 'vue-i18n'
import type { ContentMedia, MediaItem, PostType } from '../../api/types'
import { useThumbs } from '../media/media'

/**
 * 手机预览 (示意): an approximate Instagram post in a phone frame — 帖子 (feed: header, carousel, actions, caption with
 * "更多"), Reels (vertical full screen, caption overlay) and 限动 (full screen, progress bar, no caption). Pure front end;
 * images are the media thumbnails.
 */
const props = defineProps<{ media: ContentMedia[]; text: string; handle: string | null }>()
const mode = defineModel<PostType>('mode', { default: 'feed' })
const { t } = useI18n()

const thumbs = useThumbs()
const asItem = (m: ContentMedia) => ({ ...m, updatedAt: '' }) as unknown as MediaItem
watch(() => props.media, (m) => { void thumbs.load(m.map(asItem)) }, { immediate: true })
onBeforeUnmount(() => thumbs.dispose())

const index = ref(0)
watch(() => [props.media.length, mode.value], () => { index.value = Math.min(index.value, Math.max(props.media.length - 1, 0)) })
const current = computed(() => props.media[index.value])
const src = (m: ContentMedia | undefined) => (m ? thumbs.get(asItem(m)) : undefined)
const go = (d: number) => { index.value = Math.min(Math.max(index.value + d, 0), props.media.length - 1) }
/** Feed media box: the first item's ratio clamped to Instagram's 4:5 … 1.91:1. */
const ratio = computed(() => {
  const m = props.media[0]
  const r = m?.width && m.height ? m.width / m.height : 1
  return Math.min(Math.max(r, 0.8), 1.91)
})

const name = computed(() => props.handle ?? t('content.preview.handle'))
const initial = computed(() => name.value.slice(0, 1).toUpperCase())
const expanded = ref(false)
watch(() => [props.text, mode.value], () => { expanded.value = false })
const LIMIT = { feed: 120, reel: 60 } as const
const clipped = computed(() => {
  const max = mode.value === 'reel' ? LIMIT.reel : LIMIT.feed
  const lines = props.text.split('\n')
  if (expanded.value || (props.text.length <= max && lines.length <= 2)) return { text: props.text, more: false }
  const firstLines = lines.slice(0, 2).join('\n')
  return { text: (firstLines.length > max ? firstLines.slice(0, max) : firstLines).replace(/\s+$/, ''), more: true }
})
/** #hashtags and @mentions as links (colour only). */
const parts = (s: string) => s.split(/([#@][\p{L}\p{N}_.]+)/u).map((x) => ({ x, tag: /^[#@]/.test(x) }))
</script>

<template>
  <div class="pp">
    <div class="pp-head">
      <span class="muted small">{{ t('content.preview.title') }}</span>
      <a-segmented v-model:value="mode" size="small" :options="(['feed', 'reel', 'story'] as const).map((v) => ({ value: v, label: t(`publish.type.${v}`) }))" />
    </div>
    <div class="phone">
      <div class="notch" />
      <!-- 帖子 -->
      <div v-if="mode === 'feed'" class="screen feed">
        <div class="bar"><span class="avatar">{{ initial }}</span><b class="ellipsis">{{ name }}</b><EllipsisOutlined class="end" /></div>
        <div class="media" :style="{ aspectRatio: String(ratio) }">
          <img v-if="src(current)" :src="src(current)" alt="" />
          <PictureOutlined v-else class="ph" />
          <PlayCircleFilled v-if="current?.fileType === 'video'" class="play" />
          <template v-if="media.length > 1">
            <span class="count">{{ index + 1 }}/{{ media.length }}</span>
            <button v-if="index > 0" type="button" class="arrow left" :aria-label="t('content.moveUp')" @click="go(-1)"><LeftOutlined /></button>
            <button v-if="index < media.length - 1" type="button" class="arrow right" :aria-label="t('content.moveDown')" @click="go(1)"><RightOutlined /></button>
          </template>
        </div>
        <div class="actions">
          <HeartOutlined /><MessageOutlined /><SendOutlined />
          <span v-if="media.length > 1" class="dots"><i v-for="(m, i) in media" :key="m.id" :class="{ on: i === index }" /></span>
          <BookOutlined class="end" />
        </div>
        <div class="caption">
          <b>{{ name }}</b>&nbsp;<template v-for="(p, i) in parts(clipped.text)" :key="i"><span :class="{ tag: p.tag }">{{ p.x }}</span></template>
          <template v-if="clipped.more">… <a class="more" @click="expanded = true">{{ t('content.preview.more') }}</a></template>
        </div>
      </div>
      <!-- Reels / 限动 -->
      <div v-else class="screen full" @click="mode === 'story' && media.length > 1 ? go(index < media.length - 1 ? 1 : -index) : undefined">
        <img v-if="src(current)" :src="src(current)" alt="" class="cover" />
        <PictureOutlined v-else class="ph" />
        <PlayCircleFilled v-if="current?.fileType === 'video' && mode === 'reel'" class="play" />
        <template v-if="mode === 'story'">
          <div class="progress"><i v-for="i in Math.max(media.length, 1)" :key="i" :class="{ on: i - 1 <= index }" /></div>
          <div class="story-bar"><span class="avatar sm">{{ initial }}</span><b class="ellipsis">{{ name }}</b></div>
        </template>
        <template v-else>
          <div class="side"><HeartOutlined /><MessageOutlined /><SendOutlined /><EllipsisOutlined /></div>
          <div class="overlay">
            <div class="bar"><span class="avatar sm">{{ initial }}</span><b class="ellipsis">{{ name }}</b></div>
            <div class="caption">
              <template v-for="(p, i) in parts(clipped.text)" :key="i"><span :class="{ tag: p.tag }">{{ p.x }}</span></template>
              <template v-if="clipped.more">… <a class="more" @click.stop="expanded = true">{{ t('content.preview.more') }}</a></template>
            </div>
          </div>
          <span v-if="media.length > 1" class="count">{{ index + 1 }}/{{ media.length }}</span>
          <button v-if="index > 0" type="button" class="arrow left" :aria-label="t('content.moveUp')" @click.stop="go(-1)"><LeftOutlined /></button>
          <button v-if="index < media.length - 1" type="button" class="arrow right" :aria-label="t('content.moveDown')" @click.stop="go(1)"><RightOutlined /></button>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* Full-screen media surface and the text over it stay dark/light in both themes, as in Instagram itself. */
.pp { --pp-on-media: #fff; --pp-media-bg: #000; --pp-scrim: var(--cp-mask); display: flex; flex-direction: column; align-items: center; gap: 8px; }
.pp-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; width: 100%; max-width: 300px; flex-wrap: wrap; }
.phone {
  /* fits the drawer height: 9:19 at up to 300 × 633, smaller on short screens */
  position: relative; width: min(300px, 100%, calc((100vh - 200px) * 9 / 19)); min-width: 220px; aspect-ratio: 9 / 19; padding: 10px; border-radius: 36px;
  background: var(--cp-text); box-shadow: var(--cp-shadow);
}
.notch { position: absolute; top: 14px; left: 50%; width: 70px; height: 14px; margin-left: -35px; border-radius: 8px; background: var(--cp-text); z-index: 3; }
.screen { position: relative; width: 100%; height: 100%; border-radius: 28px; overflow: hidden; background: var(--cp-bg-container); color: var(--cp-text); font-size: 12px; }
.feed { overflow-y: auto; padding-top: 30px; scrollbar-width: none; }
.bar { display: flex; align-items: center; gap: 8px; padding: 6px 10px; min-width: 0; }
.end { margin-left: auto; }
.avatar {
  flex: none; width: 28px; height: 28px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center;
  background: var(--cp-primary-bg); color: var(--cp-primary); font-weight: 600; border: 2px solid var(--cp-primary);
}
.avatar.sm { width: 24px; height: 24px; font-size: 11px; }
.media { position: relative; width: 100%; background: var(--cp-fill-alter); display: flex; align-items: center; justify-content: center; }
.media img, .cover { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
.ph { font-size: 32px; color: var(--cp-text-quaternary); }
.full .ph { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); }
.play { position: absolute; font-size: 36px; color: var(--pp-on-media); opacity: 0.85; top: 50%; left: 50%; transform: translate(-50%, -50%); }
.count { position: absolute; top: 8px; right: 8px; padding: 0 6px; border-radius: 10px; font-size: 11px; background: var(--pp-scrim); color: var(--pp-on-media); }
.full .count { top: 40px; }
.arrow {
  position: absolute; top: 50%; transform: translateY(-50%); width: 22px; height: 22px; border: 0; border-radius: 50%; cursor: pointer;
  display: inline-flex; align-items: center; justify-content: center; font-size: 10px; background: var(--cp-bg-container); color: var(--cp-text); opacity: 0.85;
}
.arrow.left { left: 6px; }
.arrow.right { right: 6px; }
.actions { display: flex; align-items: center; gap: 14px; padding: 8px 10px 4px; font-size: 18px; position: relative; }
.dots { position: absolute; left: 50%; transform: translateX(-50%); display: flex; gap: 3px; }
.dots i, .progress i { display: block; border-radius: 3px; background: var(--cp-border); }
.dots i { width: 5px; height: 5px; }
.dots i.on { background: var(--cp-primary); }
.caption { padding: 2px 10px 12px; white-space: pre-wrap; word-break: break-word; line-height: 1.45; }
.tag { color: var(--cp-primary); }
.more { color: var(--cp-text-tertiary); }
.full { background: var(--pp-media-bg); color: var(--pp-on-media); }
.full .tag { color: var(--pp-on-media); font-weight: 600; }
.full .more { color: var(--pp-on-media); opacity: 0.75; }
.overlay { position: absolute; left: 0; right: 44px; bottom: 0; padding: 40px 0 8px; background: linear-gradient(to top, var(--pp-scrim), transparent); }
.overlay .bar { padding: 4px 10px; }
.overlay .caption { padding-bottom: 8px; }
.side { position: absolute; right: 10px; bottom: 24px; display: flex; flex-direction: column; gap: 16px; font-size: 20px; }
.progress { position: absolute; top: 32px; left: 10px; right: 10px; display: flex; gap: 3px; }
.progress i { flex: 1; height: 2px; background: var(--pp-scrim); }
.progress i.on { background: var(--pp-on-media); }
.story-bar { position: absolute; top: 40px; left: 10px; right: 10px; display: flex; align-items: center; gap: 8px; min-width: 0; text-shadow: 0 1px 2px var(--pp-scrim); }
</style>
