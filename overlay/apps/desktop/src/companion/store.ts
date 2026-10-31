/** Versioned local preferences and drafts. Chat history and credentials remain owned by DSH. */
import { mkdir, readFile, readdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { avatarPreferencesSchema } from './avatar.ts'
import { companionNotificationSchema } from './notification.ts'

export const preferencesSchema = z.object({
  avatar: avatarPreferencesSchema.default(() => avatarPreferencesSchema.parse({})),
  visible: z.boolean(), size: z.number().int().min(120).max(280), alwaysOnTop: z.boolean(),
  mode: z.enum(['companion', 'quiet']), reducedMotion: z.boolean(), quietHours: z.boolean(),
  quietStart: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/), quietEnd: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  notifications: z.boolean().default(true), speechCharactersPerSecond: z.number().int().min(8).max(40).default(18),
  shortcutEnabled: z.boolean(), shortcut: z.string().min(1).max(100),
})
const bindingSchema = z.object({ sessionId: z.string(), workspaceId: z.string().nullable(), workspaceLabel: z.string(), sessionLabel: z.string(), cwd: z.string() })
const dataSchema = z.object({
  schemaVersion: z.literal(1),
  preferences: preferencesSchema,
  binding: bindingSchema.nullable(),
  position: z.object({ displayId: z.number(), x: z.number().min(0).max(1), y: z.number().min(0).max(1) }).nullable(),
  drafts: z.record(z.string(), z.string().max(32_000)),
  submissions: z.array(z.object({ requestId: z.string().uuid(), sessionId: z.string(), text: z.string().max(32_000), phase: z.enum(['sending', 'accepted', 'uncertain', 'rejected']) })).max(32),
  recentResults: z.array(z.string()).max(64),
  notifications: z.array(companionNotificationSchema).max(32).default([]),
  readNotifications: z.array(z.string().min(1).max(401)).max(64).default([]),
  greetings: z.object({ day: z.string(), count: z.number().int().min(0).max(3), last: z.number() }),
})
export type CompanionData = z.infer<typeof dataSchema>

function defaults(): CompanionData {
  return {
    schemaVersion: 1,
    preferences: { avatar: avatarPreferencesSchema.parse({}), visible: true, size: 200, alwaysOnTop: true, mode: 'companion', reducedMotion: false,
      quietHours: true, quietStart: '23:00', quietEnd: '09:00', notifications: true, speechCharactersPerSecond: 18,
      shortcutEnabled: false, shortcut: 'CommandOrControl+Shift+Space' },
    binding: null, position: null, drafts: {}, submissions: [], recentResults: [], notifications: [], readNotifications: [],
    greetings: { day: '', count: 0, last: 0 },
  }
}

/** Serialized atomic writes; an unreadable file blocks writes until explicit recovery. */
export class CompanionStore {
  data = defaults()
  failed = false
  private pending = Promise.resolve()
  private readonly path: string
  constructor(private readonly directory: string, private readonly onFailure: () => void) { this.path = join(directory, 'state.json') }

  async load(): Promise<void> {
    try {
      this.data = dataSchema.parse(JSON.parse(await readFile(this.path, 'utf8')))
      for (const submission of this.data.submissions) if (submission.phase === 'sending') submission.phase = 'uncertain'
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { this.failed = true; this.onFailure() }
    }
  }

  save(): Promise<void> {
    const text = JSON.stringify(dataSchema.parse(this.data))
    const write = this.pending.then(async () => {
      if (this.failed) throw new Error('Companion storage is unavailable')
      await mkdir(this.directory, { recursive: true, mode: 0o700 })
      await writeFileAtomic(this.path, text, { mode: 0o600 })
    })
    this.pending = write.catch((_error: unknown) => { this.failed = true; this.onFailure() })
    return write
  }

  async reset(): Promise<void> {
    await this.pending
    try { await rename(this.path, `${this.path}.recovery-${Date.now()}`) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    this.data = defaults()
    this.failed = false
    await this.save()
    const backups = (await readdir(this.directory)).filter(name => /^state\.json\.recovery-\d+$/.test(name)).sort().reverse()
    for (const name of backups.slice(3)) await rm(join(this.directory, name))
  }

  async flush(): Promise<void> { await this.pending }
}

/** Local quiet hours include cross-midnight intervals and exclude the end instant. */
export function isQuietTime(preferences: CompanionData['preferences'], date = new Date()): boolean {
  if (preferences.mode === 'quiet') return true
  if (!preferences.quietHours) return false
  const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  return preferences.quietStart > preferences.quietEnd
    ? time >= preferences.quietStart || time < preferences.quietEnd
    : time >= preferences.quietStart && time < preferences.quietEnd
}
