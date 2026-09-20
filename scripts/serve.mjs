/**
 * A dependency-free static server for dist/.
 *
 * The built app cannot be opened as a file:// URL -- ES modules and the pdf.js web
 * worker are both blocked under that origin -- so double-clicking the launcher
 * starts this instead. It binds to the loopback interface only: nothing on the
 * network can reach it.
 *
 *   node scripts/serve.mjs [--root dist] [--port 4173] [--open] [--idle-hours 6]
 *
 * While running it writes .echo-reader.json (port + pid) so a second launch can
 * find the server already running and just open a browser tab at it.
 */

import { createServer } from 'node:http'
import { createReadStream } from 'node:fs'
import { stat, writeFile, unlink } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { dirname, extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const STATE_FILE = join(ROOT, '.echo-reader.json')

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback
}
const has = (name) => args.includes(`--${name}`)

const PUBLIC_DIR = resolve(ROOT, flag('root', 'dist'))
/**
 * The neural voice weights are hundreds of megabytes. Copying them into dist/ on
 * every build gave Spotlight ~1.2 GB to re-index and brought the machine to its
 * knees, so they live outside the build and are served straight from here.
 */
const MODELS_DIR = resolve(ROOT, 'models')
const FIRST_PORT = Number(flag('port', 4173))
const LAST_PORT = FIRST_PORT + 20
const IDLE_MS = Number(flag('idle-hours', 6)) * 3600_000

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.pfb': 'application/octet-stream', // pdf.js standard fonts
  '.bcmap': 'application/octet-stream', // pdf.js character maps
  '.txt': 'text/plain; charset=utf-8',
  '.pdf': 'application/pdf',
}

let lastRequestAt = Date.now()

/**
 * Path of the file a request is asking for, or null if the request is malformed
 * or is trying to escape dist/. Deliberately does not use `new URL()`, which
 * throws on inputs a browser can and does send (a bare "//", for one).
 */
function resolveRequestPath(rawUrl) {
  const path = String(rawUrl || '/').split(/[?#]/)[0]
  let decoded
  try {
    decoded = decodeURIComponent(path)
  } catch {
    return null // invalid percent-encoding
  }
  if (decoded.includes('\0')) return null

  // Strip the leading slash so the prefix test below sees a relative path.
  const relative = normalize(decoded)
    .replace(/^(\.\.[/\\])+/, '')
    .replace(/^[/\\]+/, '')

  // /models/... is served from outside the build; everything else from dist/.
  const base = relative === 'models' || relative.startsWith(`models${sep}`) ? ROOT : PUBLIC_DIR
  const file = join(base, relative)
  const allowed = base === ROOT ? MODELS_DIR : PUBLIC_DIR
  // Refuse anything that escapes the directory it claimed to be in.
  if (file !== allowed && !file.startsWith(allowed + sep)) return null
  return file
}

const server = createServer(async (req, res) => {
  lastRequestAt = Date.now()

  try {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' }).end('Method Not Allowed')
      return
    }

    // A cheap endpoint the launcher pings to tell "our server" from "something
    // else already on this port".
    if (req.url === '/__echo-reader') {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"app":"echo-reader"}')
      return
    }

    const file = resolveRequestPath(req.url)
    if (!file) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Forbidden')
      return
    }

    await send(req, res, file)
  } catch (err) {
    // A bad request must never be able to take the server down.
    console.error('request failed:', err?.message || err)
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' })
    res.end('Server error')
  }
})

async function send(req, res, requested) {
  let file = requested
  try {
    let info = await stat(file)
    if (info.isDirectory()) {
      file = join(file, 'index.html')
      info = await stat(file)
    }

    const type = TYPES[extname(file).toLowerCase()] || 'application/octet-stream'
    // The HTML is never cached, so a rebuild is picked up on reload; the assets
    // beside it are content-hashed by Vite and safe to keep.
    const cache = file.endsWith('.html') ? 'no-cache' : 'public, max-age=3600'

    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': info.size,
      'Cache-Control': cache,
    })
    if (req.method === 'HEAD') {
      res.end()
      return
    }

    const stream = createReadStream(file)
    stream.on('error', () => res.destroy())
    res.on('close', () => stream.destroy())
    stream.pipe(res)
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found')
  }
}

/**
 * Take the first free port in the range; another copy may already hold one.
 * Binds both loopback addresses: Chrome resolves "localhost" to ::1 first and
 * reports "refused to connect" if only 127.0.0.1 is listening.
 */
const server6 = createServer(server.listeners('request')[0])
server6.on('clientError', (err, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
})

function listen(port) {
  return new Promise((resolvePort, reject) => {
    const fail = (err) => {
      if (err.code === 'EADDRINUSE' && port < LAST_PORT) {
        server.close()
        server6.close()
        listen(port + 1).then(resolvePort, reject)
      } else reject(err)
    }
    server.once('error', fail)
    // Loopback only: this is a personal reader, not a web service.
    server.listen(port, '127.0.0.1', () => {
      server6.once('error', (err) => {
        // No IPv6 loopback on this machine: IPv4 alone is fine.
        if (err.code === 'EADDRNOTAVAIL' || err.code === 'EAFNOSUPPORT') resolvePort(port)
        else fail(err)
      })
      server6.listen(port, '::1', () => resolvePort(port))
    })
  })
}

async function shutdown(code = 0) {
  if (advertise) await unlink(STATE_FILE).catch(() => {})
  server6.close()
  server.close(() => process.exit(code))
  // Do not hang on a browser holding a keep-alive socket open.
  setTimeout(() => process.exit(code), 1000).unref()
}

try {
  await stat(join(PUBLIC_DIR, 'index.html'))
} catch {
  console.error(`${PUBLIC_DIR}/index.html is missing -- run \`npm run build\` first.`)
  process.exit(1)
}

const port = await listen(FIRST_PORT)
const url = `http://localhost:${port}/`
// Only the real app server advertises itself; a test server over some other
// root must not make the launcher think Echo Reader is running there.
const advertise = !args.includes('--root')
if (advertise) await writeFile(STATE_FILE, JSON.stringify({ port, pid: process.pid, url }, null, 2))

if (!has('quiet')) console.log(`Echo Reader is being served at ${url}`)
if (has('open')) spawn('open', [url], { stdio: 'ignore', detached: true }).unref()

// Stop on its own eventually, so a forgotten double-click does not leave a
// process running until the next reboot.
if (IDLE_MS > 0) {
  setInterval(() => {
    if (Date.now() - lastRequestAt > IDLE_MS) {
      if (!has('quiet')) console.log('Idle for too long, shutting down.')
      shutdown(0)
    }
  }, 60_000).unref()
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => shutdown(0))

// Last line of defence: stay up, log, and keep serving.
server.on('clientError', (err, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
})
process.on('uncaughtException', (err) => console.error('uncaught:', err?.stack || err))
process.on('unhandledRejection', (err) => console.error('unhandled rejection:', err))
