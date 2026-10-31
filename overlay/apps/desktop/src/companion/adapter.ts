/** One passive Client tree over the Desktop-owned Host, independent of every workbench renderer. */
import { Context } from '@deepseek-ai/cordis'
import { WebSocket } from 'ws'
import { installConnection, type ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import * as registry from '@deepseek-ai/dsh-typert-registry/client'
import * as gateway from '@deepseek-ai/dsh-api-gateway/client'
import { RemoteStream, type RemoteStreamOptions } from '@deepseek-ai/dsh-api-gateway/client'
import { ClientSessions, type SessionReference, type SessionBinding, type SessionEventLikeEntry } from '@deepseek-ai/dsh-api-session-controller/client'
import sessionRemote from '@deepseek-ai/dsh-api-session-controller/remote'
import workspaceRemote from '@deepseek-ai/dsh-api-workspace-controller/remote'
import commandsRemote from '@deepseek-ai/dsh-commands/remote'
import subagentsRemote from '@deepseek-ai/dsh-subagent/remote'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session/types'
import type { SessionState, SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import { BlockAssembler } from '@deepseek-ai/dsh-llm'
import type { WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type { CompanionCatalog, CompanionSnapshot, Activity } from './api.ts'
import type { CompanionStore } from './store.ts'
import { companionCopy } from './copy.ts'
import { narrationCue, type NarrationCue } from './narration.ts'

declare module '@deepseek-ai/dsh-api-session-controller/client' {
  interface SessionReferenceSourceMap { desktopCompanion: unknown }
}

/** Session identity is fixed before every asynchronous operation; old generations cannot publish. */
export class DshCompanionAdapter {
  private ctx: Context | undefined
  private sessions: ClientSessions | undefined
  private connection: ConnectionHandle | undefined
  private reference: SessionReference | undefined
  private unwatch: (() => void)[] = []
  private epoch = 0
  private selection = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  private updateTimer: ReturnType<typeof setTimeout> | undefined
  private state: SessionState | undefined
  private pollRequest = 0
  private suspended = false
  private sending = new Set<string>()
  private lastNarrationTurn = -1
  private lastHumanSequence = -1
  bindingVersion = 0
  connectionState: CompanionSnapshot['connection'] = 'starting'
  error: string | null = null
  activity: Activity = 'idle'
  runKey: string | null = null
  turnKey: string | null = null
  replyPreview = ''
  previewTruncated = false
  lastPrompt = ''
  lastPromptRequestId: string | null = null
  toolName: string | null = null
  queuedCount = 0
  pendingInput: CompanionSnapshot['pendingInput'] = null
  available = false

  constructor(private readonly store: CompanionStore, private readonly changed: () => void, private readonly locale: () => 'zh' | 'en',
    private readonly result: (key: string, activity: 'completed' | 'failed') => void,
    private readonly narrated?: (cue: NarrationCue) => void,
    private readonly userStarted?: (sessionId: string) => void) {}

  async connect(url: string, cookie: string): Promise<void> {
    await this.disconnect()
    const epoch = ++this.epoch
    this.connectionState = 'starting'
    this.changed()
    const ctx = new Context()
    this.ctx = ctx
    const origin = new URL(url).origin
    installConnection(ctx, {
      interactions: 'none',
      transport: {
        streamBaseUrl: origin + '/',
        fetch: (input, init) => fetch(new URL(String(input), origin + '/'), { ...init, redirect: 'error', headers: { ...Object.fromEntries(new Headers(init.headers)), cookie } }),
        createWebSocket: target => new WebSocket(target, { headers: { cookie } }),
      },
    })
    const connection = ctx.get('connection') as ConnectionHandle
    this.connection = connection
    registry.apply(ctx)
    gateway.apply(ctx)
    await Promise.all([sessionRemote, workspaceRemote, commandsRemote, subagentsRemote].map(contribution => ctx.remote.$mount(contribution)))
    if (epoch !== this.epoch) return
    // Passive clients cannot subscribe to or answer forwarded interactions. The existing
    // RemoteStream supervisor and Session object layer still own history/attempt reconciliation.
    const sessions = new ClientSessions(ctx, {
      session: ctx.remote.session, commands: ctx.remote.commands, subagents: ctx.remote.subagents,
      $stream: <Item>(options: RemoteStreamOptions<Item>) => new RemoteStream<Item>(connection, options),
    })
    this.sessions = sessions
    ctx.effect(() => sessions.list.subscribe(() => {
      const binding = this.store.data.binding
      if (binding === null || epoch !== this.epoch) return
      const row = sessions.list.getSnapshot().byId[SessionId(binding.sessionId)]
      if (row !== undefined && row.displayTitle !== binding.sessionLabel) {
        binding.sessionLabel = row.displayTitle
        void this.store.save().catch(() => {})
        this.changed()
      }
    }), 'companion.session-label')
    const withdraw = connection.registerGenerationSource(async (signal, ready) => {
      let baseline = false
      for await (const frame of ctx.remote.session.control(signal)) {
        if (epoch !== this.epoch || signal.aborted) return
        if (frame.type === 'baseline') {
          sessions.handleConnected()
          baseline = true
          sessions.handleControlFrame(frame)
          ready({ home: '' })
          this.error = null
        } else if (baseline) sessions.handleControlFrame(frame)
      }
      if (!signal.aborted) throw new Error('Companion control stream ended')
    })
    const loop = connection.start({
      onConnected: () => {
        if (epoch !== this.epoch) return
        this.connectionState = 'online'
        void this.bind(this.store.data.binding?.sessionId ?? null).catch(() => {
          if (epoch === this.epoch) { this.error = this.copy.missing; this.changed() }
        })
      },
      onStateChange: status => {
        if (epoch !== this.epoch) return
        this.connectionState = status === 'connected' ? 'online' : status === 'connecting' ? 'reconnecting' : 'offline'
        if (status !== 'connected') this.available = false
        this.changed()
      },
    })
    ctx.effect(() => () => { loop.stop(); withdraw() }, 'companion.passive-connection')
  }

  get copy(): ReturnType<typeof companionCopy> { return companionCopy(this.locale()) }

  async catalog(): Promise<CompanionCatalog> {
    const ctx = this.ctx
    const sessions = this.sessions
    if (ctx === undefined || sessions === undefined || this.connectionState !== 'online') throw new Error(this.copy.requestFailed)
    await sessions.refresh()
    let workspaces: readonly WorkspaceView[] | undefined
    const abort = new AbortController()
    try {
      for await (const frame of ctx.remote.workspace.follow(AbortSignal.any([abort.signal, AbortSignal.timeout(5000)]))) {
        if (frame.type !== 'baseline') throw new Error(this.copy.requestFailed)
        workspaces = frame.value.items
        break
      }
    } finally { abort.abort() }
    if (workspaces === undefined) throw new Error(this.copy.requestFailed)
    const list = sessions.list.getSnapshot()
    return {
      workspaces: workspaces.map(w => ({ id: w.workspaceId, label: w.title, path: w.path })),
      sessions: list.ids.flatMap(id => {
        const row = list.byId[id]
        if (row === undefined || row.origin === 'subagent' || row.parentId !== undefined || row.formatStatus === 'migration-required') return []
        const workspace = workspaces.find(w => w.sessionIds.includes(id))
        return [{ sessionId: id, workspaceId: workspace?.workspaceId ?? null, workspaceLabel: workspace?.title ?? row.cwd?.split('/').at(-1) ?? 'DSH', sessionLabel: row.displayTitle, cwd: row.cwd ?? workspace?.path ?? '' }]
      }),
    }
  }

  async bind(id: string | null): Promise<void> {
    this.lastNarrationTurn = -1
    this.lastHumanSequence = -1
    this.turnKey = null
    const selection = ++this.selection
    ++this.bindingVersion
    this.releaseBinding()
    this.available = false
    this.activity = 'idle'
    this.runKey = null
    this.replyPreview = ''
    this.lastPrompt = ''
    this.lastPromptRequestId = null
    this.pendingInput = null
    this.toolName = null
    this.queuedCount = 0
    this.state = undefined
    this.changed()
    if (id === null) return
    const sessions = this.sessions
    if (sessions === undefined) throw new Error(this.copy.requestFailed)
    const catalog = await this.catalog()
    if (selection !== this.selection) return
    const target = catalog.sessions.find(s => s.sessionId === id)
    if (target === undefined) { this.error = this.copy.missing; this.changed(); throw new Error(this.copy.missing) }
    const reference = sessions.retain(SessionId(id), { source: 'desktopCompanion' })
    this.reference = reference
    try {
      const binding = await reference.ready
      if (selection !== this.selection || this.reference !== reference) return
      if (binding.session.getSnapshot().openState !== 'open') throw new Error(this.copy.missing)
      this.store.data.binding = target
      await this.store.save()
      if (selection !== this.selection || this.reference !== reference) return
      this.error = null
      this.available = true
      const update = (): void => {
        if (this.updateTimer !== undefined) return
        this.updateTimer = setTimeout(() => {
          this.updateTimer = undefined
          if (selection === this.selection) this.project(binding)
        }, 60)
      }
      this.unwatch = [binding.eventSource.subscribe(update), binding.session.subscribe(update)]
      // First baseline must not celebrate an old result.
      this.project(binding, true)
      await this.poll(selection)
    } catch (error) {
      if (this.reference === reference) { this.releaseBinding(); this.error = this.copy.missing; this.changed() }
      throw error
    }
  }

  async create(workspaceId: string): Promise<void> {
    const catalog = await this.catalog()
    if (!catalog.workspaces.some(w => w.id === workspaceId)) throw new Error(this.copy.changed)
    const id = await this.sessions!.create({ workspaceId: workspaceId as WorkspaceId })
    await this.bind(id)
  }

  private async poll(selection: number): Promise<void> {
    clearTimeout(this.timer)
    const pollRequest = ++this.pollRequest
    const ctx = this.ctx
    const reference = this.reference
    if (this.suspended || ctx === undefined || reference === undefined || selection !== this.selection) return
    try {
      const result = await ctx.remote.session.state({ sessionId: reference.sessionId }, AbortSignal.timeout(5000))
      if (selection !== this.selection || reference !== this.reference || pollRequest !== this.pollRequest) return
      if (!result.ok) throw new Error(this.copy.missing)
      this.state = result.value
      this.available = true
      if (this.error === this.copy.requestFailed) this.error = null
      this.sessions!.handleSessionStatus(reference.sessionId, result.value.running)
      this.project(reference.binding)
    } catch (_error: unknown) {
      if (selection !== this.selection || pollRequest !== this.pollRequest) return
      this.available = false
      this.error = this.copy.requestFailed
      this.changed()
    }
    if (!this.suspended && selection === this.selection && pollRequest === this.pollRequest) this.timer = setTimeout(() => { void this.poll(selection) }, this.state?.running ? 700 : 2000)
  }

  private project(binding: SessionBinding, initial = false): void {
    const entries = binding.eventSource.getSnapshot().entries
    const human = entries.findLast(entry => entry.event.type === 'user/message' && entry.event.data.source.kind === 'user')?.event
    if (human !== undefined && human.seq !== this.lastHumanSequence) {
      this.lastHumanSequence = human.seq
      if (!initial) this.userStarted?.(binding.sessionId)
    }
    const start = entries.findLast(entry => entry.event.type === 'turn/start')?.event
    const tail = start === undefined ? [] : entries.filter(entry => entry.event.seq >= start.seq)
    const end = tail.findLast(entry => entry.event.type === 'turn/end')?.event
    const session = binding.session.getSnapshot()
    const running = this.state?.running ?? session.running
    this.runKey = start?.type === 'turn/start' && end === undefined ? `${binding.sessionId}:${start.seq}` : null
    this.turnKey = start?.type === 'turn/start' ? `${binding.sessionId}:${start.seq}` : null
    this.pendingInput = this.state?.pendingInput[0] ?? null
    this.queuedCount = this.state?.queue?.filter(item => item.placement === 'queued').length ?? 0
    const tools = new Map<string, string>()
    for (const { event } of tail) {
      if (event.type === 'tool/call') tools.set(event.data.callId, event.data.name)
      if (event.type === 'tool/result') tools.delete(event.data.message.toolCallId)
    }
    this.toolName = tools.values().next().value ?? null
    this.activity = this.pendingInput !== null ? 'awaiting-user'
      : end?.type === 'turn/end' && !running ? end.data.reason.kind === 'completed' ? 'completed'
        : end.data.reason.kind === 'aborted' ? 'cancelled' : 'failed'
        : running ? this.toolName !== null ? 'tool-running' : 'thinking'
          : (this.state?.queue?.length ?? 0) > 0 ? 'queued' : 'idle'
    const preview = replyText(tail)
    this.previewTruncated = preview.length > 20_000
    this.replyPreview = preview.slice(-20_000)
    if (start?.type === 'turn/start' && initial) this.lastNarrationTurn = start.seq
    if (start?.type === 'turn/start' && !initial && start.seq !== this.lastNarrationTurn) {
      const cue = narrationCue(preview)
      if (cue.expressions.length > 0 || cue.motion !== undefined) {
        this.lastNarrationTurn = start.seq
        this.narrated?.(cue)
      }
    }
    const user = entries.findLast(entry => entry.event.type === 'user/message' && entry.event.data.source.kind === 'user' && 'rpcId' in entry.event.data.source)?.event
    if (user?.type === 'user/message') {
      this.lastPrompt = user.data.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n').slice(0, 2000)
      this.lastPromptRequestId = user.data.source.kind === 'user' && 'rpcId' in user.data.source ? user.data.source.rpcId : null
    }
    // Durable user-message admission and inbox request IDs reconcile a lost HTTP receipt.
    for (const submission of this.store.data.submissions) {
      if (submission.sessionId !== binding.sessionId || submission.phase === 'accepted') continue
      const observed = entries.some(({ event }) => event.type === 'user/message' && event.data.source.kind === 'user' && 'rpcId' in event.data.source && event.data.source.rpcId === submission.requestId)
        || this.state?.queue?.some(item => item.rpcId === submission.requestId) === true
      if (observed) this.accept(submission.requestId)
    }
    if (end?.type === 'turn/end') {
      const key = `${binding.sessionId}:${end.seq}`
      if (!this.store.data.recentResults.includes(key)) {
        this.store.data.recentResults = [...this.store.data.recentResults, key].slice(-64)
        void this.store.save().catch(() => {})
        if (!initial && (this.activity === 'completed' || this.activity === 'failed')) this.result(key, this.activity)
      }
    }
    this.changed()
  }

  async send(input: { sessionId: string; bindingVersion: number; requestId: string; text: string }): Promise<void> {
    const reference = this.reference
    if (reference === undefined || !this.available || this.connectionState !== 'online' || input.bindingVersion !== this.bindingVersion || reference.sessionId !== input.sessionId) throw new Error(this.copy.changed)
    if (this.sending.has(input.sessionId)) return
    const prior = this.store.data.submissions.find(s => s.requestId === input.requestId)
    if (prior !== undefined && (prior.sessionId !== input.sessionId || prior.text !== input.text)) throw new Error(this.copy.changed)
    if (prior?.phase === 'accepted') return
    // A submission retains its original Session even if the panel rebinds while
    // the disk write or Host admission is pending.
    const sendingReference = this.sessions!.retain(reference.sessionId, { source: 'desktopCompanion' })
    const submission = prior ?? { ...input, phase: 'sending' as const }
    if (prior === undefined) {
      const submissions = [...this.store.data.submissions]
      if (submissions.length >= 32) {
        const settled = submissions.findIndex(item => item.phase === 'accepted' || item.phase === 'rejected')
        if (settled < 0) { sendingReference.release(); throw new Error(this.copy.uncertain) }
        submissions.splice(settled, 1)
      }
      this.store.data.submissions = [...submissions, submission]
    }
    submission.phase = 'sending'
    this.store.data.drafts[input.sessionId] = input.text
    this.sending.add(input.sessionId)
    this.error = null
    this.changed()
    try {
      // Persist before admission; app restarts never create a new request for an uncertain send.
      await this.store.save()
      const result = await sendingReference.binding.session.prompt([{ type: 'text', text: input.text }], 'queue', AbortSignal.timeout(30_000), input.requestId as SessionRequestId)
      if (result.ok) this.accept(input.requestId)
      else if (this.store.data.submissions.find(item => item.requestId === input.requestId)?.phase !== 'accepted') {
        submission.phase = result.error.code.startsWith('transport/') || result.error.code.startsWith('gateway/') ? 'uncertain' : 'rejected'
        if (reference === this.reference) this.error = result.error.code === 'session/model-unavailable' ? this.copy.noModel : this.copy.requestFailed
      }
    } catch (_error: unknown) {
      if (this.store.data.submissions.find(item => item.requestId === input.requestId)?.phase !== 'accepted') submission.phase = 'uncertain'
      if (reference === this.reference) this.error = this.copy.uncertain
    } finally {
      this.sending.delete(input.sessionId)
      sendingReference.release()
      await this.store.save()
      if (reference === this.reference) { this.changed(); void this.poll(this.selection) }
    }
  }

  private accept(requestId: string): void {
    const submission = this.store.data.submissions.find(s => s.requestId === requestId)
    if (submission === undefined || submission.phase === 'accepted') return
    submission.phase = 'accepted'
    if (this.store.data.drafts[submission.sessionId] === submission.text) this.store.data.drafts[submission.sessionId] = ''
    if (this.store.data.binding?.sessionId === submission.sessionId) this.error = null
    void this.store.save().catch(() => {})
    this.changed()
  }

  async cancel(sessionId: string, runKey: string): Promise<void> {
    if (this.ctx === undefined || !this.available || this.reference?.sessionId !== sessionId || this.runKey !== runKey) throw new Error(this.copy.staleRun)
    const seq = Number(runKey.slice(sessionId.length + 1))
    if (!Number.isSafeInteger(seq) || seq < 0) throw new Error(this.copy.staleRun)
    const result = await this.ctx.remote.session.cancel({ sessionId: SessionId(sessionId), expectedTurnStartSeq: SessionSeq(seq) })
    if (!result.ok) throw new Error(this.copy.staleRun)
    // Receipt means stop requested. Only the next authoritative snapshot can report stopped.
    await this.poll(this.selection)
  }

  reconnect(): void { this.connection?.reconnect() }

  pause(): void { this.suspended = true; ++this.pollRequest; clearTimeout(this.timer) }
  resume(): void { this.suspended = false; this.reconnect() }

  private releaseBinding(): void {
    ++this.pollRequest
    clearTimeout(this.timer)
    clearTimeout(this.updateTimer)
    this.updateTimer = undefined
    for (const unsubscribe of this.unwatch) unsubscribe()
    this.unwatch = []
    this.reference?.release()
    this.reference = undefined
  }

  async disconnect(): Promise<void> {
    ++this.epoch
    ++this.selection
    this.releaseBinding()
    this.available = false
    this.connectionState = 'offline'
    const ctx = this.ctx
    this.ctx = undefined
    this.sessions = undefined
    this.connection = undefined
    this.changed()
    await ctx?.fiber.dispose()
  }
}

/** Preview reads the reconciled Session window and the canonical block assembler. */
function replyText(entries: readonly SessionEventLikeEntry[]): string {
  const parts: string[] = []
  const live = new Map<string, BlockAssembler>()
  for (const { event } of entries) {
    if (event.type === 'assistant/message') parts.push(event.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n'))
    if (event.type === 'assistant/live-chunk') {
      let assembler = live.get(event.data.attemptId)
      if (assembler === undefined) { assembler = new BlockAssembler(); live.set(event.data.attemptId, assembler) }
      assembler.push(event.data.chunk)
    }
  }
  for (const assembler of live.values()) parts.push(assembler.interruptedBlocks().flatMap(block => block.type === 'text' ? [block.text] : []).join('\n'))
  return parts.filter(Boolean).join('\n\n')
}
