import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  base: './', // относительные пути нужны, чтобы сборка открывалась внутри APK
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: 'Nextouch Пульт',
        short_name: 'Пульт',
        lang: 'ru',
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#e6e9ed',
        theme_color: '#0e7c86',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
        ],
      },
    }),
  ],
});
