import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { cloudflare } from '@cloudflare/vite-plugin'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    cloudflare(),
    VitePWA({
      // 'prompt' e não 'autoUpdate': o service worker novo FICA ESPERANDO em vez
      // de assumir na hora. Quem decide é o main.jsx — que aplica na hora pra
      // todo mundo, menos quando a impressora Bluetooth do celular está ligada
      // (aí o reload mataria a conexão no meio do movimento).
      registerType: 'prompt',
      injectRegister: null, // registramos manualmente em main.jsx (com checagem periódica)
      devOptions: { enabled: false },
      includeAssets: ['favicon.png', 'apple-touch-icon.png', 'pwa-192.png', 'pwa-512.png'],
      manifest: {
        name: 'FWC Inter',
        short_name: 'FWC Inter',
        description: 'FWC Inter — tecnologia e soluções para o seu negócio',
        theme_color: '#863bff',
        background_color: '#1a1625',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/',
        scope: '/',
        lang: 'pt-BR',
        icons: [
          {
            src: 'pwa-192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'any',
          },
          {
            src: 'pwa-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any maskable',
          },
        ],
        shortcuts: [
          {
            name: 'Nova venda',
            url: '/vendas',
            description: 'Registrar nova venda',
          },
          {
            name: 'Caixa',
            url: '/caixa',
            description: 'Abrir ou fechar caixa',
          },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        navigateFallback: 'index.html',
        // /api/ping tem que sair pela rede SEMPRE. Se virasse index.html servido
        // do cache, ele responderia "ok" até com a internet caída — e a tela
        // culparia o servidor quando o problema é a conexão de quem está usando.
        //
        // E os LINKS QUE A LOJA MANDA PRO CLIENTE também saem pela rede. O
        // service worker guarda o index.html de quando o aparelho visitou a
        // primeira vez; se uma rota nova nasceu depois disso, ele serve a casca
        // velha, o React não acha a rota e a tela fica EM BRANCO — só depois de
        // atualizar é que aparece. Foi o que aconteceu com /local/ (o link de
        // confirmar o ponto no mapa): ninguém vai pedir pro cliente dar F5.
        navigateFallbackDenylist: [
          /^\/api\//,
          /^\/local\//,      // confirmar o ponto da entrega no mapa
          /^\/c\//,          // link do cliente
          /^\/mesa\//,       // QR da mesa
          /^\/pedido\//,     // acompanhar o pedido
        ],
        // Sem skipWaiting: é o main.jsx que manda o SKIP_WAITING na hora certa.
        clientsClaim: true,
        cleanupOutdatedCaches: true,
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/fonts\.googleapis\.com\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'google-fonts-cache',
              expiration: { maxEntries: 10, maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            urlPattern: /^https:\/\/[a-z]+\.supabase\.co\/.*/i,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'supabase-api',
              networkTimeoutSeconds: 10,
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
    }),
  ],
})
