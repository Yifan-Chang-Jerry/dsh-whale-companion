/** Run the Desktop carrier's plugin-management CLI, which owns the reserved desktop profile. */
import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { harness, environment } from './runtime.mjs'

const target = `${process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : process.platform}-${process.arch}`
const project = join(harness, 'apps/desktop/.desktop-build/development/project')
const support = join(harness, 'apps/desktop/.desktop-build/targets', target, 'runtime')
await access(join(support, 'primary-runtime/runtime.json'))
Object.assign(process.env, environment)
process.argv = [process.execPath, import.meta.filename, 'plugin', '--profile', 'desktop', ...process.argv.slice(2)]
const { runDesktopCli } = await import(pathToFileURL(join(harness, 'apps/desktop-host/lib/cli.js')).href)
await runDesktopCli(project, support)
