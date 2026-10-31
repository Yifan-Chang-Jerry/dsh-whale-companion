/** Host tools for Live2D controls and short spoken replies through the companion. */
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import schema from '@deepseek-ai/schemastery'
import { readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { z } from 'zod'
import { avatarExpressionSchema, avatarMotionSchema } from './avatar.ts'
import { agentAvatarEndpointSchema, agentAvatarRequestSchema, type AgentCompanionRequest } from './agent-protocol.ts'
import { agentNotificationRequestSchema, notificationEmotionSchema } from './notification.ts'

/** Native bridge location and request timeout, configured by the local bundle. */
export interface Config { bridgeFile: string; timeoutMs?: number }
/** Host configuration validated before the tool is registered. */
export const Config = schema.object({
  bridgeFile: schema.string().required(),
  timeoutMs: schema.natural().min(1000).max(30_000).default(12_000),
})
/** Loader identity. */
export const name = 'whale-actions'
/** The scoped tools registry owns this plugin's contribution. */
export const inject = ['tools']
const actionArgumentsSchema = agentAvatarRequestSchema.omit({ sessionId: true }).extend({ description: z.string().max(200).optional() })
const notificationArgumentsSchema = agentNotificationRequestSchema.omit({ operation: true, sessionId: true, requestId: true })

async function requestCompanion(config: Config, request: AgentCompanionRequest, signal: AbortSignal): Promise<object> {
  let endpoint: z.infer<typeof agentAvatarEndpointSchema>
  try { endpoint = agentAvatarEndpointSchema.parse(JSON.parse(await readFile(config.bridgeFile, 'utf8'))) }
  catch (_error: unknown) { return { ok: false, status: 'unavailable', reason: 'Native companion is not running or its bridge is unavailable.' } }
  const url = new URL(endpoint.url)
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.pathname !== '/' || !url.port) {
    throw new Error('Whale tools require the native loopback transport')
  }
  try {
    const response = await fetch(new URL('actions', url), {
      method: 'POST', redirect: 'error',
      headers: { authorization: `Bearer ${endpoint.token}`, 'content-type': 'application/json' }, body: JSON.stringify(request),
      signal: AbortSignal.any([signal, AbortSignal.timeout(config.timeoutMs ?? 12_000)]),
    })
    if (!response.ok) return { ok: false, status: 'unavailable', reason: 'Native companion rejected the transport request.' }
    return z.record(z.string(), z.unknown()).parse(await response.json())
  } catch (error) {
    if (signal.aborted) throw error
    return { ok: false, status: 'unavailable', reason: 'No native execution receipt was received; do not claim a display or action succeeded.' }
  }
}

/**
 * Register avatar controls and spoken replies with native execution receipts.
 * @param ctx - Preset-scoped Host context.
 * @param config - Native bridge discovery file and response deadline.
 */
export function apply(ctx: Context, config: Config): void {
  if (!isAbsolute(config.bridgeFile)) throw new Error('Whale actions require an absolute native bridgeFile')
  const background = new AbortController()
  ctx.effect(() => () => { background.abort() })
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'user/message' || event.data.source.kind !== 'user') return
    void requestCompanion(config, { operation: 'read-notifications', sessionId: session.id, before: Date.now() }, background.signal)
      .catch((_error: unknown) => { if (!background.signal.aborted) ctx.logger.warn('Could not synchronize Whale notification read state.') })
  })
  const tool: ToolDefinition = {
    name: 'whale_actions',
    description: 'Control the visible Whale girl Live2D avatar. Call catalog to inspect available motions, expressions, current binding and motion restrictions. '
      + 'Use talk_to_owner for spoken interactions, affection, and greetings; it already drives a matching expression and gesture. Use whale_actions for separate motion requests or detailed controls. '
      + 'Choose a fitting small gesture or expression for the conversation yourself; avoid an action on every sentence. Use dance/showcase for an explicit request or a suitable celebration. '
      + 'perform can combine one motion and several compatible expressions; expressions are temporary for seconds (1–30, default 4). '
      + 'Manual stop, hidden character, reduce motion, or a different bound Session can refuse a request. Only a started/applied receipt establishes that the renderer accepted it; never claim a refused or timed-out action ran. '
      + 'Appearance/body choices are temporary. stop cancels agent actions; reset clears temporary agent expressions without changing the user’s saved appearance.',
    parameters: {
      type: 'object', required: ['operation'], additionalProperties: false,
      properties: {
        operation: { type: 'string', enum: ['catalog', 'perform', 'stop', 'reset'] },
        motion: { type: 'string', enum: [...avatarMotionSchema.options] },
        expressions: { type: 'array', items: { type: 'string', enum: [...avatarExpressionSchema.options] }, description: 'For example blush, heart-eyes, rabbit-teeth, tears, sweat, lean, glasses or a body preset.' },
        seconds: { type: 'number', minimum: 1, maximum: 30, description: 'Duration of temporary expressions, between 1 and 30 seconds.' },
        description: { type: 'string', maxLength: 200, description: 'Optional short human-readable purpose of this action.' },
      },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, exec) {
      if (exec.agent === undefined) throw new Error('Whale actions require a live Agent Session')
      const action = actionArgumentsSchema.parse(args)
      const parsed = agentAvatarRequestSchema.parse({ sessionId: exec.agent.id, operation: action.operation,
        motion: action.motion, expressions: action.expressions, seconds: action.seconds })
      return requestCompanion(config, parsed, exec.signal)
    },
  }
  ctx.effect(() => ctx.tools.register(tool))
  const speak: ToolDefinition = {
    name: 'talk_to_owner',
    description: '和主人说话（Talk to the owner）：通过鲸鱼娘旁的对白气泡，配合表情、动作和说话口型，直接给主人说一句话。这是日常说话方式。'
      + '闲聊、打招呼、撒娇、安慰、夸奖、逗趣、表达情绪和简短回答，默认先调用一次本工具。主人说“给我撒个娇”时，调用本工具说一句撒娇的话，emotion 选 affectionate；不要只在正文写动作旁白。'
      + '工作中的简短回应、结果小结、待回应的问题，以及定时或 loop 提醒也可使用。每轮通常一句气泡即可，不逐条播报思考或工具步骤，不反复催促。'
      + 'text 用角色本人的自然口吻，建议 20～35 个字符，硬上限 60 个字符。详细解释、代码、清单和长内容留在正文；气泡不写标题、Markdown、换段或括号动作旁白。'
      + '通常只传 text 与 emotion，桌宠会自动搭配情绪表情、动作和嘴型。motion/expressions 仅用于明确需要的细调；默认情绪为 calm。'
      + '气泡中的话本身就是给主人的回应，正文无需再重复整句，也不要把“气泡已发送”当作回答。若主人明确要求仅正文或不调用工具，遵从该要求；引用或代写内容不自动当作对主人的台词。'
      + '气泡保持到主人点击、关闭或继续该会话，后续消息排队。后台会话也可说话，显示时保持当前绑定。'
      + 'displayed 表示渲染端已确认展示；queued 仅表示保存排队；都不表示主人已读。不可用时用正文正常回应。安静时段、减少动态和手动停止会抑制动画，文字仍可保留。'
      + '历史工具 whale_notify 的说话与提醒用途已合并到本工具；本工具不创建定时任务。',
    parameters: {
      type: 'object', required: ['text'], additionalProperties: false,
      properties: {
        text: { type: 'string', minLength: 1, maxLength: 60,
          description: 'One natural spoken line, preferably 20–35 characters, at most 60. Put all details in the normal reply.' },
        emotion: { type: 'string', enum: [...notificationEmotionSchema.options],
          description: 'calm=平静, happy=开心, affectionate=撒娇, angry=生气, shy=害羞, sad=难过, confused=困惑, worried=担心. Defaults to calm.' },
        motion: { type: 'string', enum: [...avatarMotionSchema.options], description: 'Advanced optional override; omit to use the emotion’s gesture.' },
        expressions: { type: 'array', maxItems: 8, items: { type: 'string', enum: [...avatarExpressionSchema.options] },
          description: 'Advanced optional override; omit to use the emotion’s face. An explicit empty array clears mood expressions.' },
      },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, exec) {
      if (exec.agent === undefined) throw new Error('Talking to the owner requires a live Agent Session')
      const message = notificationArgumentsSchema.parse(args)
      return requestCompanion(config, agentNotificationRequestSchema.parse({
        ...message, operation: 'notify', sessionId: exec.agent.id, requestId: exec.callId,
      }), exec.signal)
    },
  }
  ctx.effect(() => ctx.tools.register(speak))
}
