/** Copy user-acquired assets into ignored runtime storage and prepare local model controls. */
import { access, cp, copyFile, mkdir, readFile, readdir, rename, rm } from 'node:fs/promises'
import { join, resolve, sep, dirname } from 'node:path'
import { parseArgs } from 'node:util'
import { root, harness, environment, run } from './runtime.mjs'

const { values } = parseArgs({ options: { model: { type: 'string' }, core: { type: 'string' } } })
if (!values.model || !values.core) throw new Error('Usage: pnpm import-model --model /path/to/extracted/model --core /path/to/Core/live2dcubismcore.min.js')
const model = resolve(values.model)
const core = resolve(values.core)
const destination = environment.DSH_COMPANION_LIVE2D_DIR
if (model === destination || model.startsWith(destination + sep) || destination.startsWith(model + sep)) {
  throw new Error('The source model must be outside the runtime import directory')
}
await access(join(harness, 'apps/desktop/scripts/prepare-companion.ts'))
for (const file of ['大肥鱼.model3.json', '大肥鱼.physics3.json', '大肥鱼.vtube.json', 'Animation/脱捕.motion3.json']) await access(join(model, file))
const manifest = JSON.parse(await readFile(join(model, '大肥鱼.model3.json'), 'utf8'))
for (const file of [manifest.FileReferences.Moc, ...manifest.FileReferences.Textures]) {
  if (typeof file !== 'string' || file.includes('\\') || resolve(model, file).startsWith(model + sep) === false) throw new Error('Model files must be inside the selected directory')
  await access(resolve(model, file))
}
const coreText = await readFile(core, 'utf8')
if (!coreText.includes('Live2DCubismCore') || !coreText.includes('MocVersion_50')) throw new Error('Select the official Cubism Core JavaScript file with Cubism 5 support (tested with Core 5.1.0)')
async function rejectSymlinks(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error('Extract the original model without symbolic links')
    if (entry.isDirectory()) await rejectSymlinks(join(directory, entry.name))
  }
}
await rejectSymlinks(model)
await mkdir(dirname(destination), { recursive: true })
const temporary = `${destination}.importing`
await rm(temporary, { recursive: true, force: true })
await mkdir(temporary)
try {
  await cp(model, join(temporary, 'model'), { recursive: true })
  await copyFile(core, join(temporary, 'live2dcubismcore.min.js'))
  await copyFile(join(root, 'config/preview.json'), join(temporary, 'preview.json'))
  await run('pnpm', ['--dir', 'apps/desktop', 'run', 'prepare:companion'], harness,
    { ...environment, DSH_COMPANION_LIVE2D_DIR: temporary })
  const backup = `${destination}.previous`
  await rm(backup, { recursive: true, force: true })
  try { await access(destination); await rename(destination, backup) }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  try { await rename(temporary, destination) }
  catch (error) {
    try { await rename(backup, destination) } catch (rollbackError) { if (rollbackError.code !== 'ENOENT') throw new AggregateError([error, rollbackError], 'Model import and restore both failed') }
    throw error
  }
  await rm(backup, { recursive: true, force: true })
} finally { await rm(temporary, { recursive: true, force: true }) }
console.log('Imported locally. Model assets and Cubism Core remain excluded from Git.')
