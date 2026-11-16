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
/* Drawers declare fixed pixel widths; never let one be wider than the screen. */
.ant-drawer .ant-drawer-content-wrapper { max-width: 100vw; }
/* Let ellipsis text inside descriptions shrink instead of pushing the row wider. */
.ant-descriptions .ant-descriptions-item-content { min-width: 0; }
/* Tables without an explicit scroll.x: scroll inside the table rather than widening the page. */
.ant-table-wrapper .ant-table-container > .ant-table-content { overflow-x: auto; }
/* Narrow screens: inline filter forms wrap per item; keep wide pickers (date-time ranges) inside the viewport. */
@media (max-width: 640px) {
  .ant-form-inline .ant-form-item { max-width: 100%; }
  .ant-form-inline .ant-picker-range { max-width: 100%; }
  .ant-form-inline .ant-picker-range .ant-picker-input > input { min-width: 0; }
  /* Card titles with many header buttons: let the buttons wrap under the title instead of squeezing it away. */
  .ant-card .ant-card-head { padding-block: 8px; }
  .ant-card .ant-card-head .ant-card-head-wrapper { flex-wrap: wrap; row-gap: 8px; }
  .ant-card .ant-card-head .ant-card-head-title { flex: 1 0 auto; }
  .ant-card .ant-card-head .ant-card-extra { margin-inline-start: 0; max-width: 100%; }
}
</style>
