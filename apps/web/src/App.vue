<script setup lang="ts">
import { antdLocale } from './i18n'
import { antdThemeConfig } from './theme'
import ThemeVars from './components/ThemeVars.vue'
</script>

<template>
  <a-config-provider :locale="antdLocale" :theme="antdThemeConfig">
    <ThemeVars>
      <router-view />
    </ThemeVars>
  </a-config-provider>
</template>

<style>
:root {
  /* Light defaults until ThemeVars publishes the live Ant Design tokens. */
  --cp-bg-layout: #f5f5f5;
  --cp-bg-container: #fff;
  --cp-text: rgba(0, 0, 0, 0.88);
  --cp-text-secondary: rgba(0, 0, 0, 0.65);
  --cp-text-tertiary: rgba(0, 0, 0, 0.45);
  --cp-text-quaternary: rgba(0, 0, 0, 0.25);
  --cp-border-secondary: #f0f0f0;
  --cp-fill-alter: rgba(0, 0, 0, 0.02);
  --cp-bg-hover: rgba(0, 0, 0, 0.06);
  --cp-primary: #1677ff;
  --cp-primary-bg: #e6f4ff;
}
body { margin: 0; background: var(--cp-bg-layout); color: var(--cp-text); }
</style>
