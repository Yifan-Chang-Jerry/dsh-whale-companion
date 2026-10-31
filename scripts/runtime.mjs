/** Paths shared by preparation and the supported DSH desktop launcher. */
import { readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const root = fileURLToPath(new URL('..', import.meta.url))
export const runtime = join(root, '.runtime')
export const harness = join(runtime, 'harness')
export const data = join(runtime, 'data')
export const upstream = JSON.parse(readFileSync(join(root, 'config/upstream.json'), 'utf8'))
export const environment = {
  ...process.env,
  DSH_HOME: join(data, 'home'),
  DSH_DESKTOP_USER_DATA_DIR: join(data, 'electron'),
  DSH_WHALE_MEMORY_DIR: join(data, 'memory'),
  DSH_WHALE_MNEMON_CLI: join(runtime, 'tools/node_modules/.bin', process.platform === 'win32' ? 'mnemon.cmd' : 'mnemon'),
  DSH_DESKTOP_OPEN_DEVTOOLS: '0',
  DSH_COMPANION_LIVE2D_DIR: join(harness, 'apps/desktop/.desktop-build/live2d'),
}

/** Run an existing build, management, or launcher command and forward its exit status. */
export async function run(command, args, cwd = harness, env = environment) {
  await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: resolve(cwd), env, stdio: 'inherit', shell: process.platform === 'win32' })
    child.once('error', reject)
    child.once('exit', (code, signal) => code === 0 ? resolvePromise() : reject(new Error(`${command} ${args.join(' ')} exited with ${code ?? signal}`)))
  })
}
