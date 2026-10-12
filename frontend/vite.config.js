import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { lazyModuleUrls } from './build/lazyModuleUrls.mjs'

export default defineConfig({
  plugins: [lazyModuleUrls(), react()],
  build: { manifest: true },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:8000',
    },
  },
})
