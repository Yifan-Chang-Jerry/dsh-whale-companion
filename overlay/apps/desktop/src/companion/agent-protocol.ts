/** Validated commands exchanged by the Host tool and the native companion. */
import { z } from 'zod'
import { avatarExpressionSchema, avatarMotionSchema } from './avatar.ts'
import { agentNotificationRequestSchema } from './notification.ts'

/** A tool can address only its own Session; the native owner checks the binding. */
export const agentAvatarRequestSchema = z.object({
  sessionId: z.string().min(1).max(200),
  operation: z.enum(['catalog', 'perform', 'stop', 'reset']),
  motion: avatarMotionSchema.optional(),
  expressions: z.array(avatarExpressionSchema).max(8).optional(),
  seconds: z.number().min(1).max(30).default(4),
}).strict()
/** Parsed native action request. */
export type AgentAvatarRequest = z.infer<typeof agentAvatarRequestSchema>
/** The authenticated native transport accepts bounded avatar controls and persistent notifications. */
export const agentCompanionRequestSchema = z.discriminatedUnion('operation', [
  agentAvatarRequestSchema, agentNotificationRequestSchema,
  z.object({ operation: z.literal('read-notifications'), sessionId: z.string().min(1).max(200), before: z.number().nonnegative() }).strict(),
])
/** Native requests always carry the executing Agent's Session identity. */
export type AgentCompanionRequest = z.infer<typeof agentCompanionRequestSchema>
/** Discovery file contains an instance-specific loopback URL and bearer credential. */
export const agentAvatarEndpointSchema = z.object({ url: z.url(), token: z.string().min(40).max(100) }).strict()

/** A narrow transport receipt, without native credentials or filesystem paths. */
export interface AgentAvatarReceipt { ok: boolean; status: string; reason?: string; sequence?: number }
