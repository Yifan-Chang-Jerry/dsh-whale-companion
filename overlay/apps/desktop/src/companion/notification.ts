/** Persistent unread messages and a shared text clock for the bubble and Live2D mouth. */
import { z } from 'zod'
import { avatarExpressionSchema, avatarMotionSchema, type AvatarExpression, type AvatarMotion } from './avatar.ts'

const storedNotificationTextSchema = z.string().trim().min(1).max(240)
  .refine(text => !/[\u0000-\u0008\u000b-\u001f\u007f]/u.test(text), 'Notification text contains control characters')

/** New spoken messages fit one compact bubble; detailed content belongs in the conversation. */
export const notificationTextSchema = storedNotificationTextSchema
  .refine(text => Array.from(text).length <= 60, 'Use at most 60 characters; put details in the conversation.')
  .refine(text => !/[\r\n]/u.test(text), 'Use one spoken sentence without paragraph breaks.')

/** Stable mood identifiers let Agents select the rig's expressions without knowing parameter names. */
export const notificationEmotionSchema = z.enum(['calm', 'happy', 'affectionate', 'angry', 'shy', 'sad', 'confused', 'worried'])
/** A supported mood for one spoken notification. */
export type NotificationEmotion = z.infer<typeof notificationEmotionSchema>
/** Rig-specific gestures, compatible expressions, and mouth curves used for each mood. */
export const NOTIFICATION_EMOTIONS: Record<NotificationEmotion, {
  motion: AvatarMotion
  expressions: AvatarExpression[]
  mouthForm: number
}> = {
  calm: { motion: 'ambient', expressions: [], mouthForm: .1 },
  happy: { motion: 'sway', expressions: ['rabbit-teeth'], mouthForm: .7 },
  affectionate: { motion: 'tilt', expressions: ['heart-eyes', 'blush', 'lean'], mouthForm: .5 },
  angry: { motion: 'point-on', expressions: ['dark-face', 'smug-eyes'], mouthForm: -.7 },
  shy: { motion: 'tilt', expressions: ['blush', 'closed-eyes'], mouthForm: .2 },
  sad: { motion: 'chest-on', expressions: ['tears'], mouthForm: -.6 },
  confused: { motion: 'tilt', expressions: ['spiral-eyes'], mouthForm: -.1 },
  worried: { motion: 'chest-on', expressions: ['sweat'], mouthForm: -.25 },
}

/** A caller's identity and delivery key are supplied by the tool executor, never by the model. */
export const agentNotificationRequestSchema = z.object({
  operation: z.literal('notify'),
  sessionId: z.string().min(1).max(200),
  requestId: z.string().min(1).max(200),
  text: notificationTextSchema,
  emotion: notificationEmotionSchema.optional(),
  motion: avatarMotionSchema.optional(),
  expressions: z.array(avatarExpressionSchema).max(8).optional(),
}).strict()
/** Validated notification request from a live Agent. */
export type AgentNotificationRequest = z.infer<typeof agentNotificationRequestSchema>

/** Unread messages survive app restarts; an announced message is restored without replaying speech. */
export const companionNotificationSchema = z.object({
  id: z.string().min(1).max(401),
  sessionId: z.string().min(1).max(200),
  sessionLabel: z.string(),
  text: storedNotificationTextSchema,
  emotion: notificationEmotionSchema.default('calm'),
  createdAt: z.number(),
  motion: avatarMotionSchema,
  expressions: z.array(avatarExpressionSchema).max(8),
  announced: z.boolean(),
})
/** One locally persisted unread message, linked to its original Session. */
export type CompanionNotification = z.infer<typeof companionNotificationSchema>

/** Both renderers use this main-owned start time, without independent animation timers. */
export interface NotificationSpeech {
  id: string
  text: string
  startedAt: number
  charactersPerSecond: number
  mouthForm: number
}

/** A visible message and its optional first-presentation speech clock. */
export interface NotificationSnapshot extends CompanionNotification {
  unread: number
  side: 'left' | 'right'
  speech: NotificationSpeech | null
}

/**
 * Derive revealed text and mouth opening from one clock; punctuation closes the mouth.
 * @param speech - Main-owned text, starting time, and configured reveal speed.
 * @param now - Current wall-clock milliseconds.
 * @returns Revealed text, normalized mouth opening, and whether speaking has finished.
 */
export function notificationSpeechFrame(speech: NotificationSpeech, now: number) {
  const characters = Array.from(speech.text)
  const elapsed = Math.max(0, now - speech.startedAt)
  const count = Math.min(characters.length, Math.floor(elapsed * speech.charactersPerSecond / 1000))
  const finished = count === characters.length
  const vowel = characters[count]
  const speaking = now >= speech.startedAt && !finished && vowel !== undefined && !/[\s，。！？、,.!?…:：;；]/u.test(vowel)
  return {
    text: characters.slice(0, count).join(''),
    mouth: speaking ? .12 + .65 * Math.abs(Math.sin(elapsed * .018)) : 0,
    finished,
  }
}
