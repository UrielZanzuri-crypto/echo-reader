import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PROJECT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = 4400 + (process.pid % 200) // avoid clashing with a running instance

/** Start the server over a throwaway directory and wait for it to answer. */
async function startServer() {
  const root = await mkdtemp(join(tmpdir(), 'echo-serve-'))
  await writeFile(join(root, 'index.html'), '<!doctype html><title>root</title>')
  await writeFile(join(root, 'app.mjs'), 'export const x = 1')
  await mkdir(join(root, 'nested'), { recursive: true })
  await writeFile(join(root, 'nested', 'index.html'), '<!doctype html><title>nested</title>')
  await writeFile(join(root, 'map.bcmap'), 'binary-ish')
  // A file next to the served root, which must stay unreachable.
  await writeFile(join(root, '..', 'echo-serve-secret.txt'), 'SECRET')

  const child = spawn(
    process.execPath,
    ['scripts/serve.mjs', '--root', root, '--port', String(PORT), '--quiet', '--idle-hours', '0'],
    { cwd: PROJECT, stdio: ['ignore', 'pipe', 'pipe'] }
  )
  const stderr = []
  child.stderr.on('data', (b) => stderr.push(String(b)))

  const base = `http://127.0.0.1:${PORT}`
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`${base}/__echo-reader`)
      if (r.ok) return { child, base, root, stderr }
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 50))
  }
  child.kill('SIGKILL')
  throw new Error(`server never started: ${stderr.join('')}`)
}

test('static server: serves files, blocks escapes, survives malformed requests', async (t) => {
  const { child, base, root, stderr } = await startServer()
  t.after(async () => {
    child.kill('SIGKILL')
    await rm(root, { recursive: true, force: true }).catch(() => {})
    await rm(join(root, '..', 'echo-serve-secret.txt'), { force: true }).catch(() => {})
  })

  await t.test('serves index.html at the root', async () => {
    const res = await fetch(`${base}/`)
    assert.equal(res.status, 200)
    assert.match(res.headers.get('content-type'), /text\/html/)
    assert.match(await res.text(), /<title>root<\/title>/)
    // HTML must not be cached, so a rebuild shows up on reload.
    assert.equal(res.headers.get('cache-control'), 'no-cache')
  })

  await t.test('serves a directory index', async () => {
    const res = await fetch(`${base}/nested/`)
    assert.equal(res.status, 200)
    assert.match(await res.text(), /nested/)
  })

  await t.test('gives the pdf.js assets types the browser accepts', async () => {
    const mjs = await fetch(`${base}/app.mjs`)
    assert.match(mjs.headers.get('content-type'), /text\/javascript/)
    const bcmap = await fetch(`${base}/map.bcmap`)
    assert.equal(bcmap.headers.get('content-type'), 'application/octet-stream')
  })

  await t.test('refuses to serve anything outside the root', async () => {
    for (const path of [
      '/%2e%2e/echo-serve-secret.txt',
      '/nested/%2e%2e/%2e%2e/echo-serve-secret.txt',
      '/..%2fecho-serve-secret.txt',
      '/%2e%2e%2f%2e%2e%2fetc/passwd',
    ]) {
      const res = await fetch(`${base}${path}`)
      assert.ok(res.status === 403 || res.status === 404, `${path} returned ${res.status}`)
      assert.ok(!(await res.text()).includes('SECRET'), `${path} leaked the file`)
    }
  })

  await t.test('answers 404 for a missing file rather than crashing', async () => {
    assert.equal((await fetch(`${base}/nope.txt`)).status, 404)
  })

  await t.test('rejects writes', async () => {
    const res = await fetch(`${base}/`, { method: 'POST' })
    assert.equal(res.status, 405)
  })

  await t.test('stays up after requests that used to kill it', async () => {
    // A bare "//" threw inside new URL(); bad percent-encoding throws in decodeURIComponent.
    for (const path of ['//', '/%', '/%zz', '/%00', '//..//']) {
      const res = await fetch(`${base}${path}`).catch(() => null)
      assert.ok(res, `${path} killed the connection`)
      assert.ok(res.status < 500, `${path} returned ${res.status}`)
    }
    // Still serving afterwards.
    assert.equal((await fetch(`${base}/`)).status, 200)
    assert.ok(!stderr.join('').includes('ERR_INVALID_URL'), 'server logged a crash')
  })
})
