/** Launch the normal Desktop Host/profile with data isolated to this checkout. */
import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { environment, run } from './runtime.mjs'

if (environment.DSH_COMPANION_ENABLED !== '0') {
  try {
    for (const name of ['live2dcubismcore.min.js', 'preview.json', 'model/preview.model3.json', 'model/PreviewAnimation/body-idle.motion3.json']) {
      await access(join(environment.DSH_COMPANION_LIVE2D_DIR, name))
    }
  } catch (error) {
    throw new Error('Import the model and Cubism Core with pnpm import-model first', { cause: error })
  }
}
await run('pnpm', ['run', 'start:desktop'])
