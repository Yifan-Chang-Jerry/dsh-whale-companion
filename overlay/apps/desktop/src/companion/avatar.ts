/** Model controls and local idle-dance scheduling shared by the companion windows. */
import { z } from 'zod'

/** Stable names for all expression files in the model package. */
export const avatarExpressionSchema = z.enum([
  'body-normal', 'body-small', 'body-chibi', 'rabbit-teeth', 'lean', 'loading', 'monocle', 'spiral-eyes',
  'hide-tail', 'smug-eyes', 'sweat', 'tears', 'heart-eyes', 'point-off', 'point-on', 'chest-outfit',
  'shoes-off', 'blush', 'skirt', 'pot', 'glasses', 'dark-face', 'closed-eyes',
])
/** An expression or appearance preset from the original package. */
export type AvatarExpression = z.infer<typeof avatarExpressionSchema>

/** Original filenames and mutually exclusive selections; UI labels remain locale-owned. */
export const AVATAR_EXPRESSIONS: Record<AvatarExpression, { file: string; category: 'body' | 'face' | 'look' | 'pose'; exclusive?: string; body?: number }> = {
  'body-normal': { file: '默认体型', category: 'body', exclusive: 'body', body: 0 },
  'body-small': { file: '体型1', category: 'body', exclusive: 'body', body: 1 },
  'body-chibi': { file: '体型2', category: 'body', exclusive: 'body', body: 2 },
  'rabbit-teeth': { file: '兔牙', category: 'face' }, lean: { file: '前倾', category: 'pose' },
  loading: { file: '加载', category: 'face' }, monocle: { file: '单片眼镜', category: 'look', exclusive: 'glasses' },
  'spiral-eyes': { file: '圈圈眼', category: 'face', exclusive: 'eyes' },
  'hide-tail': { file: '尾巴开关', category: 'look' }, 'smug-eyes': { file: '屑屑眼', category: 'face', exclusive: 'eyes' },
  sweat: { file: '流冷汗', category: 'face' }, tears: { file: '流泪', category: 'face' },
  'heart-eyes': { file: '爱心眼', category: 'face', exclusive: 'eyes' },
  'point-off': { file: '竖食指关', category: 'pose', exclusive: 'point' },
  'point-on': { file: '竖食指开', category: 'pose', exclusive: 'point' },
  'chest-outfit': { file: '胸口衣服', category: 'look' }, 'shoes-off': { file: '脱鞋', category: 'look' },
  blush: { file: '脸红', category: 'face' }, skirt: { file: '裙子切换', category: 'look' }, pot: { file: '钢盆', category: 'look' },
  glasses: { file: '黑框眼镜', category: 'look', exclusive: 'glasses' }, 'dark-face': { file: '黑脸', category: 'face' },
  'closed-eyes': { file: '＞＜', category: 'face', exclusive: 'eyes' },
}

/** Original motion controls, plus the locally composed dance. */
export const avatarMotionSchema = z.enum(['ambient', 'chest-on', 'chest-off', 'point-on', 'point-off', 'grass-on', 'grass-off', 'showcase', 'dance', 'nod', 'tilt', 'sway'])
/** A motion that can be selected from the companion panel. */
export type AvatarMotion = z.infer<typeof avatarMotionSchema>
/** Files, SDK groups, and expected lengths used by preparation and playback. */
export const AVATAR_MOTIONS: Record<AvatarMotion, { file: string; group: string; index: number; seconds: number; full: boolean; generated?: boolean }> = {
  ambient: { file: 'IDLE', group: 'Idle', index: 0, seconds: 5.983, full: false },
  'chest-on': { file: '默认手切举手', group: 'Chest', index: 0, seconds: 1.133, full: false },
  'chest-off': { file: '举手切默认手', group: 'Chest', index: 1, seconds: 1.017, full: false },
  'point-on': { file: '竖手指切出来动画', group: 'Point', index: 0, seconds: 1.25, full: false },
  'point-off': { file: '竖手指切回默认', group: 'Point', index: 1, seconds: 1.25, full: false },
  'grass-on': { file: '狗尾草切换出来', group: 'Grass', index: 0, seconds: 1.233, full: false },
  'grass-off': { file: '狗尾草切回默认手', group: 'Grass', index: 1, seconds: 1.133, full: false },
  showcase: { file: '脱捕', group: 'Showcase', index: 0, seconds: 13.15, full: true },
  dance: { file: 'dance', group: 'Dance', index: 0, seconds: 24, full: true, generated: true },
  nod: { file: 'nod', group: 'Nod', index: 0, seconds: 2.4, full: true, generated: true },
  tilt: { file: 'tilt', group: 'Tilt', index: 0, seconds: 3, full: true, generated: true },
  sway: { file: 'sway', group: 'Sway', index: 0, seconds: 4.8, full: true, generated: true },
}

/** Commands accepted from the controls panel and author shortcut bindings. */
export const avatarActionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('expression'), id: avatarExpressionSchema }),
  z.object({ kind: z.literal('motion'), id: avatarMotionSchema }),
  z.object({ kind: z.literal('reset') }),
  z.object({ kind: z.literal('stop') }),
  z.object({ kind: z.literal('reload') }),
])
/** A validated model-control action. */
export type AvatarAction = z.infer<typeof avatarActionSchema>

/** The 28 author bindings; Shift is portable across left/right modifier keys. */
export const AVATAR_HOTKEYS: { accelerator: string; action: AvatarAction }[] = [
  ...(['rabbit-teeth', 'loading', 'spiral-eyes', 'smug-eyes', 'tears', 'heart-eyes', 'blush', 'dark-face', 'closed-eyes'] as const)
    .map((id, i) => ({ accelerator: `Alt+${i + 1}`, action: { kind: 'expression' as const, id } })),
  ...([['Q', 'monocle'], ['W', 'shoes-off'], ['E', 'pot'], ['R', 'skirt'], ['T', 'glasses'], ['S', 'sweat']] as const)
    .map(([key, id]) => ({ accelerator: `Alt+${key}`, action: { kind: 'expression' as const, id } })),
  ...(['hide-tail', 'body-small', 'body-chibi', 'body-normal', 'lean'] as const)
    .map((id, i) => ({ accelerator: `Shift+${i + 1}`, action: { kind: 'expression' as const, id } })),
  { accelerator: 'Shift+S', action: { kind: 'expression', id: 'chest-outfit' } },
  { accelerator: 'Alt+Delete', action: { kind: 'reset' } },
  ...([['Z', 'chest-on'], ['X', 'chest-off'], ['C', 'point-on'], ['V', 'point-off'], ['D', 'grass-on'], ['F', 'grass-off']] as const)
    .map(([key, id]) => ({ accelerator: `Alt+${key}`, action: { kind: 'motion' as const, id } })),
]

/** Appearance choices and user-adjustable automatic dance policy. */
export const avatarPreferencesSchema = z.object({
  body: z.number().int().min(0).max(2).default(2), expressions: z.array(avatarExpressionSchema).max(23).default([]),
  authorHotkeys: z.boolean().default(false), autoDance: z.boolean().default(true),
  danceIdleMinutes: z.number().int().min(1).max(120).default(5),
  danceChance: z.number().min(0).max(1).default(.2), danceCooldownMinutes: z.number().int().min(1).max(120).default(10),
  agentActions: z.boolean().default(true), textReactions: z.boolean().default(true),
})
/** Persisted avatar choices, independent of task history. */
export type AvatarPreferences = z.infer<typeof avatarPreferencesSchema>
/** One queued playback; sequence numbers reject acknowledgements from replaced requests. */
export interface AvatarPlayback { sequence: number; motion: AvatarMotion; automatic: boolean; started: boolean; agent?: boolean }
/** Temporary agent-owned selections do not rewrite the user's saved appearance. */
export interface AvatarAgentPose { sequence: number; expressions: AvatarExpression[]; body?: number; source: 'tool' | 'text' | 'notification' }
/** Main-owned controls projected to both companion windows. */
export interface AvatarSnapshot {
  playback: AvatarPlayback | null; queued: number; resetSequence: number; manualHands: boolean; shortcutErrors: string[]
  motionBlocked: boolean; modelPhase: 'loading' | 'ready' | 'failed'
  danceState: 'disabled' | 'quiet' | 'motion' | 'interaction' | 'cooldown' | 'waiting' | 'playing'
  agent: AvatarAgentPose | null
}
/** Times used only for the current process's uninterrupted idle period. */
export interface AvatarDanceSchedule { idleSince: number | null; nextCheckAt: number | null; cooldownUntil: number }

/**
 * Advance one idle-dance decision without tying probability to rendered frames.
 * @param state - Previous idle deadline and cooldown.
 * @param preferences - Current user timing and probability choices.
 * @param now - Current wall-clock milliseconds.
 * @param eligible - Whether visibility, activity, and interaction allow an automatic dance.
 * @param random - Uniform value in [0, 1), sampled by the owner.
 * @returns Updated deadlines and whether exactly one dance should start.
 */
export function advanceAvatarDance(state: AvatarDanceSchedule, preferences: AvatarPreferences, now: number, eligible: boolean, random: number) {
  if (!eligible || !preferences.autoDance) return { ...state, idleSince: null, nextCheckAt: null, trigger: false }
  const idleSince = state.idleSince ?? now
  const nextCheckAt = state.nextCheckAt ?? Math.max(idleSince + preferences.danceIdleMinutes * 60_000, state.cooldownUntil)
  if (now < nextCheckAt) return { ...state, idleSince, nextCheckAt, trigger: false }
  if (random < preferences.danceChance) return { ...state, idleSince: null, nextCheckAt: null, trigger: true }
  return { ...state, idleSince, nextCheckAt: now + 60_000, trigger: false }
}

/** Prepared expression parameters, retaining the original expression blend modes. */
export const avatarControlsSchema = z.object({
  expressions: z.array(z.object({ id: avatarExpressionSchema, fadeSeconds: z.number().min(.05).max(5),
    parameters: z.array(z.object({ id: z.string().min(1), value: z.number().finite(), blend: z.enum(['Add', 'Multiply', 'Overwrite']), early: z.boolean() })) })),
  motions: z.array(z.object({ id: avatarMotionSchema, parameters: z.array(z.string().min(1)) })),
})
