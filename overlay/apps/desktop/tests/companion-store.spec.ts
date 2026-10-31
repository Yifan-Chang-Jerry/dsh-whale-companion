/** Functional recovery guarantees for local companion data, without UI assertions. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { CompanionStore, isQuietTime } from '../src/companion/store.ts'

it('restores the exact draft and request identity after an unconfirmed admission', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-companion-'))
  try {
    const store = new CompanionStore(directory, () => {})
    await store.load()
    store.data.drafts.sessionA = '中文草稿\nsecond line'
    store.data.submissions.push({ requestId: 'c0ef9058-39a2-4aad-b02b-383da3945d96', sessionId: 'sessionA', text: '中文草稿\nsecond line', phase: 'sending' })
    await store.save()
    const restored = new CompanionStore(directory, () => {})
    await restored.load()
    expect(restored.data.drafts.sessionA).toBe('中文草稿\nsecond line')
    expect(restored.data.submissions).toEqual([{ requestId: 'c0ef9058-39a2-4aad-b02b-383da3945d96', sessionId: 'sessionA', text: '中文草稿\nsecond line', phase: 'uncertain' }])
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it('preserves corrupt data and refuses writes until explicit recovery', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-companion-'))
  try {
    const path = join(directory, 'state.json')
    await writeFile(path, '{broken')
    let failures = 0
    const store = new CompanionStore(directory, () => { failures++ })
    await store.load()
    await expect(store.save()).rejects.toThrow()
    expect(await readFile(path, 'utf8')).toBe('{broken')
    expect(failures).toBeGreaterThan(0)
    await store.reset()
    expect(store.failed).toBe(false)
    expect(JSON.parse(await readFile(path, 'utf8')).schemaVersion).toBe(1)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it('loads older local preferences with avatar defaults while retaining the saved draft', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-companion-avatar-migration-'))
  try {
    const source = new CompanionStore(directory, () => {})
    source.data.drafts.unbound = '保留的草稿'
    const { avatar: _avatar, ...preferences } = source.data.preferences
    const legacyNotification = { id: 'session:call', sessionId: 'session', sessionLabel: 'Legacy notification', text: '旧'.repeat(100),
      createdAt: 1, motion: 'nod', expressions: [], announced: true }
    await writeFile(join(directory, 'state.json'), JSON.stringify({ ...source.data, preferences, notifications: [legacyNotification] }))
    const restored = new CompanionStore(directory, () => {})
    await restored.load()
    expect(restored.failed).toBe(false)
    expect(restored.data.drafts.unbound).toBe('保留的草稿')
    expect(restored.data.notifications[0]).toMatchObject({ text: legacyNotification.text, emotion: 'calm' })
    expect(restored.data.preferences.avatar).toMatchObject({ body: 2, autoDance: true, danceIdleMinutes: 5, danceChance: .2, danceCooldownMinutes: 10 })
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it('applies local cross-midnight quiet hours while allowing the end instant', () => {
  const prefs = new CompanionStore('/unused', () => {}).data.preferences
  expect(isQuietTime(prefs, new Date(2026, 9, 30, 23, 0))).toBe(true)
  expect(isQuietTime(prefs, new Date(2026, 9, 31, 8, 59))).toBe(true)
  expect(isQuietTime(prefs, new Date(2026, 9, 31, 9, 0))).toBe(false)
  expect(isQuietTime({ ...prefs, mode: 'quiet' }, new Date(2026, 9, 31, 12, 0))).toBe(true)
})
