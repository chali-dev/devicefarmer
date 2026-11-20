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
    // Overridable so parallel worktrees can run their own web + API pair.
    port: Number(process.env.WEB_PORT ?? 5173),
    // IPv4 loopback (Node resolves `localhost` to ::1 only): the dev gateway container reaches the Mac's
    // 127.0.0.1 through host.docker.internal. http://localhost:5173 keeps working.
    host: process.env.WEB_HOST ?? '127.0.0.1',
    // Local domain through the dev gateway (docker-compose.dev.yml profile `gateway`).
    allowedHosts: ['cloudphone.test'],
    // The browser only ever talks to our API (RBAC gateway); STF is never exposed.
    proxy: {
      '/api': { target: process.env.VITE_API_TARGET ?? 'http://127.0.0.1:3000', ws: true },
    },
  },
})
