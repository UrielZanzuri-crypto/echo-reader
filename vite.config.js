import { defineConfig } from 'vite'

export default defineConfig({
  // Relative base so the built app works from any folder / any static server.
  base: './',
  build: {
    target: 'es2022',
    outDir: 'dist',
    assetsInlineLimit: 0, // keep the pdf.js worker as a real file
  },
  server: {
    port: 5173,
    open: true,
  },
})
