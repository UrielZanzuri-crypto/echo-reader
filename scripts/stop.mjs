/** Stop the background server started by the launcher (npm run stop). */
import { readFile, unlink } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const STATE = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), '.echo-reader.json')

try {
  const { pid, url } = JSON.parse(await readFile(STATE, 'utf8'))
  process.kill(pid, 'SIGTERM')
  console.log(`Stopped the server at ${url} (pid ${pid}).`)
} catch (err) {
  if (err.code === 'ENOENT') console.log('No server is running.')
  else if (err.code === 'ESRCH') {
    await unlink(STATE).catch(() => {})
    console.log('No server is running (cleared a stale state file).')
  } else throw err
}
