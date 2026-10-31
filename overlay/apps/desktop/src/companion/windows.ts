/** Companion windows, tray, trusted IPC, and local-only reactions share one owner. */
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { app, BrowserWindow, globalShortcut, ipcMain, Menu, nativeImage, powerMonitor, screen, shell, Tray, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import { z } from 'zod'
import { COMPANION_IPC, type CompanionSnapshot, type CompanionResult, type CompanionCatalog } from './api.ts'
import { companionCopy } from './copy.ts'
import { CompanionStore, isQuietTime, preferencesSchema } from './store.ts'
import { DshCompanionAdapter } from './adapter.ts'
import { AVATAR_EXPRESSIONS, AVATAR_HOTKEYS, AVATAR_MOTIONS, advanceAvatarDance, avatarActionSchema, avatarPreferencesSchema, type AvatarAction, type AvatarDanceSchedule, type AvatarPlayback, type AvatarAgentPose, type AvatarExpression, type AvatarMotion } from './avatar.ts'
import { CompanionAgentBridge } from './agent-bridge.ts'
import type { AgentAvatarRequest, AgentAvatarReceipt, AgentCompanionRequest } from './agent-protocol.ts'
import { NOTIFICATION_EMOTIONS, type AgentNotificationRequest, type NotificationSpeech, type NotificationSnapshot } from './notification.ts'

const id = z.string().min(1).max(200)
const commandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.enum(['show-panel', 'show-reply', 'show-avatar', 'hide-panel', 'settings', 'menu', 'pat', 'reset-position', 'reset-store', 'reconnect']) }),
  z.object({ type: z.literal('avatar'), action: avatarActionSchema }),
  z.object({ type: z.enum(['avatar-started', 'avatar-finished', 'avatar-applied']), sequence: z.number().int().min(0) }),
  z.object({ type: z.literal('avatar-motion'), reduced: z.boolean() }),
  z.object({ type: z.literal('avatar-model'), phase: z.enum(['loading', 'ready', 'failed']) }),
  z.object({ type: z.literal('avatar-body'), body: z.number().int().min(0).max(2) }),
  z.object({ type: z.literal('avatar-face'), y: z.number().min(0).max(1) }),
  z.object({ type: z.enum(['notification-shown', 'notification-dismiss', 'notification-open']), id: z.string().min(1).max(401) }),
  z.object({ type: z.literal('notification-layout'), id: z.string().min(1).max(401), height: z.number().int().min(80).max(500) }),
  z.object({ type: z.literal('panel-layout'), view: z.enum(['chat', 'utility']), height: z.number().int().min(88).max(900) }),
  z.object({ type: z.literal('bind'), sessionId: id }), z.object({ type: z.literal('create'), workspaceId: id }),
  z.object({ type: z.literal('draft'), sessionId: id, text: z.string().max(32_000), bindingVersion: z.number().int().nonnegative() }),
  z.object({ type: z.literal('send'), sessionId: id, text: z.string().min(1).max(32_000).refine(value => value.trim().length > 0), bindingVersion: z.number().int().nonnegative(), requestId: z.string().uuid() }),
  z.object({ type: z.literal('cancel'), sessionId: id, runKey: id }),
  z.object({ type: z.literal('open-workbench'), sessionId: id.optional() }),
  z.object({ type: z.literal('preferences'), value: preferencesSchema.partial().extend({ avatar: avatarPreferencesSchema.optional() }).strict() }),
  z.object({ type: z.literal('shortcut-recording'), active: z.boolean() }),
  z.object({ type: z.literal('drag'), phase: z.enum(['start', 'move', 'end']), point: z.object({ x: z.number().finite().min(-100_000).max(100_000), y: z.number().finite().min(-100_000).max(100_000) }) }),
  z.object({ type: z.literal('interactive'), value: z.boolean() }),
])
type Role = 'pet' | 'panel' | 'notice'
interface OwnedWindow { window: BrowserWindow; role: Role; subscribed: boolean }

export interface CompanionWindowOptions {
  locale: () => 'zh' | 'en'
  openWorkbench: (sessionId?: string) => Promise<void>
}

/** Construct after app readiness and dispose before the existing Host shutdown path. */
export class CompanionWindows {
  readonly store: CompanionStore
  private readonly adapter: DshCompanionAdapter
  private readonly epoch = randomUUID()
  private revision = 0
  private readonly windows = new Map<number, OwnedWindow>()
  private pet: BrowserWindow | undefined
  private panel: BrowserWindow | undefined
  private panelView: 'chat' | 'utility' = 'chat'
  private panelHeight = 88
  private tray: Tray | undefined
  private shortcut: string | undefined
  private shortcutError = false
  private shortcutRecording = false
  private suspended = false
  private reaction: CompanionSnapshot['reaction'] = null
  private reactionTimer: ReturnType<typeof setTimeout> | undefined
  private greetingTimer: ReturnType<typeof setInterval> | undefined
  private lastPat = 0
  private avatarQueue: AvatarPlayback[] = []
  private avatarSequence = 0
  private avatarResetSequence = 0
  private avatarManualHands = false
  private avatarHovered = false
  private systemReducedMotion = false
  private avatarModelPhase: 'loading' | 'ready' | 'failed' = 'loading'
  private avatarDance: AvatarDanceSchedule = { idleSince: null, nextCheckAt: null, cooldownUntil: 0 }
  private danceTimer: ReturnType<typeof setTimeout> | undefined
  private playbackTimer: ReturnType<typeof setTimeout> | undefined
  private authorHotkeysEnabled = false
  private readonly authorHotkeys: string[] = []
  private avatarShortcutErrors: string[] = []
  private readonly agentBridge = new CompanionAgentBridge()
  private agentPose: AvatarAgentPose | null = null
  private agentPoseTimer: ReturnType<typeof setTimeout> | undefined
  private agentReturnMotion: AvatarMotion | undefined
  private agentMutedRun: string | undefined
  private readonly agentPending = new Map<number, (receipt: AgentAvatarReceipt) => void>()
  private notice: BrowserWindow | undefined
  private noticeHeight = 80
  private noticeSide: 'left' | 'right' = 'left'
  private avatarFaceY: number | null = null
  private presentedNotification: string | undefined
  private notificationSpeech: NotificationSpeech | null = null
  private notificationAnimation: Promise<object> | null = null
  private readonly notificationAdmissions = new Set<string>()
  private readonly notificationPending = new Map<string, (receipt: object) => void>()
  private disposed = false
  private drag: { cursor: Electron.Point; bounds: Electron.Rectangle; moved: boolean } | undefined
  private readonly displayChanged = (): void => { this.restorePosition(); this.positionPanel(); this.positionNotification() }
  private readonly suspend = (): void => { this.suspended = true; this.adapter.pause(); this.publish() }
  private readonly resume = (): void => { this.suspended = false; this.restorePosition(); this.adapter.resume(); this.publish() }

  constructor(private readonly options: CompanionWindowOptions) {
    this.store = new CompanionStore(join(app.getPath('userData'), 'companion'), () => { this.publish() })
    this.adapter = new DshCompanionAdapter(this.store, () => { this.publish() }, options.locale, (_key, activity) => {
      if (!isQuietTime(this.store.data.preferences)) this.react(activity, activity === 'completed' ? this.copy.doneLine : this.copy.failedLine)
    }, cue => {
      if (!this.store.data.preferences.avatar.textReactions || this.agentPose !== null && this.agentPose.source !== 'text') return
      const sessionId = this.store.data.binding?.sessionId
      if (sessionId !== undefined) void this.performAgentAction({ sessionId, operation: 'perform', ...cue, seconds: 4 }, AbortSignal.timeout(5000), 'text')
        .catch((_error: unknown) => { console.error('Companion narration reaction could not complete') })
    }, sessionId => {
      void this.dismissNotifications(this.store.data.notifications.filter(item => item.sessionId === sessionId).map(item => item.id))
        .catch((_error: unknown) => { this.adapter.error = this.copy.requestFailed; this.publish() })
    })
  }

  private get copy(): ReturnType<typeof companionCopy> { return companionCopy(this.options.locale()) }

  async start(): Promise<void> {
    await this.store.load()
    this.avatarManualHands = this.store.data.preferences.avatar.expressions.some(id => AVATAR_EXPRESSIONS[id].exclusive === 'point')
    if (this.disposed) return
    ipcMain.handle(COMPANION_IPC.command, (event, value: unknown) => this.command(event, value))
    ipcMain.handle(COMPANION_IPC.catalog, async (event): Promise<CompanionResult<CompanionCatalog>> => {
      try {
        this.assertSender(event, 'panel')
        return { ok: true, value: await this.adapter.catalog() }
      } catch (_error: unknown) { return { ok: false, error: this.copy.requestFailed } }
    })
    ipcMain.on(COMPANION_IPC.subscribe, this.subscribe)
    ipcMain.on(COMPANION_IPC.unsubscribe, this.unsubscribe)
    this.pet = this.create('pet')
    this.panel = this.create('panel')
    this.notice = this.create('notice')
    await this.agentBridge.start(join(app.getPath('userData'), 'companion'), (request, signal) => this.receiveAgentRequest(request, signal))
    this.restorePosition()
    this.applyPreferences()
    const icon = nativeImage.createFromBuffer(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAACwAAAAkCAYAAADy19hsAAAACXBIWXMAAAsTAAALEwEAmpwYAAABsUlEQVRYhe3WPUvDQBzH8W+dRBFFcBIcFHTTRVBwl5bi6CBYHHzEh8VJBLHoC/AF+DCJDqKCDr4IN6m+gDQoKAqKEATbk4NTQkhtruk1GfKDP4Qc4f/J9e5SCJ8UMK0qFeB+5MkBQpW8lmkCDn3uxyJ5FyzvgxVxB7tnXCi8fInYLolc3LDtwDiwAKwDGwq2C3TFZbO1AsvAHVD2/OTeKgBbQH8UUDlDK8BrFaRfyRc7BnoahW0GzmqAessBZhoxs+d1wApX7ZgEr9UZK1TNmToF3gyBv4CBeoOXDGGFqssAhnkd8JVhcBno+6f/BGDrgC2/RtlsVti2LYrFoshkMmHRmxV6DwOfwIMO2PFrIqG/sSwrLPjGp28v8KTGr+MGtj09R4FH1/i2Dtj94F/JZSDREptOp8OCHaADGAMOgG/PeFYHXDC86USVegdadMCnEYP30cxqxOARXbA8I0sRYU+oMRcRYD+A7lrBg5WON4Nfv0lCZrZB2BKwGBbrRpuc6WfdMzdIhtSaLtV5ve4BnRhMnzry5E6+V19EJ+B/4BfgFjgCpoA2k9AkSZIkSYKx/ADOzGb+6y7AVAAAAABJRU5ErkJggg==', 'base64'), { scaleFactor: 2 })
    icon.setTemplateImage(true)
    this.tray = new Tray(icon)
    this.tray.setToolTip('DSH Companion')
    this.refreshMenu()
    screen.on('display-added', this.displayChanged)
    screen.on('display-removed', this.displayChanged)
    screen.on('display-metrics-changed', this.displayChanged)
    powerMonitor.on('suspend', this.suspend)
    powerMonitor.on('lock-screen', this.suspend)
    powerMonitor.on('resume', this.resume)
    powerMonitor.on('unlock-screen', this.resume)
    this.greetingTimer = setInterval(() => { this.greet(); this.publish() }, 60_000)
  }

  async connect(url: string, cookie: string): Promise<void> {
    if (this.disposed) return
    try { await this.adapter.connect(url, cookie) }
    catch (_error: unknown) { this.adapter.error = this.copy.requestFailed; this.publish() }
  }

  private create(role: Role): BrowserWindow {
    const pet = role === 'pet'
    const window = new BrowserWindow({
      width: pet ? 220 : role === 'notice' ? 220 : 480, height: pet ? 405 : role === 'notice' ? 80 : 88, show: false,
      title: pet ? 'DSH Companion' : role === 'notice' ? this.copy.notificationNew : 'DSH Quick Panel',
      frame: false, transparent: true, backgroundColor: '#00000000',
      resizable: false, maximizable: false, minimizable: false, fullscreenable: false,
      hasShadow: false, focusable: !pet, skipTaskbar: true,
      webPreferences: { preload: join(app.getAppPath(), 'lib', 'preload-companion.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: true },
    })
    const record: OwnedWindow = { window, role, subscribed: false }
    window.on('page-title-updated', event => { event.preventDefault() })
    const contentsId = window.webContents.id
    this.windows.set(contentsId, record)
    window.webContents.on('console-message', details => {
      if (details.level === 'error') console.error(`companion ${role}:`, details.message)
    })
    window.webContents.on('preload-error', (_event, _path, error) => { console.error(`companion ${role} preload:`, error.message) })
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false, skipTransformProcessType: true })
    window.webContents.setWindowOpenHandler(({ url }) => {
      if (role === 'panel' && URL.canParse(url)) {
        const destination = new URL(url)
        if (['http:', 'https:'].includes(destination.protocol) && !destination.username && !destination.password) {
          void shell.openExternal(destination.href).catch((_error: unknown) => { this.adapter.error = this.copy.requestFailed; this.publish() })
        }
      }
      return { action: 'deny' }
    })
    window.webContents.on('will-navigate', event => { event.preventDefault() })
    window.webContents.on('will-attach-webview', event => { event.preventDefault() })
    if (role === 'panel') window.webContents.on('before-input-event', (event, input) => {
      if (this.shortcutRecording) return
      if (input.type !== 'keyDown' || input.alt || !(process.platform === 'darwin' ? input.meta : input.control)) return
      // Native application-menu edit roles otherwise target the workbench.
      // Keep editing in the Quick Panel's own focused field.
      switch (input.key.toLowerCase()) {
        case 'a': event.preventDefault(); window.webContents.selectAll(); break
        case 'c': event.preventDefault(); window.webContents.copy(); break
        case 'x': event.preventDefault(); window.webContents.cut(); break
        case 'v': event.preventDefault(); window.webContents.paste(); break
        case 'z': event.preventDefault(); if (input.shift) window.webContents.redo(); else window.webContents.undo(); break
        case 'y': event.preventDefault(); window.webContents.redo(); break
      }
    })
    if (role === 'notice') window.webContents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown' || input.key !== 'Escape') return
      const message = this.notificationSnapshot()
      if (message === null) return
      event.preventDefault()
      void this.dismissNotifications([message.id]).catch((_error: unknown) => { this.adapter.error = this.copy.requestFailed; this.publish() })
    })
    window.webContents.on('render-process-gone', () => {
      if (role === 'panel') this.setShortcutRecording(false)
      if (!this.disposed) { record.subscribed = false; void window.loadURL(`dsh-app://companion/index.html?view=${role}`) }
    })
    window.on('closed', () => { this.windows.delete(contentsId) })
    window.on('close', event => { if (!this.disposed) { event.preventDefault(); window.hide(); this.publish() } })
    if (role === 'panel') {
      window.on('blur', () => { if (!this.disposed && window.isVisible()) window.hide() })
      window.on('hide', () => { this.setShortcutRecording(false); this.publish() })
    }
    if (pet) {
      window.setIgnoreMouseEvents(true, { forward: true })
      window.webContents.once('did-finish-load', () => { if (this.store.data.preferences.visible) window.showInactive() })
    }
    void window.loadURL(`dsh-app://companion/index.html?view=${role}`).catch((_error: unknown) => { this.adapter.error = this.copy.requestFailed; this.publish() })
    return window
  }

  private assertSender(event: IpcMainEvent | IpcMainInvokeEvent, role?: Role): OwnedWindow {
    const record = this.windows.get(event.sender.id)
    if (this.disposed || record === undefined || record.window.isDestroyed() || event.sender !== record.window.webContents
      || event.senderFrame === null || event.senderFrame !== event.sender.mainFrame || role !== undefined && record.role !== role) throw new Error('Companion sender rejected')
    const url = new URL(event.senderFrame.url)
    if (url.protocol !== 'dsh-app:' || url.hostname !== 'companion' || url.pathname !== '/index.html' || url.searchParams.get('view') !== record.role) throw new Error('Companion origin rejected')
    return record
  }

  private readonly subscribe = (event: IpcMainEvent): void => {
    try {
      const record = this.assertSender(event)
      record.subscribed = true
      // Register first, then immediately deliver the current complete snapshot.
      event.sender.send(COMPANION_IPC.snapshot, this.snapshot())
      if (record.role === 'notice') this.publish()
    } catch (error) { console.error('companion subscription rejected:', error instanceof Error ? error.message : 'unknown failure') }
  }
  private readonly unsubscribe = (event: IpcMainEvent): void => {
    try { this.assertSender(event).subscribed = false }
    catch (_error: unknown) { /* A destroyed or navigated frame has no subscription. */ }
  }

  private snapshot(): CompanionSnapshot {
    const data = this.store.data
    const binding = data.binding
    const submission = data.submissions.findLast(s => s.sessionId === binding?.sessionId) ?? null
    return {
      schemaVersion: 1, bridgeEpoch: this.epoch, revision: ++this.revision, bindingVersion: this.adapter.bindingVersion,
      locale: this.options.locale(), binding, connection: this.adapter.connectionState, activity: this.adapter.activity,
      runKey: this.adapter.runKey, replyPreview: this.adapter.replyPreview, previewTruncated: this.adapter.previewTruncated,
      lastPrompt: this.adapter.lastPrompt, lastPromptRequestId: this.adapter.lastPromptRequestId, toolName: this.adapter.toolName, pendingInput: this.adapter.pendingInput,
      queuedCount: this.adapter.queuedCount,
      canSend: this.adapter.available && this.adapter.connectionState === 'online' && !this.store.failed && submission?.phase !== 'sending',
      canCancel: this.adapter.available && this.adapter.connectionState === 'online' && this.adapter.runKey !== null,
      draft: binding === null ? data.drafts['unbound'] ?? '' : data.drafts[binding.sessionId] ?? '',
      submission, preferences: data.preferences, error: this.adapter.error, shortcutError: this.shortcutError,
      storeError: this.store.failed, reaction: this.reaction,
      notification: this.notificationSnapshot(),
      motionPaused: this.suspended || this.pet?.isVisible() !== true,
      panelVisible: this.panel?.isVisible() === true,
      avatar: { playback: this.avatarQueue[0] === undefined ? null : { ...this.avatarQueue[0] }, queued: Math.max(0, this.avatarQueue.length - 1),
        resetSequence: this.avatarResetSequence, manualHands: this.avatarManualHands, shortcutErrors: [...this.avatarShortcutErrors], agent: this.agentPose,
        motionBlocked: this.avatarMotionBlocked(), modelPhase: this.avatarModelPhase,
        danceState: !data.preferences.avatar.autoDance ? 'disabled' : isQuietTime(data.preferences) ? 'quiet'
          : this.avatarQueue[0]?.automatic ? 'playing' : this.avatarMotionBlocked() ? 'motion'
            : this.avatarHovered || this.panel?.isVisible() === true ? 'interaction'
              : this.avatarDance.cooldownUntil > Date.now() ? 'cooldown' : 'waiting' },
    }
  }

  private publish(): void {
    if (this.disposed) return
    if (this.agentPose !== null && (this.avatarUnavailable() || !this.store.data.preferences.avatar.agentActions
      || this.adapter.connectionState !== 'online' || this.adapter.activity === 'cancelled')) this.clearAgentActions('unavailable')
    this.reconcileNotifications()
    this.reconcileDance()
    const snapshot = this.snapshot()
    for (const { window, subscribed } of this.windows.values()) if (subscribed && !window.isDestroyed()) window.webContents.send(COMPANION_IPC.snapshot, snapshot)
  }

  private async command(event: IpcMainInvokeEvent, value: unknown): Promise<CompanionResult> {
    try {
      const record = this.assertSender(event)
      const parsed = commandSchema.safeParse(value)
      if (!parsed.success) return { ok: false, error: this.copy.invalid }
      const command = parsed.data
      const noticeCommands = ['notification-shown', 'notification-layout', 'notification-dismiss', 'notification-open']
      if (record.role === 'notice' && !noticeCommands.includes(command.type)) return { ok: false, error: this.copy.invalid }
      if (record.role !== 'notice' && noticeCommands.includes(command.type)
        && !(record.role === 'pet' && command.type === 'notification-open')) return { ok: false, error: this.copy.invalid }
      if (record.role === 'pet' && !['show-panel', 'show-reply', 'show-avatar', 'menu', 'pat', 'drag', 'interactive', 'open-workbench', 'avatar-started', 'avatar-finished', 'avatar-applied', 'avatar-motion', 'avatar-model', 'avatar-body', 'avatar-face', 'notification-open'].includes(command.type)) return { ok: false, error: this.copy.invalid }
      if (record.role !== 'pet' && ['avatar-started', 'avatar-finished', 'avatar-applied', 'avatar-motion', 'avatar-model', 'avatar-face'].includes(command.type)) return { ok: false, error: this.copy.invalid }
      if (!['avatar-started', 'avatar-finished', 'avatar-applied', 'avatar-model', 'avatar-motion', 'avatar-face', 'panel-layout', 'interactive', 'notification-shown', 'notification-layout'].includes(command.type)) this.avatarInteracted()
      if (['avatar', 'avatar-body', 'bind', 'create', 'reset-store'].includes(command.type)) {
        this.clearAgentActions('manual-control')
        if (command.type === 'avatar' && command.action.kind === 'stop') this.agentMutedRun = this.agentRunKey()
        this.notificationSpeech = null
      }
      switch (command.type) {
        case 'show-panel': this.showPanel(); break
        case 'show-reply': this.showPanel('reply'); break
        case 'show-avatar': this.showPanel('avatar'); break
        case 'panel-layout': this.panelView = command.view; this.panelHeight = command.height; this.positionPanel(); break
        case 'hide-panel': this.panel?.hide(); this.publish(); break
        case 'settings': this.showPanel('settings'); break
        case 'menu': Menu.buildFromTemplate(this.menu()).popup({ window: record.window }); break
        case 'pat': if (Date.now() - this.lastPat > 1500) { this.lastPat = Date.now(); this.react('pat', this.copy.patLine) }; break
        case 'avatar': await this.applyAvatarAction(command.action); break
        case 'avatar-body': await this.applyAvatarAction({ kind: 'expression', id: (['body-normal', 'body-small', 'body-chibi'] as const)[command.body]! }); break
        case 'avatar-motion': this.systemReducedMotion = command.reduced; break
        case 'avatar-model': this.avatarModelPhase = command.phase; break
        case 'avatar-started': {
          const playback = this.avatarQueue[0]
          if (playback?.sequence !== command.sequence || playback.started) break
          playback.started = true
          if (playback.agent) this.agentPending.get(command.sequence)?.({ ok: true, status: 'started', sequence: command.sequence })
          clearTimeout(this.playbackTimer)
          this.playbackTimer = setTimeout(() => { this.finishAvatar(command.sequence); this.publish() }, (AVATAR_MOTIONS[playback.motion].seconds + 1) * 1000)
          break
        }
        case 'avatar-finished': this.finishAvatar(command.sequence); break
        case 'avatar-applied': {
          if (this.agentPose?.sequence === command.sequence && !this.avatarQueue.some(item => item.sequence === command.sequence)) {
            this.agentPending.get(command.sequence)?.({ ok: true, status: 'applied', sequence: command.sequence })
          }
          break
        }
        case 'bind': {
          const current = this.notificationSnapshot()
          await this.adapter.bind(command.sessionId)
          if (current !== null) await this.dismissNotifications([current.id])
          break
        }
        case 'create': {
          const current = this.notificationSnapshot()
          await this.adapter.create(command.workspaceId)
          if (current !== null) await this.dismissNotifications([current.id])
          break
        }
        case 'draft': {
          if (command.bindingVersion !== this.adapter.bindingVersion || command.sessionId !== (this.store.data.binding?.sessionId ?? 'unbound')) throw new Error(this.copy.changed)
          this.store.data.drafts[command.sessionId] = command.text
          await this.store.save()
          break
        }
        case 'send': {
          await this.adapter.send(command)
          if (this.store.data.submissions.some(item => item.requestId === command.requestId && item.phase === 'accepted')) {
            await this.dismissNotifications(this.store.data.notifications.filter(item => item.sessionId === command.sessionId).map(item => item.id))
          }
          break
        }
        case 'notification-shown': {
          const current = this.notificationSnapshot()
          if (current?.id !== command.id || this.notice?.isVisible() !== true) throw new Error(this.copy.changed)
          const stored = this.store.data.notifications.find(item => item.id === command.id)
          if (stored !== undefined && !stored.announced) { stored.announced = true; await this.store.save() }
          this.notificationPending.get(command.id)?.({ ok: true, status: 'displayed', notificationId: command.id })
          break
        }
        case 'notification-layout':
          if (this.notificationSnapshot()?.id === command.id) { this.noticeHeight = command.height; this.positionNotification() }
          break
        case 'avatar-face': this.avatarFaceY = command.y; this.positionNotification(); break
        case 'notification-dismiss': await this.dismissNotifications([command.id]); break
        case 'notification-open': {
          const current = this.notificationSnapshot()
          if (current?.id !== command.id) throw new Error(this.copy.changed)
          if (this.store.data.binding?.sessionId !== current.sessionId) await this.adapter.bind(current.sessionId)
          this.showPanel('reply')
          await this.dismissNotifications([command.id])
          break
        }
        case 'cancel': await this.adapter.cancel(command.sessionId, command.runKey); break
        case 'open-workbench': {
          if (command.sessionId !== undefined && command.sessionId !== this.store.data.binding?.sessionId) throw new Error(this.copy.changed)
          await this.options.openWorkbench(command.sessionId)
          this.panel?.hide()
          break
        }
        case 'shortcut-recording': this.setShortcutRecording(command.active); break
        case 'preferences': {
          const previous = this.store.data.preferences
          const next = { ...previous }
          Object.assign(next, command.value)
          const shortcutChanged = next.shortcut !== previous.shortcut || next.shortcutEnabled !== previous.shortcutEnabled
          this.store.data.preferences = next
          if (shortcutChanged) {
            this.shortcutRecording = false
            this.refreshShortcut()
            if (this.shortcutError) {
              this.store.data.preferences = previous
              this.refreshShortcut()
              this.refreshAvatarHotkeys()
              throw new Error(this.copy.shortcutError)
            }
          }
          try { await this.store.save() }
          catch (error) {
            this.store.data.preferences = previous
            this.refreshShortcut()
            this.refreshAvatarHotkeys()
            throw error
          }
          this.applyPreferences()
          break
        }
        case 'reset-position': this.store.data.position = null; this.restorePosition(); await this.store.save(); this.positionPanel(); break
        case 'reset-store': await this.store.reset(); await this.adapter.bind(null); this.restorePosition(); this.applyPreferences(); break
        case 'reconnect': this.adapter.reconnect(); break
        case 'interactive': this.avatarHovered = command.value; if (command.value) this.avatarInteracted(); this.pet?.setIgnoreMouseEvents(!command.value, { forward: true }); break
        case 'drag': this.movePet(command.phase, command.point); break
      }
      this.publish()
      return { ok: true, value: undefined }
    } catch (error) {
      const messages = Object.values(this.copy)
      return { ok: false, error: error instanceof Error && messages.includes(error.message) ? error.message : this.copy.requestFailed }
    }
  }

  private notificationSnapshot(): NotificationSnapshot | null {
    if (!this.store.data.preferences.notifications) return null
    const message = this.store.data.notifications.find(item => !this.notificationAdmissions.has(item.id))
    const characters = Array.from(message?.text.replace(/\s+/gu, ' ') ?? '')
    const text = characters.length > 60 ? `${characters.slice(0, 59).join('')}…` : characters.join('')
    return message === undefined ? null : {
      ...message, text, unread: this.store.data.notifications.length, side: this.noticeSide,
      speech: this.notificationSpeech?.id === message.id ? this.notificationSpeech : null,
    }
  }

  private async receiveAgentRequest(request: AgentCompanionRequest, signal: AbortSignal): Promise<object> {
    if (request.operation === 'notify') return this.notifyOwner(request, signal)
    if (request.operation === 'read-notifications') {
      signal.throwIfAborted()
      await this.dismissNotifications(this.store.data.notifications
        .filter(item => item.sessionId === request.sessionId && item.createdAt <= request.before).map(item => item.id))
      return { ok: true, status: 'read' }
    }
    return this.performAgentAction(request, signal)
  }

  private async notifyOwner(request: AgentNotificationRequest, signal: AbortSignal): Promise<object> {
    if (this.disposed || this.store.failed || !this.store.data.preferences.notifications) {
      return { ok: false, status: 'unavailable', reason: 'Companion notifications or local storage are unavailable.' }
    }
    const source = request.sessionId === this.store.data.binding?.sessionId && this.adapter.available
      ? this.store.data.binding : (await this.adapter.catalog()).sessions.find(item => item.sessionId === request.sessionId)
    if (source === undefined || source === null) return { ok: false, status: 'refused', reason: 'Only an ordinary existing Session may notify the owner.' }
    const emotion = request.emotion ?? 'calm'
    const mood = NOTIFICATION_EMOTIONS[emotion]
    const expressions = [...new Set(request.expressions ?? mood.expressions)]
    const groups = expressions.flatMap(item => AVATAR_EXPRESSIONS[item].exclusive ?? [])
    if (groups.length !== new Set(groups).size) return { ok: false, status: 'invalid', reason: 'Select only one expression from each exclusive group.' }
    signal.throwIfAborted()
    if (this.disposed || this.store.failed || !this.store.data.preferences.notifications) return { ok: false, status: 'unavailable' }
    const id = `${request.sessionId}:${request.requestId}`
    if (this.store.data.readNotifications.includes(id)) return { ok: true, status: 'already-read', notificationId: id }
    const existing = this.store.data.notifications.find(item => item.id === id)
    if (existing !== undefined) return { ok: true, status: existing.announced ? 'displayed' : 'queued', notificationId: id }
    if (this.store.data.notifications.length >= 32) return { ok: false, status: 'refused', reason: 'There are 32 unread notifications. Wait for the owner to read them.' }
    this.notificationAdmissions.add(id)
    this.store.data.notifications.push({
      id, sessionId: source.sessionId, sessionLabel: source.sessionLabel, text: request.text, createdAt: Date.now(),
      emotion, motion: request.motion ?? mood.motion, expressions, announced: false,
    })
    try { await this.store.save() }
    catch (_error: unknown) {
      return { ok: false, status: 'unknown', reason: 'Notification storage could not be confirmed; do not claim delivery.' }
    } finally { this.notificationAdmissions.delete(id) }
    if (this.store.failed || this.disposed) return { ok: true, status: 'queued', notificationId: id }
    if (this.notificationSnapshot()?.id !== id || this.pet?.isVisible() !== true || this.suspended || signal.aborted) {
      this.publish()
      return { ok: true, status: 'queued', notificationId: id, unread: this.store.data.notifications.length }
    }
    const receipt = new Promise<object>(resolve => {
      const finish = (value: object): void => {
        clearTimeout(timer); signal.removeEventListener('abort', aborted); this.notificationPending.delete(id); resolve(value)
      }
      const aborted = (): void => { finish({ ok: true, status: 'queued', notificationId: id }) }
      const timer = setTimeout(() => { finish({
        ok: true, status: 'queued', notificationId: id, reason: 'Saved, but the bubble renderer has not acknowledged display.',
      }) }, 5000)
      this.notificationPending.set(id, finish)
      signal.addEventListener('abort', aborted, { once: true })
      if (signal.aborted) aborted()
    })
    this.publish()
    const animation = this.notificationAnimation
    return { ...await receipt, animation: animation === null ? { status: 'suppressed' } : await animation }
  }

  private async dismissNotifications(ids: readonly string[]): Promise<void> {
    const removed = this.store.data.notifications.filter(item => ids.includes(item.id))
    if (removed.length === 0) return
    this.store.data.notifications = this.store.data.notifications.filter(item => !ids.includes(item.id))
    this.store.data.readNotifications = [...this.store.data.readNotifications, ...removed.map(item => item.id)].slice(-64)
    if (removed.some(item => item.id === this.presentedNotification)) {
      this.notificationSpeech = null
      if (this.agentPose?.source === 'notification') this.clearAgentActions('notification-read', true)
    }
    await this.store.save()
    for (const item of removed) this.notificationPending.get(item.id)?.({ ok: true, status: 'read', notificationId: item.id })
    this.publish()
  }

  private reconcileNotifications(): void {
    const message = this.notificationSnapshot()
    const notice = this.notice
    if (message === null || notice === undefined || this.pet?.isVisible() !== true || this.suspended || this.store.failed) {
      notice?.hide()
      this.notificationSpeech = null
      if (message === null) { this.presentedNotification = undefined; this.notificationAnimation = null }
      return
    }
    this.positionNotification()
    if (!notice.isVisible()) notice.showInactive()
    const animate = !this.avatarUnavailable() && this.store.data.preferences.avatar.agentActions && !isQuietTime(this.store.data.preferences)
      && !this.avatarManualHands && this.agentMutedRun !== this.agentRunKey()
      && !this.avatarQueue.some(item => !item.agent && !item.automatic)
    if (!animate) this.notificationSpeech = null
    if (this.presentedNotification === message.id || !this.windows.get(notice.webContents.id)?.subscribed) return
    this.presentedNotification = message.id
    this.notificationAnimation = null
    this.notificationSpeech = null
    if (!message.announced && animate) {
      const charactersPerSecond = this.store.data.preferences.speechCharactersPerSecond
      this.notificationSpeech = { id: message.id, text: message.text, startedAt: Date.now(), charactersPerSecond,
        mouthForm: NOTIFICATION_EMOTIONS[message.emotion].mouthForm }
      this.notificationAnimation = this.performAgentAction({
        operation: 'perform', sessionId: message.sessionId, motion: message.motion, expressions: message.expressions,
        seconds: Math.max(1.2, Array.from(message.text).length / charactersPerSecond),
      }, new AbortController().signal, 'notification')
    }
  }

  private positionNotification(): void {
    if (this.notice === undefined || this.pet === undefined) return
    const pet = this.pet.getBounds()
    const area = screen.getDisplayMatching(pet).workArea
    const width = Math.min(220, area.width - 16)
    const height = Math.min(this.noticeHeight, area.height - 16)
    const inset = Math.round(pet.width * .18)
    const leftFits = pet.x - width + inset >= area.x + 8
    const rightFits = pet.x + pet.width - inset + width <= area.x + area.width - 8
    this.noticeSide = leftFits || !rightFits && pet.x > area.x + area.width / 2 ? 'left' : 'right'
    const x = this.noticeSide === 'left' ? pet.x - width + inset : pet.x + pet.width - inset
    const y = pet.y + pet.height * (this.avatarFaceY ?? .5) - height + 36
    this.notice.setBounds({
      width, height,
      x: Math.round(Math.max(area.x + 8, Math.min(x, area.x + area.width - width - 8))),
      y: Math.round(Math.max(area.y + 8, Math.min(y, area.y + area.height - height - 8))),
    })
  }

  showPanel(reveal: 'chat' | 'reply' | 'settings' | 'avatar' = 'chat'): void {
    if (this.panel === undefined || this.disposed) return
    this.setShortcutRecording(false)
    this.avatarInteracted()
    const view = reveal === 'settings' || reveal === 'avatar' || this.store.data.binding === null ? 'utility' : 'chat'
    if (view !== this.panelView) this.panelHeight = view === 'utility' ? 640 : 88
    this.panelView = view
    this.positionPanel()
    this.panel.show()
    this.panel.focus()
    this.panel.webContents.focus()
    this.panel.webContents.send(COMPANION_IPC.reveal, reveal)
    this.publish()
  }

  private applyPreferences(): void {
    const preferences = this.store.data.preferences
    if (this.pet !== undefined) {
      this.pet.setAlwaysOnTop(preferences.alwaysOnTop, 'floating')
      this.pet.setSize(preferences.size + 20, Math.round(preferences.size * 1.7) + 65)
      this.restorePosition()
      if (preferences.visible) this.pet.showInactive()
      else { this.pet.hide(); this.panel?.hide() }
    }
    this.panel?.setAlwaysOnTop(preferences.alwaysOnTop, 'floating')
    this.notice?.setAlwaysOnTop(preferences.alwaysOnTop, 'floating')
    this.positionPanel()
    this.refreshShortcut()
    this.refreshMenu()
    this.refreshAvatarHotkeys()
    this.publish()
  }

  private setShortcutRecording(active: boolean): void {
    if (this.disposed) return
    this.shortcutRecording = active
    this.refreshShortcut()
    this.refreshAvatarHotkeys()
  }

  private refreshShortcut(): void {
    const preferences = this.store.data.preferences
    this.panel?.webContents.setIgnoreMenuShortcuts(this.shortcutRecording)
    const desired = preferences.shortcutEnabled && !this.shortcutRecording ? preferences.shortcut : undefined
    this.shortcutError = false
    if (desired === this.shortcut) return
    if (this.shortcut !== undefined) globalShortcut.unregister(this.shortcut)
    this.shortcut = undefined
    if (desired !== undefined) {
      try {
        if (globalShortcut.register(desired, () => { this.showPanel() })) this.shortcut = desired
        else this.shortcutError = true
      } catch (_error: unknown) { this.shortcutError = true }
    }
  }

  private menu(): Electron.MenuItemConstructorOptions[] {
    const c = this.copy
    return [
      { label: c.panel, click: () => { this.showPanel() } },
      { label: c.avatarTitle, click: () => { this.showPanel('avatar') } },
      { label: this.store.data.preferences.visible ? c.hide : c.show, click: () => {
        this.store.data.preferences.visible = !this.store.data.preferences.visible
        void this.store.save().then(() => { this.applyPreferences() }).catch(() => { this.publish() })
      } },
      { label: c.pat, click: () => { this.react('pat', c.patLine) } },
      { label: c.settings, click: () => { this.showPanel('settings') } },
      { label: c.resetPosition, click: () => { this.store.data.position = null; this.restorePosition(); void this.store.save().catch(() => { this.publish() }) } },
      { type: 'separator' },
      { label: c.openApp, click: () => { void this.options.openWorkbench().catch(() => { this.adapter.error = c.requestFailed; this.showPanel() }) } },
      { label: c.quit, click: () => { app.quit() } },
    ]
  }
  private refreshMenu(): void { this.tray?.setContextMenu(Menu.buildFromTemplate(this.menu())) }

  private avatarMotionBlocked(): boolean {
    return this.avatarUnavailable() || !['idle', 'completed', 'cancelled', 'failed'].includes(this.adapter.activity)
      || this.adapter.pendingInput !== null || this.adapter.queuedCount !== 0
  }

  private avatarUnavailable(): boolean {
    return this.avatarModelPhase !== 'ready' || this.suspended || this.pet?.isVisible() !== true || this.systemReducedMotion || this.store.data.preferences.reducedMotion
  }

  private agentRunKey(): string { return this.adapter.turnKey ?? this.adapter.runKey ?? this.adapter.lastPromptRequestId ?? '' }

  private clearAgentActions(reason: string, returnHands = false): void {
    const returning = this.agentReturnMotion
    if ((this.agentPose !== null || this.avatarQueue.some(item => item.agent)) && (!returnHands || returning === undefined)) this.avatarResetSequence++
    clearTimeout(this.agentPoseTimer)
    this.agentPoseTimer = undefined
    this.agentPose = null
    this.agentReturnMotion = undefined
    if (this.avatarQueue[0]?.agent) { clearTimeout(this.playbackTimer); this.playbackTimer = undefined }
    this.avatarQueue = this.avatarQueue.filter(item => !item.agent)
    for (const finish of [...this.agentPending.values()]) finish({ ok: false, status: 'interrupted', reason })
    if (returnHands && returning !== undefined && !this.avatarUnavailable()) {
      this.avatarQueue.push({ sequence: ++this.avatarSequence, motion: returning, automatic: false, started: false, agent: true })
    }
  }

  private async performAgentAction(request: AgentAvatarRequest, signal: AbortSignal, source: 'tool' | 'text' | 'notification' = 'tool'): Promise<object> {
    const bound = source === 'notification' || request.sessionId === this.store.data.binding?.sessionId
    const available = !this.avatarUnavailable() && this.store.data.preferences.avatar.agentActions
      && this.adapter.connectionState === 'online' && (source === 'notification' || this.adapter.available) && bound
    if (request.operation === 'catalog') return {
      ok: true, status: 'catalog', bound, available, quietHours: isQuietTime(this.store.data.preferences),
      motions: Object.entries(AVATAR_MOTIONS).map(([id, motion]) => ({ id, label: this.copy.avatarMotions[id as AvatarMotion], seconds: motion.seconds, fullBody: motion.full })),
      expressions: Object.entries(AVATAR_EXPRESSIONS).map(([id, expression]) => ({ id, label: this.copy.avatarExpressions[id as AvatarExpression], category: expression.category, exclusive: expression.exclusive ?? null })),
    }
    if (!bound) return { ok: false, status: 'refused', reason: 'This Session is not bound to the native companion.' }
    if (request.operation === 'stop' || request.operation === 'reset') {
      this.clearAgentActions('agent-stop', true); this.publish(); return { ok: true, status: 'cleared' }
    }
    if (request.motion === 'ambient' && source !== 'notification') { this.clearAgentActions('ambient', true); this.publish(); return { ok: true, status: 'cleared' } }
    if (!available || signal.aborted) return { ok: false, status: 'unavailable', reason: 'Character is hidden, disconnected, not ready, or motion controls are disabled.' }
    if (this.agentMutedRun === this.agentRunKey()) return { ok: false, status: 'refused', reason: 'The user stopped agent actions for this turn.' }
    if (request.motion !== undefined && (this.avatarManualHands || this.avatarQueue.some(item => !item.agent && !item.automatic))) return { ok: false, status: 'refused', reason: 'The user is controlling the character motion.' }
    if (source === 'text' && !this.store.data.preferences.avatar.textReactions) return { ok: false, status: 'disabled' }
    const expressions = [...new Set(request.expressions ?? [])]
    if (request.motion === undefined && expressions.length === 0) return { ok: false, status: 'invalid', reason: 'Choose at least one motion or expression.' }
    const groups = expressions.flatMap(id => AVATAR_EXPRESSIONS[id].exclusive ?? [])
    if (new Set(groups).size !== groups.length) return { ok: false, status: 'invalid', reason: 'Select only one expression from each exclusive group.' }
    this.clearAgentActions('replaced')
    this.avatarInteracted()
    const sequence = ++this.avatarSequence
    const body = expressions.map(id => AVATAR_EXPRESSIONS[id].body).find(value => value !== undefined)
    this.agentPose = { sequence, expressions: expressions.filter(id => AVATAR_EXPRESSIONS[id].body === undefined), source, ...(body === undefined ? {} : { body }) }
    if (request.motion !== undefined) {
      this.avatarQueue.push({ sequence, motion: request.motion, automatic: false, started: false, agent: true })
      this.agentReturnMotion = request.motion === 'chest-on' ? 'chest-off' : request.motion === 'point-on' ? 'point-off' : request.motion === 'grass-on' ? 'grass-off' : undefined
    }
    const duration = Math.max(request.seconds, request.motion === undefined ? 0 : AVATAR_MOTIONS[request.motion].seconds + .25)
    this.agentPoseTimer = setTimeout(() => { this.clearAgentActions('expired', true); this.publish() }, duration * 1000)
    return await new Promise<AgentAvatarReceipt>(resolve => {
      const finish = (receipt: AgentAvatarReceipt): void => {
        clearTimeout(timer); signal.removeEventListener('abort', aborted); this.agentPending.delete(sequence); resolve(receipt)
      }
      const aborted = (): void => { if (this.agentPose?.sequence === sequence) { this.clearAgentActions('cancelled', true); this.publish() } }
      const timer = setTimeout(() => { if (this.agentPose?.sequence === sequence) { this.clearAgentActions('renderer-timeout', true); this.publish() } }, 5000)
      this.agentPending.set(sequence, finish)
      signal.addEventListener('abort', aborted, { once: true })
      if (signal.aborted) aborted()
      else this.publish()
    })
  }

  private avatarInteracted(): void {
    this.avatarDance.idleSince = null
    this.avatarDance.nextCheckAt = null
    if (this.avatarQueue[0]?.automatic) this.finishAvatar(this.avatarQueue[0].sequence)
  }

  private finishAvatar(sequence: number): void {
    const playback = this.avatarQueue[0]
    if (playback?.sequence !== sequence) return
    clearTimeout(this.playbackTimer)
    this.playbackTimer = undefined
    this.avatarQueue.shift()
    if (playback.motion === 'dance') this.avatarDance.cooldownUntil = Date.now() + this.store.data.preferences.avatar.danceCooldownMinutes * 60_000
  }

  private async applyAvatarAction(action: AvatarAction): Promise<void> {
    this.clearAgentActions('manual-control')
    this.notificationSpeech = null
    this.avatarInteracted()
    const preferences = this.store.data.preferences.avatar
    if (action.kind === 'reload') {
      this.avatarQueue = []
      clearTimeout(this.playbackTimer)
      this.avatarModelPhase = 'loading'
      this.pet?.webContents.reload()
      this.publish()
      return
    }
    let save = false
    if (action.kind === 'reset' || action.kind === 'stop' || action.kind === 'motion' && action.id === 'ambient') {
      clearTimeout(this.playbackTimer)
      if (this.avatarQueue[0]?.motion === 'dance') this.avatarDance.cooldownUntil = Date.now() + preferences.danceCooldownMinutes * 60_000
      this.avatarQueue = []
      this.avatarResetSequence++
      this.avatarManualHands = action.kind === 'stop'
      if (action.kind === 'reset') { preferences.body = 0; preferences.expressions = []; save = true }
      else if (action.kind === 'motion') {
        preferences.expressions = preferences.expressions.filter(id => AVATAR_EXPRESSIONS[id].exclusive !== 'point')
        save = true
      }
    } else if (action.kind === 'expression') {
      const preset = AVATAR_EXPRESSIONS[action.id]
      if ((action.id === 'point-on' || action.id === 'point-off') && !this.avatarMotionBlocked() && this.avatarQueue.length >= 8) throw new Error(this.copy.avatarQueueFull)
      if (preset.body !== undefined) preferences.body = preset.body
      else {
        const active = preferences.expressions.includes(action.id)
        preferences.expressions = preferences.expressions.filter(id => id !== action.id && (preset.exclusive === undefined || AVATAR_EXPRESSIONS[id].exclusive !== preset.exclusive))
        if (!active || action.id === 'point-off') preferences.expressions.push(action.id)
        if ((action.id === 'point-on' || action.id === 'point-off') && !this.avatarMotionBlocked()) {
          this.avatarQueue.push({ sequence: ++this.avatarSequence, motion: action.id === 'point-on' && !active ? 'point-on' : 'point-off', automatic: false, started: false })
          this.avatarManualHands = true
        }
      }
      save = true
    } else {
      if (this.avatarMotionBlocked()) throw new Error(this.copy.avatarMotionUnavailable)
      if (this.avatarQueue.length >= 8) throw new Error(this.copy.avatarQueueFull)
      this.avatarQueue.push({ sequence: ++this.avatarSequence, motion: action.id, automatic: false, started: false })
      if (!AVATAR_MOTIONS[action.id].full) {
        this.avatarManualHands = true
        preferences.expressions = preferences.expressions.filter(id => AVATAR_EXPRESSIONS[id].exclusive !== 'point')
        save = true
      }
    }
    this.publish()
    if (save) await this.store.save()
  }

  private reconcileDance(): void {
    clearTimeout(this.danceTimer)
    this.danceTimer = undefined
    const blocked = this.avatarMotionBlocked()
    const quiet = isQuietTime(this.store.data.preferences)
    if ((this.avatarUnavailable() || blocked && this.avatarQueue[0]?.agent !== true) && this.avatarQueue.length > 0) {
      if (this.avatarQueue[0]?.motion === 'dance') this.avatarDance.cooldownUntil = Date.now() + this.store.data.preferences.avatar.danceCooldownMinutes * 60_000
      this.avatarQueue = []
      clearTimeout(this.playbackTimer)
    } else if (this.avatarQueue[0]?.automatic && (quiet || this.avatarHovered || this.panel?.isVisible() === true || !this.store.data.preferences.avatar.autoDance)) {
      this.finishAvatar(this.avatarQueue[0].sequence)
    }
    const eligible = !blocked && !quiet && !this.avatarHovered && this.panel?.isVisible() !== true
      && this.avatarQueue.length === 0 && this.agentPose === null && this.notificationSnapshot() === null
    const next = advanceAvatarDance(this.avatarDance, this.store.data.preferences.avatar, Date.now(), eligible, Math.random())
    this.avatarDance = next
    if (next.trigger) this.avatarQueue.push({ sequence: ++this.avatarSequence, motion: 'dance', automatic: true, started: false })
    else if (next.nextCheckAt !== null) this.danceTimer = setTimeout(() => { if (!this.disposed) this.publish() }, Math.max(0, next.nextCheckAt - Date.now()))
  }

  private refreshAvatarHotkeys(): void {
    const enabled = this.store.data.preferences.avatar.authorHotkeys && !this.shortcutRecording
    if (enabled === this.authorHotkeysEnabled) return
    for (const key of this.authorHotkeys.splice(0)) globalShortcut.unregister(key)
    this.authorHotkeysEnabled = enabled
    this.avatarShortcutErrors = []
    if (!enabled) return
    for (const binding of AVATAR_HOTKEYS) {
      try {
        if (globalShortcut.register(binding.accelerator, () => {
          void this.applyAvatarAction(binding.action).catch((_error: unknown) => { this.adapter.error = this.copy.requestFailed; this.publish() })
        })) this.authorHotkeys.push(binding.accelerator)
        else this.avatarShortcutErrors.push(binding.accelerator)
      } catch (_error: unknown) { this.avatarShortcutErrors.push(binding.accelerator) }
    }
  }

  private restorePosition(): void {
    const pet = this.pet
    if (pet === undefined || pet.isDestroyed()) return
    const position = this.store.data.position
    const display = screen.getAllDisplays().find(d => d.id === position?.displayId) ?? screen.getPrimaryDisplay()
    const area = display.workArea
    const bounds = pet.getBounds()
    pet.setPosition(Math.round(area.x + (position?.x ?? .96) * Math.max(0, area.width - bounds.width)), Math.round(area.y + (position?.y ?? .96) * Math.max(0, area.height - bounds.height)))
  }

  private positionPanel(): void {
    if (this.panel === undefined || this.pet === undefined) return
    const pet = this.pet.getBounds()
    const area = screen.getDisplayMatching(pet).workArea
    const height = Math.min(this.panelHeight, area.height - 16)
    const width = Math.min(this.panelView === 'chat' ? 480 : 430, area.width - 16)
    let x = pet.x + (pet.width - width) / 2
    let y = pet.y - height + 24
    if (this.panelView === 'utility' || y < area.y + 8 && pet.y + pet.height - 16 + height > area.y + area.height - 8) {
      x = pet.x - width - 10 >= area.x ? pet.x - width - 10 : pet.x + pet.width + 10
      y = pet.y + pet.height - height
    } else if (y < area.y + 8) y = pet.y + pet.height - 16
    this.panel.setBounds({ width, height, x: Math.round(Math.max(area.x + 8, Math.min(x, area.x + area.width - width - 8))), y: Math.round(Math.max(area.y + 8, Math.min(y, area.y + area.height - height - 8))) })
  }

  private movePet(phase: 'start' | 'move' | 'end', cursor: Electron.Point): void {
    const pet = this.pet
    if (pet === undefined) return
    // Capture the original event's screen DIP before IPC. Sampling the current
    // OS cursor after an asynchronous round trip loses fast drag gestures.
    if (phase === 'start') {
      const bounds = pet.getBounds()
      if (cursor.x < bounds.x || cursor.x > bounds.x + bounds.width || cursor.y < bounds.y || cursor.y > bounds.y + bounds.height) return
      this.drag = { cursor, bounds, moved: false }
      return
    }
    const drag = this.drag
    if (drag === undefined) return
    const dx = cursor.x - drag.cursor.x
    const dy = cursor.y - drag.cursor.y
    if (Math.hypot(dx, dy) > 5) drag.moved = true
    if (drag.moved) {
      const area = screen.getDisplayNearestPoint(cursor).workArea
      const x = Math.max(area.x, Math.min(drag.bounds.x + dx, area.x + area.width - drag.bounds.width))
      const y = Math.max(area.y, Math.min(drag.bounds.y + dy, area.y + area.height - drag.bounds.height))
      pet.setPosition(Math.round(x), Math.round(y))
      this.positionPanel()
      this.positionNotification()
    }
    if (phase === 'end') {
      this.drag = undefined
      const bounds = pet.getBounds()
      const display = screen.getDisplayMatching(bounds)
      this.store.data.position = { displayId: display.id, x: Math.max(0, Math.min(1, (bounds.x - display.workArea.x) / Math.max(1, display.workArea.width - bounds.width))), y: Math.max(0, Math.min(1, (bounds.y - display.workArea.y) / Math.max(1, display.workArea.height - bounds.height))) }
      void this.store.save().catch(() => { this.publish() })
      if (!drag.moved) { this.showPanel(); this.react('pat', '') }
    }
  }

  private react(kind: NonNullable<CompanionSnapshot['reaction']>['kind'], text: string): void {
    if (kind === 'pat') this.avatarInteracted()
    clearTimeout(this.reactionTimer)
    this.reaction = { id: randomUUID(), kind, text }
    this.publish()
    this.reactionTimer = setTimeout(() => { this.reaction = null; this.publish() }, 3000)
  }
  private greet(): void {
    if (this.suspended || this.pet?.isVisible() !== true || !this.adapter.available || this.adapter.connectionState !== 'online' || this.adapter.runKey !== null || !['idle', 'completed', 'cancelled', 'failed'].includes(this.adapter.activity) || this.adapter.pendingInput !== null || isQuietTime(this.store.data.preferences)) return
    const now = Date.now()
    const day = new Date().toLocaleDateString('en-CA')
    const greetings = this.store.data.greetings
    if (greetings.day !== day) { greetings.day = day; greetings.count = 0 }
    if (greetings.count >= 3 || now - greetings.last < 3_600_000) return
    greetings.count++
    greetings.last = now
    void this.store.save().then(() => { this.react('greet', this.copy.greeting) }).catch(() => { this.publish() })
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.clearAgentActions('disposed')
    for (const finish of [...this.notificationPending.values()]) finish({ ok: true, status: 'queued', reason: 'The app closed before display was confirmed.' })
    await this.agentBridge.dispose()
    clearTimeout(this.reactionTimer)
    clearInterval(this.greetingTimer)
    clearTimeout(this.danceTimer)
    clearTimeout(this.playbackTimer)
    for (const key of this.authorHotkeys.splice(0)) globalShortcut.unregister(key)
    if (this.shortcut !== undefined) globalShortcut.unregister(this.shortcut)
    ipcMain.removeHandler(COMPANION_IPC.command)
    ipcMain.removeHandler(COMPANION_IPC.catalog)
    ipcMain.off(COMPANION_IPC.subscribe, this.subscribe)
    ipcMain.off(COMPANION_IPC.unsubscribe, this.unsubscribe)
    screen.off('display-added', this.displayChanged)
    screen.off('display-removed', this.displayChanged)
    screen.off('display-metrics-changed', this.displayChanged)
    powerMonitor.off('suspend', this.suspend)
    powerMonitor.off('lock-screen', this.suspend)
    powerMonitor.off('resume', this.resume)
    powerMonitor.off('unlock-screen', this.resume)
    this.tray?.destroy()
    this.pet?.destroy()
    this.panel?.destroy()
    this.notice?.destroy()
    await Promise.all([this.adapter.disconnect(), this.store.flush()])
  }
}
