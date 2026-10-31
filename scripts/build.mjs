/** Build the real workspace and its desktop shell, then check build consumers. */
import { run } from './runtime.mjs'
await run('pnpm', ['run', 'build:artifacts'])
await run('pnpm', ['run', 'build:check'])
