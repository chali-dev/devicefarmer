import { FacebookOutlined, InstagramOutlined, PlaySquareOutlined, ShareAltOutlined, YoutubeOutlined } from '@ant-design/icons-vue'
import type { Component } from 'vue'

/** Icon + display name per platform; unknown (newly registered) platforms get a generic icon and the raw id. */
const ICONS: Record<string, Component> = { instagram: InstagramOutlined, youtube: YoutubeOutlined, tiktok: PlaySquareOutlined, facebook: FacebookOutlined }
const NAMES: Record<string, string> = { instagram: 'Instagram', youtube: 'YouTube', tiktok: 'TikTok', facebook: 'Facebook' }
export const platformIcon = (p: string): Component => ICONS[p] ?? ShareAltOutlined
export const platformName = (p: string): string => NAMES[p] ?? p

/** Content text per platform: the hint field that overrides the body, and its length limit (API content schema). */
export const textField = (p: string): 'description' | 'caption' => (p === 'youtube' ? 'description' : 'caption')
const TEXT_MAX: Record<string, number> = { youtube: 5000, instagram: 2200, tiktok: 2200, facebook: 5000 }
export const textMax = (p: string | null | undefined): number => (p && TEXT_MAX[p]) || 5000
