import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'
import { resolve } from 'path'
import { fileURLToPath } from 'url'

const __dirname = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  base: '/cameralink/',
  resolve: {
    alias: {
      // shared-protocol 패키지를 TypeScript 소스로 직접 해석
      // node_modules의 file: 링크 대신 소스를 직접 번들링
      'shared-protocol': resolve(__dirname, '../shared-protocol/src'),
    }
  },
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,wasm}'],
        navigateFallback: '/cameralink/index.html',
      },
      manifest: {
        name: 'CameraLink 수신기',
        short_name: 'CameraLink',
        description: 'QR 광학 파일 수신기',
        theme_color: '#000000',
        background_color: '#000000',
        display: 'standalone',
        start_url: '/cameralink/',
        icons: [
          { src: '/cameralink/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/cameralink/icons/icon-512.png', sizes: '512x512', type: 'image/png' }
        ]
      }
    })
  ]
})
