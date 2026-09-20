import { defineConfig } from 'vite'
import { createReadStream, statSync } from 'node:fs'
import { join, normalize, resolve, sep } from 'node:path'

const MODELS_DIR = resolve(process.cwd(), 'models')

/**
 * Serve models/ at /models during `npm run dev`. They deliberately live outside
 * public/, because copying ~580 MB into dist/ on every build left Spotlight
 * re-indexing over a gigabyte and made the whole machine crawl.
 */
function serveModels() {
  return {
    name: 'serve-models',
    configureServer(server) {
      server.middlewares.use('/models', (req, res, next) => {
        const path = decodeURIComponent((req.url || '/').split('?')[0])
        const file = join(MODELS_DIR, normalize(path).replace(/^(\.\.[/\\])+/, ''))
        if (!file.startsWith(MODELS_DIR + sep)) return next()
        try {
          const info = statSync(file)
          if (!info.isFile()) return next()
          res.setHeader('Content-Length', info.size)
          res.setHeader('Content-Type', file.endsWith('.json') ? 'application/json' : file.endsWith('.wasm') ? 'application/wasm' : file.endsWith('.mjs') ? 'text/javascript' : 'application/octet-stream')
          createReadStream(file).pipe(res)
        } catch {
          next()
        }
      })
    },
  }
}

export default defineConfig({
  plugins: [serveModels()],
  // Relative base so the built app works from any folder / any static server.
  base: './',
  // The Kokoro worker dynamically imports the library, so it must be an ES worker;
  // the default IIFE format cannot code-split.
  worker: { format: 'es' },
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
