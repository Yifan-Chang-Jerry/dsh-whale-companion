/** Record public package metadata for the installed workspace, plugins, and memory CLI. */
import { readdir, readFile, realpath, writeFile, mkdir, copyFile } from 'node:fs/promises'
import { join, basename, dirname } from 'node:path'
import { execFileSync } from 'node:child_process'
import { root, runtime, harness, data, upstream } from './runtime.mjs'

const packages = new Map()
const visited = new Set()
function publicUrl(value) {
  if (typeof value !== 'string') return null
  let url = value.replace(/^git\+/, '').replace(/^git:\/\//, 'https://').replace(/\.git$/, '')
  if (/^github:/.test(url)) url = url.replace(/^github:/, 'https://github.com/')
  if (!url.startsWith('https://')) return null
  try {
    const parsed = new URL(url)
    if (parsed.username || parsed.password) return null
    return parsed.href
  } catch { return null }
}
async function collect(directory, scope) {
  let resolved
  try { resolved = await realpath(directory) }
  catch (error) { if (error.code === 'ENOENT') return; throw error }
  if (visited.has(`${scope}:${resolved}`)) return
  visited.add(`${scope}:${resolved}`)
  let manifest
  try { manifest = JSON.parse(await readFile(join(resolved, 'package.json'), 'utf8')) }
  catch (error) { if (error.code === 'ENOENT') return; throw error }
  if (!manifest.name || !manifest.version) return
  const id = `${manifest.name}@${manifest.version}`
  if (packages.has(id)) { packages.get(id).scopes.add(scope); return }
  let author = typeof manifest.author === 'string'
    ? manifest.author.replace(/\s*<[^>]+>/g, '').trim()
    : manifest.author?.name ?? null
  const repository = publicUrl(typeof manifest.repository === 'string' ? manifest.repository : manifest.repository?.url)
  let license = typeof manifest.license === 'string' ? manifest.license
    : manifest.license?.type ?? manifest.licenses?.map(entry => entry.type).join(' OR ') ?? 'NOT DECLARED'
  const licenseFiles = []
  for (const file of await readdir(resolved)) {
    if (!/^(license|licence|copying|notice)(\.|$)/i.test(file)) continue
    try {
      const bytes = await readFile(join(resolved, file))
      const target = `${manifest.name.replaceAll('/', '__')}@${manifest.version}/${file}`
      await mkdir(join(root, 'third-party/licenses', target, '..'), { recursive: true })
      await writeFile(join(root, 'third-party/licenses', target), bytes)
      licenseFiles.push(`licenses/${target}`)
      if (license === 'NOT DECLARED' && bytes.toString().includes('Permission is hereby granted, free of charge')
        && bytes.toString().includes('THE SOFTWARE IS PROVIDED')) license = 'MIT'
      if (!author) author = bytes.toString().match(/Copyright \(c\) [\d\-a-z]+ (.+)/i)?.[1] ?? null
    } catch (error) { if (error.code !== 'EISDIR') throw error }
  }
  const referenced = /^SEE LICENSE IN (.+)$/i.exec(license)?.[1]
  let missingLicenseFile = null
  if (referenced && !referenced.includes('/') && !licenseFiles.some(file => file.endsWith(`/${referenced}`))) {
    const target = `${manifest.name.replaceAll('/', '__')}@${manifest.version}/${referenced}`
    await mkdir(join(root, 'third-party/licenses', target, '..'), { recursive: true })
    try {
      await copyFile(join(resolved, referenced), join(root, 'third-party/licenses', target))
      licenseFiles.push(`licenses/${target}`)
    } catch (error) { if (error.code === 'ENOENT') missingLicenseFile = referenced; else throw error }
  }
  packages.set(id, { name: manifest.name, version: manifest.version, license, author,
    repository, homepage: publicUrl(manifest.homepage),
    registry: `https://www.npmjs.com/package/${manifest.name}/v/${manifest.version}`,
    licenseFiles: licenseFiles.sort(), missingLicenseFile, scopes: new Set([scope]) })
  for (const dependency of Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies })) {
    for (let parent = resolved;; parent = dirname(parent)) {
      const candidate = join(parent, 'node_modules', dependency)
      try { await realpath(candidate); await collect(candidate, scope); break }
      catch (error) { if (error.code !== 'ENOENT') throw error }
      if (dirname(parent) === parent) break
    }
  }
}
async function packageChildren(directory, scope) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue
    const child = join(directory, entry.name)
    if (entry.name.startsWith('@')) {
      for (const name of await readdir(child)) await collect(join(child, name), scope)
    } else await collect(child, scope)
  }
}
async function virtualStore(directory, scope) {
  await packageChildren(join(directory, 'node_modules'), scope)
  const store = join(directory, 'node_modules/.pnpm')
  for (const entry of await readdir(store, { withFileTypes: true })) {
    if ((!entry.isDirectory() && !entry.isSymbolicLink()) || entry.name === 'node_modules') continue
    await packageChildren(join(store, entry.name, 'node_modules'), scope)
  }
}
for (const [directory, scope] of [[harness, 'Harness workspace dependencies'],
  [join(data, 'home/profiles/desktop'), 'Whale agent profile dependencies'],
  [join(runtime, 'tools'), 'Mnemon CLI dependencies']]) await virtualStore(directory, scope)
for (const directory of ['packages', 'vendor', 'apps', 'native/system/packages']) {
  const base = join(harness, directory)
  for (const group of await readdir(base, { withFileTypes: true })) {
    if (!group.isDirectory() || group.name.startsWith('.')) continue
    const candidate = join(base, group.name)
    await collect(candidate, 'Harness source packages')
    if (directory === 'packages') {
      for (const entry of await readdir(candidate, { withFileTypes: true })) {
        if (entry.isDirectory() && !entry.name.startsWith('.')) await collect(join(candidate, entry.name), 'Harness source packages')
      }
    }
  }
}
for (const name of ['whale-persona', 'whale-memory']) await collect(join(root, 'bundles', name), 'Companion bundles')
await collect(join(harness, 'apps/desktop/companion-agent'), 'Companion bundles')
const entries = [...packages.values()].map(entry => ({ ...entry, scopes: [...entry.scopes].sort() }))
  .sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`, 'en'))
const target = `${process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : process.platform}-${process.arch}`
const primary = join(harness, 'apps/desktop/.desktop-build/targets', target, 'runtime/primary-runtime')
const lock = JSON.parse(await readFile(join(harness, 'scripts/primary-runtime/lock.json'), 'utf8'))
const pythonRoot = join(primary, 'dependencies/python')
const python = join(pythonRoot, process.platform === 'win32' ? 'python.exe' : 'bin/python3')
const site = join(pythonRoot, process.platform === 'win32' ? 'Lib/site-packages' : `lib/python${lock.pythonVersion.split('.').slice(0, 2).join('.')}/site-packages`)
const pythonEntries = JSON.parse(execFileSync(python, ['-I', join(root, 'scripts/python-inventory.py'), site], { encoding: 'utf8' }))
for (const entry of pythonEntries) {
  const files = []
  for (const source of entry.licenseSources) {
    const name = `python/${entry.name}@${entry.version}/${files.length}-${basename(source)}`
    await mkdir(join(root, 'third-party/licenses', name, '..'), { recursive: true })
    await copyFile(source, join(root, 'third-party/licenses', name))
    files.push(`licenses/${name}`)
  }
  delete entry.licenseSources
  entries.push({ ...entry, repository: publicUrl(entry.repository), homepage: publicUrl(entry.homepage), licenseFiles: files,
    scopes: ['Prepared Harness Python tool runtime'] })
}
for (const [source, targetFile] of [
  [join(harness, 'apps/desktop/node_modules/electron/dist/LICENSES.chromium.html'), 'electron-chromium-notices.html'],
  [join(primary, 'dependencies/node/LICENSE'), 'node-runtime-LICENSE.txt'],
  [join(pythonRoot, 'LICENSE'), 'python-runtime-LICENSE.txt'],
]) {
  try { await copyFile(source, join(root, 'third-party', targetFile)) }
  catch (error) { if (error.code !== 'ENOENT') throw error }
}
await copyFile(join(harness, 'pnpm-lock.yaml'), join(root, 'third-party/harness-pnpm-lock.yaml'))
await copyFile(join(harness, 'scripts/primary-runtime/lock.json'), join(root, 'third-party/primary-runtime-lock.json'))
await writeFile(join(root, 'third-party/dependencies.json'), `${JSON.stringify({
  harnessRevision: upstream.revision, platform: `${process.platform}-${process.arch}`,
  scope: 'Installed runtime, build, test, and optional workspace/profile dependencies; not a claim that every package executes in the companion.',
  packages: entries.sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`, 'en')),
}, null, 2)}\n`)
console.log(`Recorded ${entries.length} package versions; ${entries.filter(entry => entry.license === 'NOT DECLARED').length} require a license declaration check.`)
