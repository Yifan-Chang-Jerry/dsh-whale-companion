/** Materialize the pinned, public Harness source and install its locked dependencies. */
import { existsSync } from 'node:fs'
import { mkdir, cp, copyFile } from 'node:fs/promises'
import { execFileSync, spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { root, runtime, harness, upstream, run } from './runtime.mjs'

const [major, minor] = process.versions.node.split('.').map(Number)
if (major < 24 || major === 24 && minor < 9) throw new Error('Node.js >=24.9.0 is required')
const pnpmVersion = execFileSync('pnpm', ['--version'], { encoding: 'utf8' }).trim()
if (pnpmVersion !== upstream.pnpm) throw new Error(`Install pnpm ${upstream.pnpm}; found ${pnpmVersion}`)
await mkdir(runtime, { recursive: true })
if (!existsSync(join(harness, '.git'))) {
  await mkdir(harness, { recursive: true })
  await run('git', ['init', '--quiet'], harness)
}
const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: harness, encoding: 'utf8' })
if (head.status !== 0) {
  await run('git', ['fetch', '--depth', '1', upstream.repository, upstream.revision])
  await run('git', ['checkout', '--detach', 'FETCH_HEAD'])
} else if (head.stdout.trim() !== upstream.revision) {
  throw new Error('The runtime checkout has a different revision; move .runtime/harness aside before setup')
}
const patch = join(root, 'patches/dsh-companion.patch')
if (spawnSync('git', ['apply', '--check', patch], { cwd: harness }).status === 0) {
  await run('git', ['apply', patch])
} else if (spawnSync('git', ['apply', '--reverse', '--check', patch], { cwd: harness }).status !== 0) {
  throw new Error('The integration patch conflicts with local runtime changes; move .runtime/harness aside before setup')
}
await cp(join(root, 'overlay'), harness, { recursive: true })
await run('pnpm', ['install', '--frozen-lockfile'])
await mkdir(join(runtime, 'tools'), { recursive: true })
for (const name of ['package.json', 'pnpm-lock.yaml']) {
  await copyFile(join(root, 'config/mnemon', name), join(runtime, 'tools', name))
}
await run('pnpm', ['install', '--frozen-lockfile'], join(runtime, 'tools'))
console.log('Source and dependencies prepared. Import your model and Cubism Core, then run pnpm build.')
