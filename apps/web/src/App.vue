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
