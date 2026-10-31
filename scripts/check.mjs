/** Focused, existing behavior checks for the companion and its Session integration. */
import { run } from './runtime.mjs'
await run('pnpm', ['exec', 'vitest', 'run',
  'scripts/build.spec.ts',
  'apps/desktop/tests/companion-agent.spec.ts',
  'apps/desktop/tests/companion-avatar-policy.spec.ts',
  'apps/desktop/tests/companion-ipc.spec.ts',
  'apps/desktop/tests/companion-store.spec.ts',
  'apps/desktop/tests/main-startup.spec.ts',
  'apps/desktop/tests/web-document.spec.ts',
  'packages/api/session-controller/tests/commands-queue-attachment.host.spec.ts',
])
