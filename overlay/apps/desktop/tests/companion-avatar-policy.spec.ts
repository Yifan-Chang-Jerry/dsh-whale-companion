/** Idle dance decisions use explicit time and randomness, without rendering assertions. */
import { expect, it } from 'vitest'
import { advanceAvatarDance, avatarPreferencesSchema, type AvatarDanceSchedule } from '../src/companion/avatar.ts'

it('waits for uninterrupted idle and makes at most one chance decision each minute', () => {
  const preferences = avatarPreferencesSchema.parse({})
  let state: AvatarDanceSchedule = { idleSince: null, nextCheckAt: null, cooldownUntil: 0 }
  state = advanceAvatarDance(state, preferences, 0, true, 0)
  expect(state.nextCheckAt).toBe(300_000)
  expect(advanceAvatarDance(state, preferences, 299_999, true, 0).trigger).toBe(false)
  state = advanceAvatarDance(state, preferences, 300_000, true, .8)
  expect(state.nextCheckAt).toBe(360_000)
  expect(advanceAvatarDance(state, preferences, 300_000, true, 0).trigger).toBe(false)
  expect(advanceAvatarDance(state, preferences, 360_000, true, .1).trigger).toBe(true)
})

it('preserves cooldown and discards idle credit when playback is disallowed', () => {
  const preferences = avatarPreferencesSchema.parse({})
  let state: AvatarDanceSchedule = { idleSince: 0, nextCheckAt: null, cooldownUntil: 900_000 }
  state = advanceAvatarDance(state, preferences, 300_000, true, 0)
  expect(state.nextCheckAt).toBe(900_000)
  expect(advanceAvatarDance(state, preferences, 899_999, true, 0).trigger).toBe(false)
  state = advanceAvatarDance(state, preferences, 899_999, false, 0)
  expect(state.idleSince).toBeNull()
  state = advanceAvatarDance(state, preferences, 900_000, true, 0)
  expect(state.nextCheckAt).toBe(1_200_000)
  expect(advanceAvatarDance(state, { ...preferences, autoDance: false }, 1_200_000, true, 0).trigger).toBe(false)
  expect(advanceAvatarDance(state, { ...preferences, danceChance: 0 }, 1_200_000, true, 0).trigger).toBe(false)
  expect(advanceAvatarDance(state, { ...preferences, danceChance: 1 }, 1_200_000, true, .999).trigger).toBe(true)
})
