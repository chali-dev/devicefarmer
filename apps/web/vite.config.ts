import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5173,
    // The browser only ever talks to our API (RBAC gateway); STF is never exposed.
    proxy: {
      '/api': { target: 'http://127.0.0.1:3000', ws: true },
    },
  },
})
