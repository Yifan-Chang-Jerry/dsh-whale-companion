/** Install companion bundles through the supported profile plugin manager. Quit the app first. */
import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { data, root, harness, run } from './runtime.mjs'

try {
  await access(join(data, 'home/profiles/desktop/package.json'))
  await access(join(harness, 'apps/desktop/companion-agent/lib/index.js'))
} catch (error) {
  throw new Error('Build the project and launch the desktop once, then fully quit it before installing agent bundles', { cause: error })
}
for (const specifier of [
  `file:${join(root, 'bundles/whale-persona')}`,
  'dsh-mnemon@0.5.37',
  `file:${join(harness, 'apps/desktop/companion-agent')}`,
  `file:${join(root, 'bundles/whale-memory')}`,
]) {
  await run(process.execPath, [join(root, 'scripts/desktop-plugin.mjs'), 'add', specifier])
}
console.log('Whale persona, actions, speech, and local memory bundles installed. Restart, create a session, and choose the Whale preset.')
