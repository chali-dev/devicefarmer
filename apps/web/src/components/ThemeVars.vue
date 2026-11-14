<script setup lang="ts">
import { watchEffect } from 'vue'
import { theme } from 'ant-design-vue'
import { isDark } from '../theme'

/**
 * Publishes the current Ant Design tokens as CSS custom properties (--cp-*) on :root,
 * so scoped styles and the global body background follow the light/dark theme.
 * Must be rendered inside <a-config-provider>.
 */
const { token } = theme.useToken()

watchEffect(() => {
  const t = token.value
  const vars: Record<string, string> = {
    '--cp-bg-layout': t.colorBgLayout,
    '--cp-bg-container': t.colorBgContainer,
    '--cp-text': t.colorText,
    '--cp-text-secondary': t.colorTextSecondary,
    '--cp-text-tertiary': t.colorTextTertiary,
    '--cp-text-quaternary': t.colorTextQuaternary,
    '--cp-border-secondary': t.colorBorderSecondary,
    '--cp-fill-alter': t.colorFillAlter,
    '--cp-bg-hover': t.colorBgTextHover,
    '--cp-primary': t.colorPrimary,
    '--cp-primary-bg': t.colorPrimaryBg,
    '--cp-error': t.colorError,
    '--cp-warning': t.colorWarning,
    '--cp-mask': t.colorBgMask,
  }
  const root = document.documentElement
  for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v)
  root.style.colorScheme = isDark.value ? 'dark' : 'light'
  root.dataset.theme = isDark.value ? 'dark' : 'light'
})
</script>

<template><slot /></template>
