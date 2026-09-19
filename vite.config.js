import { defineConfig } from 'vite'

export default defineConfig({
  // Relative base so the built app works from any folder / any static server.
  base: './',
  resolve: {
    alias: {
      // kokoro-js imports these for its Node path; the browser never uses them.
      'fs/promises': '/spike/node-stub.js',
      path: '/spike/node-stub.js',
    },
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    assetsInlineLimit: 0, // keep the pdf.js worker as a real file
    rollupOptions: {
      input: {
        main: 'index.html',
        spike: 'spike/kokoro.html', // the voice comparison, kept out of the app bundle
      },
    },
  },
  server: {
    port: 5173,
    open: true,
  },
})
