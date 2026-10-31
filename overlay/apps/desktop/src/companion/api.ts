/** Data shared by the isolated companion windows; Host credentials never cross this API. */
import type { AvatarAction, AvatarPreferences, AvatarSnapshot } from './avatar.ts'
import type { NotificationSnapshot } from './notification.ts'
export type Activity = 'idle' | 'queued' | 'thinking' | 'tool-running' | 'awaiting-user' | 'completed' | 'cancelled' | 'failed'

export interface CompanionBinding {
  sessionId: string
  workspaceId: string | null
  workspaceLabel: string
  sessionLabel: string
  cwd: string
}

export interface CompanionPreferences {
  avatar: AvatarPreferences
  visible: boolean
  size: number
  alwaysOnTop: boolean
  mode: 'companion' | 'quiet'
  reducedMotion: boolean
  quietHours: boolean
  quietStart: string
  quietEnd: string
  notifications: boolean
  speechCharactersPerSecond: number
  shortcutEnabled: boolean
  shortcut: string
}

export interface CompanionSubmission {
  requestId: string
  sessionId: string
  text: string
  phase: 'sending' | 'accepted' | 'uncertain' | 'rejected'
}

export interface CompanionSnapshot {
  schemaVersion: 1
  bridgeEpoch: string
  revision: number
  bindingVersion: number
  locale: 'zh' | 'en'
  binding: CompanionBinding | null
  connection: 'starting' | 'online' | 'reconnecting' | 'offline'
  activity: Activity
  runKey: string | null
  replyPreview: string
  previewTruncated: boolean
  lastPrompt: string
  lastPromptRequestId: string | null
  toolName: string | null
  queuedCount: number
  pendingInput: 'approval' | 'question' | 'other' | null
  canSend: boolean
  canCancel: boolean
  draft: string
  submission: CompanionSubmission | null
  preferences: CompanionPreferences
  error: string | null
  shortcutError: boolean
  storeError: boolean
  reaction: { id: string; kind: 'pat' | 'greet' | 'completed' | 'failed'; text: string } | null
  motionPaused: boolean
  panelVisible: boolean
  avatar: AvatarSnapshot
  notification: NotificationSnapshot | null
}

export interface CompanionCatalog {
  sessions: CompanionBinding[]
  workspaces: { id: string; label: string; path: string }[]
}

export type CompanionCommand =
  | { type: 'show-panel' | 'show-reply' | 'show-avatar' | 'hide-panel' | 'settings' | 'menu' | 'pat' | 'reset-position' | 'reset-store' | 'reconnect' }
  | { type: 'avatar'; action: AvatarAction }
  | { type: 'avatar-started' | 'avatar-finished' | 'avatar-applied'; sequence: number }
  | { type: 'avatar-motion'; reduced: boolean }
  | { type: 'avatar-body'; body: number }
  | { type: 'avatar-face'; y: number }
  | { type: 'avatar-model'; phase: 'loading' | 'ready' | 'failed' }
  | { type: 'notification-shown' | 'notification-dismiss' | 'notification-open'; id: string }
  | { type: 'notification-layout'; id: string; height: number }
  | { type: 'panel-layout'; view: 'chat' | 'utility'; height: number }
  | { type: 'bind'; sessionId: string }
  | { type: 'create'; workspaceId: string }
  | { type: 'draft'; sessionId: string; text: string; bindingVersion: number }
  | { type: 'send'; sessionId: string; bindingVersion: number; requestId: string; text: string }
  | { type: 'cancel'; sessionId: string; runKey: string }
  | { type: 'open-workbench'; sessionId?: string }
  | { type: 'preferences'; value: Partial<CompanionPreferences> }
  | { type: 'drag'; phase: 'start' | 'move' | 'end'; point: { x: number; y: number } }
  | { type: 'interactive'; value: boolean }

export type CompanionResult<T = void> = { ok: true; value: T } | { ok: false; error: string }

export interface CompanionApi {
  subscribe(listener: (snapshot: CompanionSnapshot) => void): () => void
  command(command: CompanionCommand): Promise<CompanionResult>
  catalog(): Promise<CompanionResult<CompanionCatalog>>
  onReveal(listener: (view: 'chat' | 'reply' | 'settings' | 'avatar') => void): () => void
}

export const COMPANION_IPC = {
  command: 'dsh-companion:command', catalog: 'dsh-companion:catalog',
  subscribe: 'dsh-companion:subscribe', unsubscribe: 'dsh-companion:unsubscribe',
  snapshot: 'dsh-companion:snapshot', reveal: 'dsh-companion:reveal',
  navigation: 'dsh-companion:navigation', navigationReady: 'dsh-companion:navigation-ready',
} as const
