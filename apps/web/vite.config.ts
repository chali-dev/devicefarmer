import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [vue()],
  // vue-i18n esm-bundler feature flags: Composition API only, no devtools in production.
  define: {
    __VUE_I18N_FULL_INSTALL__: true,
    __VUE_I18N_LEGACY_API__: false,
    __INTLIFY_PROD_DEVTOOLS__: false,
  },
  server: {
    port: 5173,
    // The browser only ever talks to our API (RBAC gateway); STF is never exposed.
    proxy: {
      '/api': { target: 'http://127.0.0.1:3000', ws: true },
    },
  },
})
