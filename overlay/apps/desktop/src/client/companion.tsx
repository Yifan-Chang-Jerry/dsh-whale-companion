/** Lightweight companion UI; all agent state and commands are owned by the main process. */
import React, { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { CompanionApi, CompanionCatalog, CompanionCommand, CompanionPreferences, CompanionSnapshot } from '../companion/api.ts'
import { companionCopy } from '../companion/copy.ts'
import { notificationSpeechFrame } from '../companion/notification.ts'
import { useLive2dCharacter } from './companion-live2d.ts'
import { AVATAR_EXPRESSIONS, AVATAR_HOTKEYS, avatarExpressionSchema, avatarMotionSchema, type AvatarPreferences } from '../companion/avatar.ts'
import '@deepseek-ai/dsh-client-ui-theme/src/styles/base.css'
import '@deepseek-ai/dsh-client-ui-theme/src/styles/design-platform.css'
import '@deepseek-ai/dsh-client-ui-theme/src/styles/gradient-shadow-text.css'
import '@deepseek-ai/dsh-client-ui-theme/src/styles/shiki.css'
import './companion.css'

declare global {
  interface Window {
    dshCompanion: CompanionApi
  }
}

type ReplyMarkdownProps = React.ComponentProps<typeof import('@deepseek-ai/dsh-client-ui-primitives')['MarkdownText']> & { loadError: string }

function MarkdownUnavailable({ text, loadError }: ReplyMarkdownProps): React.JSX.Element {
  return <><p className="hint warning" role="alert">{loadError}</p><div className="markdown-fallback">{text}</div></>
}

// The character and collapsed composer do not load Markdown or code grammars.
const ReplyMarkdown = lazy<React.ComponentType<ReplyMarkdownProps>>(() => import('@deepseek-ai/dsh-client-ui-primitives')
  .then(({ MarkdownText }) => ({ default: MarkdownText }))
  .catch((error: unknown) => {
    console.error('Companion Markdown could not load:', error)
    return { default: MarkdownUnavailable }
  }))

function App(): React.JSX.Element | null {
  const [snapshot, setSnapshot] = useState<CompanionSnapshot>()
  useEffect(() => window.dshCompanion.subscribe(setSnapshot), [])
  if (snapshot === undefined) return null
  const view = new URLSearchParams(location.search).get('view')
  return view === 'pet' ? <Pet snapshot={snapshot} /> : view === 'notice' ? <NotificationBubble snapshot={snapshot} /> : <Panel snapshot={snapshot} />
}

function NotificationBubble({ snapshot: s }: { snapshot: CompanionSnapshot }): React.JSX.Element | null {
  const message = s.notification
  const card = useRef<HTMLDivElement>(null)
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const c = companionCopy(s.locale)
  const speech = message?.speech
  useEffect(() => {
    setError(null)
    if (message === null) return
    if (speech === undefined || speech === null) { setText(message.text); return }
    let timer: ReturnType<typeof setTimeout> | undefined
    const tick = (): void => {
      const frame = notificationSpeechFrame(speech, Date.now())
      setText(frame.text)
      if (!frame.finished) timer = setTimeout(tick, 1000 / speech.charactersPerSecond)
    }
    tick()
    return () => { clearTimeout(timer) }
  }, [message?.id, message?.text, speech?.id, speech?.startedAt, speech?.charactersPerSecond])
  useEffect(() => {
    if (message === null || card.current === null) return
    const element = card.current
    const layout = (): void => {
      void window.dshCompanion.command({ type: 'notification-layout', id: message.id,
        height: Math.max(80, Math.min(500, Math.ceil(element.scrollHeight + 18))) })
    }
    const observer = new ResizeObserver(layout)
    observer.observe(element)
    layout()
    let frame = 0
    const acknowledge = (): void => {
      if (document.hidden) return
      frame = requestAnimationFrame(() => { void window.dshCompanion.command({ type: 'notification-shown', id: message.id }) })
    }
    acknowledge()
    document.addEventListener('visibilitychange', acknowledge)
    return () => { observer.disconnect(); cancelAnimationFrame(frame); document.removeEventListener('visibilitychange', acknowledge) }
  }, [message?.id])
  if (message === null) return null
  const act = async (type: 'notification-dismiss' | 'notification-open'): Promise<void> => {
    const result = await window.dshCompanion.command({ type, id: message.id })
    if (!result.ok) setError(result.error)
  }
  return <main className={`notice-screen ${message.side}`}>
    <div className="notice-card" ref={card}>
      {message.unread > 1 && <span className="notice-count" aria-label={`${c.notificationUnread} ${message.unread}`}>{message.unread}</span>}
      <button className="notice-close" aria-label={c.notificationDismiss} onClick={() => { void act('notification-dismiss') }}>×</button>
      <button className="notice-message" aria-label={`${c.notificationOpen}：${message.text}`} aria-describedby="notice-context"
        onClick={() => { void act('notification-open') }}>
        <span className="notice-reserve" aria-hidden="true">{message.text}</span>
        <span className="notice-reveal" aria-hidden="true">{text}</span>
      </button>
      <span className="notice-context" id="notice-context">{message.sessionLabel} · {c.notificationOpenHint}</span>
      {error !== null && <p className="hint warning" role="alert">{error}</p>}
    </div>
  </main>
}

function Pet({ snapshot: s }: { snapshot: CompanionSnapshot }): React.JSX.Element {
  const dragging = useRef(false)
  const interactive = useRef(false)
  const [terminalPose, setTerminalPose] = useState(false)
  const avatarPreferences = useMemo(() => {
    const temporary = s.avatar.agent
    if (temporary === null) return s.preferences.avatar
    const groups = new Set(temporary.expressions.flatMap(id => AVATAR_EXPRESSIONS[id].exclusive ?? []))
    return { ...s.preferences.avatar, body: temporary.body ?? s.preferences.avatar.body,
      expressions: [...s.preferences.avatar.expressions.filter(id => {
        const group = AVATAR_EXPRESSIONS[id].exclusive
        return !temporary.expressions.includes(id) && (group === undefined || !groups.has(group))
      }), ...temporary.expressions] }
  }, [s.preferences.avatar, s.avatar.agent])
  const body = avatarPreferences.body
  const c = companionCopy(s.locale)
  useEffect(() => {
    setTerminalPose(['completed', 'failed', 'cancelled'].includes(s.activity))
    const timer = setTimeout(() => { setTerminalPose(false) }, 3000)
    return () => { clearTimeout(timer) }
  }, [s.activity, s.runKey])
  const urgent = s.connection !== 'online' || s.pendingInput !== null
  const poseKey = !urgent && s.reaction?.kind === 'pat' ? 'workPat'
    : s.connection !== 'online' ? 'afk' : s.pendingInput !== null ? 'waiting'
      : s.activity === 'thinking' ? 'thinking' : s.activity === 'tool-running' ? 'tool'
        : s.activity === 'queued' ? 'waiting' : terminalPose && s.activity === 'completed' ? 'success'
          : terminalPose && s.activity === 'failed' ? 'failure' : 'idle'
  const live2d = useLive2dCharacter(poseKey, s.preferences.reducedMotion || s.motionPaused,
    avatarPreferences, s.avatar, s.panelVisible, s.notification?.speech ?? null)
  const live2dReady = live2d.phase === 'ready'
  useEffect(() => { void window.dshCompanion.command({ type: 'avatar-model', phase: live2d.phase }) }, [live2d.phase])
  useEffect(() => {
    const media = matchMedia('(prefers-reduced-motion: reduce)')
    const update = (): void => { void window.dshCompanion.command({ type: 'avatar-motion', reduced: media.matches }) }
    update(); media.addEventListener('change', update)
    return () => { media.removeEventListener('change', update) }
  }, [])
  useEffect(() => {
    const move = (event: MouseEvent): void => {
      if (dragging.current) return
      let hit = event.target instanceof Element && event.target.closest('[data-pet-control]') !== null
      if (!hit && live2dReady) hit = live2d.hitTest(event.clientX, event.clientY)
      if (hit !== interactive.current) {
        interactive.current = hit
        void window.dshCompanion.command({ type: 'interactive', value: hit })
      }
    }
    document.addEventListener('mousemove', move)
    const leave = (): void => { if (interactive.current) { interactive.current = false; void window.dshCompanion.command({ type: 'interactive', value: false }) } }
    document.addEventListener('mouseleave', leave)
    return () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseleave', leave); leave() }
  }, [live2dReady, live2d.hitTest])
  const status = s.notification !== null ? `${c.notificationNew} · ${s.notification.unread}`
    : s.connection !== 'online' ? c[s.connection] : c[s.activity]
  return <main className={`pet ${s.preferences.reducedMotion || s.motionPaused ? 'still' : ''}`}>
    {s.reaction?.text && s.notification === null && !urgent && !s.panelVisible && <div className="pet-bubble" aria-live="polite">{s.reaction.text}</div>}
    <button className={`pet-status ${s.pendingInput !== null || s.notification !== null ? 'needs-you' : ''}`} data-pet-control
      aria-label={s.notification !== null ? c.notificationOpen : s.replyPreview || urgent ? c.viewReply : c.panel}
      onClick={() => { void window.dshCompanion.command(s.notification === null
        ? { type: 'show-reply' } : { type: 'notification-open', id: s.notification.id }) }}>
      <span className={`status-dot ${s.connection === 'online' ? s.activity : 'offline'}`} />{status}
    </button>
    {live2d.phase === 'failed' && <div className="pet-model-error" data-pet-control role="alert">
      {c.modelFailed}<button onClick={live2d.retry}>{c.retryModel}</button>
    </div>}
    <div className="character"
      onPointerDown={event => {
        if (event.button !== 0 || !live2dReady) return
        event.currentTarget.setPointerCapture(event.pointerId)
        dragging.current = true
        void window.dshCompanion.command({ type: 'drag', phase: 'start', point: { x: event.screenX, y: event.screenY } })
      }}
      onPointerMove={event => { if (dragging.current) void window.dshCompanion.command({ type: 'drag', phase: 'move', point: { x: event.screenX, y: event.screenY } }) }}
      onPointerUp={event => {
        if (!dragging.current) return
        dragging.current = false
        event.currentTarget.releasePointerCapture(event.pointerId)
        void window.dshCompanion.command({ type: 'drag', phase: 'end', point: { x: event.screenX, y: event.screenY } })
      }}
      onPointerCancel={event => { dragging.current = false; void window.dshCompanion.command({ type: 'drag', phase: 'end', point: { x: event.screenX, y: event.screenY } }) }}
      onContextMenu={event => { event.preventDefault(); void window.dshCompanion.command({ type: 'menu' }) }}>
      {live2d.phase === 'loading' && <div className="pet-model-loading" role="status" aria-label={c.modelLoading}><span /></div>}
      <canvas ref={live2d.canvas} className={`live2d-canvas ${live2dReady ? 'ready' : ''}`} role="img" aria-label={c.title} />
    </div>
    {live2dReady && <>
      <button className="pet-action" data-pet-control title={s.avatar.manualHands ? c.avatarResumeHint : undefined}
        disabled={poseKey !== 'idle' || s.preferences.reducedMotion || s.motionPaused || s.avatar.manualHands || s.avatar.playback !== null || s.panelVisible}
        onClick={live2d.perform}>{c.performAction}</button>
      <button className="pet-controls" data-pet-control onClick={() => { void window.dshCompanion.command({ type: 'show-avatar' }) }}>{c.avatarTitle}</button>
      <button className="pet-body" data-pet-control title={c.bodyVariant} onClick={() => { void window.dshCompanion.command({ type: 'avatar-body', body: (body + 1) % 3 }) }}>{[c.bodyNormal, c.bodySmall, c.bodyChibi][body]}</button>
    </>}
  </main>
}

function ShortcutField({ snapshot: s }: { snapshot: CompanionSnapshot }): React.JSX.Element {
  const c = companionCopy(s.locale)
  const [phase, setPhase] = useState<'idle' | 'arming' | 'recording' | 'saving'>('idle')
  const [error, setError] = useState<string | null>(null)
  const capture = useRef<{ abort: AbortController; saving: boolean }>()
  const mac = window.dshCompanion.platform === 'darwin'
  const labels: Record<string, string> = { CommandOrControl: mac ? '⌘' : 'Ctrl', Command: '⌘', Cmd: '⌘',
    Super: mac ? '⌘' : 'Win', Meta: mac ? '⌘' : 'Win', Control: mac ? '⌃' : 'Ctrl', Ctrl: mac ? '⌃' : 'Ctrl',
    Alt: mac ? '⌥' : 'Alt', Option: '⌥', Shift: mac ? '⇧' : 'Shift', Space: c.shortcutSpace }
  const label = s.preferences.shortcut.split('+').map(key => labels[key] ?? key).join(' + ')
  const cancel = useCallback(async (): Promise<void> => {
    const current = capture.current
    if (current === undefined) return
    current.abort.abort()
    capture.current = undefined
    setPhase('idle')
    try {
      const result = await window.dshCompanion.command({ type: 'shortcut-recording', active: false })
      if (!result.ok) setError(result.error)
    } catch (_error: unknown) { setError(c.requestFailed) }
  }, [c.requestFailed])
  useEffect(() => { if (!s.panelVisible) void cancel() }, [s.panelVisible, cancel])
  useEffect(() => () => {
    if (capture.current === undefined) return
    capture.current.abort.abort()
    capture.current = undefined
    void window.dshCompanion.command({ type: 'shortcut-recording', active: false }).catch((_error: unknown) => {
      // The native owner also restores shortcuts on reveal, hide, and renderer teardown.
    })
  }, [])
  const begin = async (): Promise<void> => {
    if (phase !== 'idle') return
    const current = { abort: new AbortController(), saving: false }
    capture.current = current
    setPhase('arming')
    setError(null)
    try {
      const result = await window.dshCompanion.command({ type: 'shortcut-recording', active: true })
      if (current.abort.signal.aborted) return
      if (!result.ok) { setError(result.error); await cancel(); return }
      setPhase('recording')
    } catch (_error: unknown) {
      if (!current.abort.signal.aborted) { setError(c.requestFailed); await cancel() }
    }
  }
  const save = async (shortcut: string): Promise<void> => {
    const current = capture.current ?? { abort: new AbortController(), saving: false }
    capture.current = current
    current.saving = true
    setPhase('saving')
    setError(null)
    try {
      const result = await window.dshCompanion.command({ type: 'preferences', value: { shortcut, shortcutEnabled: true } })
      if (!current.abort.signal.aborted && !result.ok) setError(result.error)
    } catch (_error: unknown) { if (!current.abort.signal.aborted) setError(c.requestFailed) }
    finally {
      if (capture.current === current) {
        try {
          const result = await window.dshCompanion.command({ type: 'shortcut-recording', active: false })
          if (!result.ok && !current.abort.signal.aborted) setError(result.error)
        } catch (_error: unknown) { if (!current.abort.signal.aborted) setError(c.requestFailed) }
        if (capture.current === current) { capture.current = undefined; setPhase('idle') }
      }
    }
  }
  const record = (event: React.KeyboardEvent<HTMLButtonElement>): void => {
    if (phase === 'idle') return
    if (event.key === 'Tab') { void cancel(); return }
    event.preventDefault()
    event.stopPropagation()
    if (event.key === 'Escape') { void cancel(); return }
    if (phase !== 'recording' || event.repeat || event.nativeEvent.isComposing || event.keyCode === 229
      || /^(Control|Alt|Shift|Meta)(Left|Right)$/.test(event.code)) return
    const names: Record<string, string> = { Space: 'Space', Enter: 'Return', Backspace: 'Backspace', Delete: 'Delete',
      ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Home: 'Home', End: 'End',
      PageUp: 'PageUp', PageDown: 'PageDown', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']',
      Backslash: '\\', Semicolon: ';', Quote: "'", Backquote: '`', Comma: ',', Period: '.', Slash: '/' }
    const key = /^(Key[A-Z]|Digit[0-9])$/.test(event.code) ? event.code.replace(/^(Key|Digit)/, '')
      : /^F([1-9]|1[0-9]|2[0-4])$/.test(event.code) ? event.code : names[event.code]
    if (key === undefined || (!event.ctrlKey && !event.metaKey && !event.altKey) || event.getModifierState('AltGraph')) {
      setError(c.shortcutInvalid)
      return
    }
    const modifiers = [event.ctrlKey ? 'Control' : '', event.altKey ? 'Alt' : '', event.shiftKey ? 'Shift' : '', event.metaKey ? 'Super' : ''].filter(Boolean)
    void save([...modifiers, key].join('+'))
  }
  return <div className="shortcut-field">
    <span>{c.shortcut}</span>
    <button type="button" className={`shortcut-record ${phase === 'recording' ? 'recording' : ''}`} aria-label={c.shortcut}
      aria-describedby="shortcut-help" aria-busy={phase === 'arming' || phase === 'saving'}
      onClick={() => { void begin() }} onKeyDown={record}
      onBlur={() => { if (!capture.current?.saving) void cancel() }}>
      {phase === 'recording' ? c.shortcutRecording : phase === 'arming' ? c.shortcutArming : phase === 'saving' ? c.shortcutSaving : label}
    </button>
    <span id="shortcut-help" className="hint">{c.shortcutHelp}</span>
    <div className="shortcut-buttons">
      {phase !== 'idle' && phase !== 'saving' && <button type="button" className="text-button" onClick={() => { void cancel() }}>{c.shortcutCancel}</button>}
      <button type="button" className="text-button" disabled={phase !== 'idle'} onClick={() => { void save('CommandOrControl+Shift+Space') }}>{c.shortcutReset}</button>
    </div>
    {(error !== null || s.shortcutError) && <p role="alert" className="hint warning">{error ?? c.shortcutError}</p>}
  </div>
}

function Panel({ snapshot: s }: { snapshot: CompanionSnapshot }): React.JSX.Element {
  const [view, setView] = useState<'chat' | 'binding' | 'settings' | 'avatar'>(s.binding === null ? 'binding' : 'chat')
  const [draft, setDraft] = useState(s.draft)
  const [catalog, setCatalog] = useState<CompanionCatalog>()
  const [workspace, setWorkspace] = useState('')
  const [busy, setBusy] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [replyOpen, setReplyOpen] = useState(false)
  const [fullReply, setFullReply] = useState(false)
  const [replyRequestId, setReplyRequestId] = useState<string | null>(null)
  const [focusRequest, setFocusRequest] = useState(0)
  const content = useRef<HTMLDivElement>(null)
  const revealMotion = useRef<Animation>()
  const input = useRef<HTMLTextAreaElement>(null)
  const reply = useRef<HTMLDivElement>(null)
  const follow = useRef(true)
  const composing = useRef(false)
  const c = companionCopy(s.locale)
  const bindingId = s.binding?.sessionId ?? 'unbound'
  const markdownLabels = useMemo(() => ({ code: { copyLabel: c.copyCode, copiedLabel: c.copiedCode }, footnotes: c.footnotes }), [c])

  useEffect(() => {
    setDraft(s.draft); setError(null); setBusy(false); setStopping(false)
    setMenuOpen(false); setReplyOpen(false); setFullReply(false); setReplyRequestId(null)
  }, [bindingId, s.bindingVersion])
  useEffect(() => {
    if (s.submission?.phase === 'accepted') setDraft(previous => previous === s.submission?.text ? s.draft : previous)
  }, [s.submission?.phase, s.submission?.requestId])
  useEffect(() => {
    const reduced = matchMedia('(prefers-reduced-motion: reduce)')
    const stopMotion = (): void => { revealMotion.current?.cancel(); revealMotion.current = undefined }
    const unsubscribe = window.dshCompanion.onReveal(reveal => {
      setView(reveal === 'settings' ? 'settings' : reveal === 'avatar' ? 'avatar' : s.binding === null ? 'binding' : 'chat')
      setMenuOpen(false)
      setReplyOpen(reveal === 'reply')
      setFullReply(false)
      setReplyRequestId(null)
      setError(null)
      stopMotion()
      if (!s.preferences.reducedMotion && !reduced.matches && reveal !== 'settings' && reveal !== 'avatar') {
        revealMotion.current = content.current?.animate([
          { opacity: 0, transform: 'translateY(8px) scale(0.96)' },
          { opacity: 1, transform: 'translateY(0) scale(1)' },
        ], { duration: 240, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' })
      }
      if (reveal !== 'settings' && reveal !== 'avatar') setFocusRequest(value => value + 1)
    })
    const preferenceChanged = (): void => { if (reduced.matches) stopMotion() }
    reduced.addEventListener('change', preferenceChanged)
    return () => { unsubscribe(); reduced.removeEventListener('change', preferenceChanged); stopMotion() }
  }, [s.binding?.sessionId, s.preferences.reducedMotion])
  useLayoutEffect(() => { if (view === 'chat' && s.panelVisible) input.current?.focus() }, [view, s.panelVisible, focusRequest])
  useEffect(() => { if (!s.panelVisible) revealMotion.current?.cancel() }, [s.panelVisible])
  useEffect(() => {
    if (view !== 'chat') {
      void window.dshCompanion.command({ type: 'panel-layout', view: 'utility', height: 640 })
      return
    }
    const element = content.current
    if (element === null) return
    // CSS sizes the content; the native window follows the observed content size.
    const observer = new ResizeObserver(() => {
      void window.dshCompanion.command({ type: 'panel-layout', view: 'chat', height: Math.max(88, Math.min(900, element.offsetHeight)) })
    })
    observer.observe(element)
    return () => { observer.disconnect() }
  }, [view])
  useEffect(() => {
    const key = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !event.isComposing && !composing.current && event.keyCode !== 229) {
        event.preventDefault()
        if (menuOpen) setMenuOpen(false)
        else void window.dshCompanion.command({ type: 'hide-panel' })
      }
    }
    document.addEventListener('keydown', key)
    return () => { document.removeEventListener('keydown', key) }
  }, [menuOpen])
  useEffect(() => {
    if (!menuOpen) return
    const dismiss = (event: PointerEvent): void => {
      if (event.target instanceof Element && event.target.closest('[data-quick-menu]') === null) setMenuOpen(false)
    }
    document.addEventListener('pointerdown', dismiss)
    return () => { document.removeEventListener('pointerdown', dismiss) }
  }, [menuOpen])
  useEffect(() => { if (follow.current) reply.current?.scrollTo({ top: reply.current.scrollHeight }) }, [s.replyPreview, fullReply])
  useEffect(() => {
    if (view !== 'binding') return
    let current = true
    void window.dshCompanion.catalog().then(result => {
      if (!current) return
      if (result.ok) { setCatalog(result.value); setWorkspace(result.value.workspaces[0]?.id ?? '') }
      else setError(result.error)
    })
    return () => { current = false }
  }, [view, s.connection])

  const command = async (value: CompanionCommand): Promise<boolean> => {
    const result = await window.dshCompanion.command(value)
    if (!result.ok) { setError(result.error); return false }
    setError(null)
    return true
  }
  const send = async (): Promise<void> => {
    if (busy || !s.canSend || s.binding === null || draft.trim() === '') return
    const uncertain = s.submission?.phase === 'uncertain' && s.submission.text === draft ? s.submission : undefined
    const requestId = uncertain?.requestId ?? crypto.randomUUID()
    setReplyRequestId(requestId)
    setReplyOpen(true)
    setFullReply(false)
    setMenuOpen(false)
    follow.current = true
    setBusy(true)
    try { await command({ type: 'send', sessionId: s.binding.sessionId, bindingVersion: s.bindingVersion, requestId, text: draft }) }
    finally { setBusy(false) }
  }
  const createSession = async (workspaceId: string): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      if (await command({ type: 'create', workspaceId })) { setView('chat'); setMenuOpen(false); setReplyOpen(false); setReplyRequestId(null) }
    } finally { setBusy(false) }
  }
  const preference = (value: Partial<CompanionPreferences>): void => { void command({ type: 'preferences', value }) }
  const openSession = (): void => { void command({ type: 'open-workbench', ...(s.binding === null ? {} : { sessionId: s.binding.sessionId }) }) }
  const status = s.connection !== 'online' ? c[s.connection] : c[s.activity]
  const pending = s.pendingInput !== null
  const waitingForReply = replyRequestId !== null && s.lastPromptRequestId !== replyRequestId
  const longReply = s.previewTruncated || s.replyPreview.length > 200 || s.replyPreview.split('\n').length > 5
  const sendLabel = busy ? c.sending : s.submission?.phase === 'uncertain' && draft === s.submission.text ? c.retry : s.canCancel ? c.enqueue : c.send
  return <main className={`quick-panel ${view === 'chat' ? 'chat-panel' : 'utility-panel'} ${s.preferences.reducedMotion ? 'still' : ''}`}>
    <div ref={content} className={view === 'chat' ? 'chat-layout' : 'utility-layout'}>
    {view !== 'chat' && <header className="panel-header">
      <button className="icon-button" aria-label={c.back} onClick={() => { if (s.binding) setView('chat'); else void command({ type: 'hide-panel' }) }}>←</button>
      <h1>{view === 'avatar' ? c.avatarTitle : c.title}</h1>
      <div className="header-actions">
        <button className="icon-button" aria-label={c.collapse} title={c.collapse} onClick={() => { void command({ type: 'hide-panel' }) }}>−</button></div>
    </header>}
    {(error || s.error || s.storeError) && <div className="notice error" role="alert">{s.storeError ? c.storeError : error ?? s.error}
      {s.storeError && <button onClick={() => { void command({ type: 'reset-store' }) }}>{c.resetStore}</button>}
      {s.connection !== 'online' && <button onClick={() => { void command({ type: 'reconnect' }) }}>{c.refresh}</button>}
    </div>}
    {view === 'avatar' ? <AvatarControls snapshot={s} command={command} /> : view === 'settings' ? <section className="settings content-scroll">
      <div className="section-heading"><h2>{c.settings}</h2><span>{c.settingsSaved}</span></div>
      <h3>{c.appearance}</h3>
      <label className="range-label">{c.size}<span>{s.preferences.size}px</span><input type="range" min="120" max="280" step="10" value={s.preferences.size} onChange={e => { preference({ size: Number(e.target.value) }) }} /></label>
      <Toggle label={c.onTop} checked={s.preferences.alwaysOnTop} onChange={value => { preference({ alwaysOnTop: value }) }} />
      <p className="hint">{c.fullScreenHint}</p>
      <button className="text-button" onClick={() => { void command({ type: 'reset-position' }) }}>{c.resetPosition} ↗</button>
      <button className="text-button" onClick={() => { setView('avatar') }}>{c.avatarTitle} ↗</button>
      <h3>{c.company}</h3>
      <label className="setting-row">{c.mode}<select value={s.preferences.mode} onChange={e => { preference({ mode: e.target.value as CompanionPreferences['mode'] }) }}><option value="companion">{c.companion}</option><option value="quiet">{c.quiet}</option></select></label>
      <Toggle label={c.reducedMotion} checked={s.preferences.reducedMotion} onChange={value => { preference({ reducedMotion: value }) }} />
      <Toggle label={c.notificationEnable} checked={s.preferences.notifications} onChange={value => { preference({ notifications: value }) }} />
      <label className="range-label">{c.notificationSpeed}<span>{s.preferences.speechCharactersPerSecond}</span>
        <input aria-label={c.notificationSpeed} type="range" min="8" max="40" step="1" value={s.preferences.speechCharactersPerSecond}
          onChange={event => { preference({ speechCharactersPerSecond: Number(event.target.value) }) }} />
      </label>
      <Toggle label={c.quietHours} checked={s.preferences.quietHours} onChange={value => { preference({ quietHours: value }) }} />
      <div className="time-row"><label>{c.quietStart}<input type="time" value={s.preferences.quietStart} onChange={e => { if (e.target.value) preference({ quietStart: e.target.value }) }} /></label><span>—</span><label>{c.quietEnd}<input type="time" value={s.preferences.quietEnd} onChange={e => { if (e.target.value) preference({ quietEnd: e.target.value }) }} /></label></div>
      <p className="hint">{c.quietHint}</p>
      <h3>{c.keyboard}</h3>
      <Toggle label={c.enableShortcut} checked={s.preferences.shortcutEnabled} onChange={value => { preference({ shortcutEnabled: value }) }} />
      <ShortcutField snapshot={s} />
      <button className="text-button" onClick={() => { setView('binding') }}>{c.rebind} ↗</button>
      <p className="attribution">{c.live2dLicense}</p>
    </section> : view === 'binding' ? <section className="binding content-scroll">
      <div className="section-heading"><h2>{c.bind}</h2>{s.binding && <button className="text-button" onClick={() => { setView('chat') }}>{c.back}</button>}</div>
      <p className="hint">{c.bindingHelp}</p>
      <div className="session-list">{catalog?.sessions.map(session => <button key={session.sessionId} className={`session-option ${session.sessionId === s.binding?.sessionId ? 'selected' : ''}`} disabled={busy} onClick={() => {
        setBusy(true)
        void command({ type: 'bind', sessionId: session.sessionId }).then(ok => { if (ok) setView('chat') }).finally(() => { setBusy(false) })
      }}><span className="session-icon">↗</span><span><strong>{session.sessionLabel}</strong><small>{session.workspaceLabel}</small><code>{session.cwd}</code></span>{session.sessionId === s.binding?.sessionId && <span>✓</span>}</button>)}</div>
      {catalog?.sessions.length === 0 && <p className="empty-small">{c.noSessions}</p>}
      <div className="create-session"><label>{c.workspace}<select value={workspace} onChange={e => { setWorkspace(e.target.value) }}>{catalog?.workspaces.map(w => <option key={w.id} value={w.id}>{w.label} · {w.path}</option>)}</select></label>
        <button className="primary" disabled={!workspace || busy} onClick={() => { void createSession(workspace) }}>{c.create}</button>
        <button className="text-button" onClick={() => { void command({ type: 'open-workbench' }) }}>{c.openApp} ↗</button>
      </div>
    </section> : <>
      {(replyOpen || pending) && <section id="companion-latest-reply" className="reply-bubble" aria-label={c.reply}>
        <div className="reply-header"><div className="reply-status" role="status"><span className={`status-dot ${s.connection === 'online' ? s.activity : 'offline'}`} /><span>{busy ? c.sending : waitingForReply && !pending ? c.queued : status}</span>{s.toolName && <code>{s.toolName}</code>}{s.queuedCount > 0 && <small>{c.queued} · {s.queuedCount}</small>}</div>
          {s.canCancel && <button className="stop-button" disabled={stopping} onClick={() => { setStopping(true); void command({ type: 'cancel', sessionId: s.binding!.sessionId, runKey: s.runKey! }).finally(() => { setStopping(false) }) }}>{stopping ? c.stopping : c.stop}</button>}
          {!pending && <button className="bubble-close" aria-label={c.closeReply} title={c.closeReply} onClick={() => { setReplyOpen(false); setFullReply(false) }}>×</button>}
        </div>
        {pending && <button className="interaction-banner" onClick={openSession}><span>{s.pendingInput === 'approval' ? c.approval : c.question}</span><span>↗</span></button>}
        <div className={`reply-body ${fullReply ? 'reply-expanded content-scroll' : 'reply-preview'}`} ref={reply} onScroll={e => { const el = e.currentTarget; follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 50 }}>
          {!waitingForReply && s.replyPreview ? <Suspense fallback={<span className="reply-placeholder">{c.loadingReply}</span>}><ReplyMarkdown text={s.replyPreview} streaming={s.canCancel} labels={markdownLabels} variant="compact" loadError={c.markdownUnavailable} /></Suspense> : <span className="reply-placeholder">{s.submission?.phase === 'uncertain' || s.submission?.phase === 'rejected' ? c[s.submission.phase] : busy ? c.sending : waitingForReply ? c.preparing : s.canCancel ? status : c.noReply}</span>}
        </div>
        {s.previewTruncated && fullReply && <p className="hint">{c.truncated}</p>}
        <footer className="reply-actions">{!waitingForReply && longReply && <button onClick={() => { setFullReply(!fullReply) }}>{fullReply ? c.foldReply : c.expandReply}<span>{fullReply ? '⌃' : '⌄'}</span></button>}<button onClick={openSession}>{c.workbench}<span>↗</span></button></footer>
      </section>}
      {menuOpen && <section id="quick-actions" className="quick-menu" data-quick-menu aria-label={c.more}>
        <div className="menu-session"><small>{c.currentSession} · {s.binding?.workspaceLabel}</small><strong title={s.binding?.cwd}>{s.binding?.sessionLabel ?? c.noBinding}</strong></div>
        <div className="menu-actions">
          <button disabled={busy} onClick={() => { if (s.binding?.workspaceId) void createSession(s.binding.workspaceId); else { setMenuOpen(false); setView('binding') } }}><span>＋</span>{c.newChat}</button>
          <button onClick={() => { setMenuOpen(false); setView('binding') }}><span>⇄</span>{c.rebind}</button>
          {(s.replyPreview || s.lastPrompt || s.canCancel) && <button onClick={() => { setMenuOpen(false); setReplyOpen(true); setReplyRequestId(null) }}><span>☰</span>{c.viewReply}</button>}
          <button onClick={openSession}><span>↗</span>{c.workbench}</button>
          <button onClick={() => { setMenuOpen(false); setView('settings') }}><span>⚙</span>{c.settings}</button>
          <button onClick={() => { setMenuOpen(false); setView('avatar') }}>{c.avatarTitle}</button>
        </div>
      </section>}
      {s.submission && (s.submission.phase === 'uncertain' || s.submission.phase === 'rejected') && !s.error && <div className={`submission-state ${s.submission.phase}`} role="status">{c[s.submission.phase]}</div>}
      <div className="input-bar">
        <button className={`add-button ${menuOpen ? 'active' : ''}`} data-quick-menu aria-label={c.more} title={c.more} aria-expanded={menuOpen} aria-controls="quick-actions" onClick={() => { if (!menuOpen) setReplyOpen(false); setMenuOpen(!menuOpen) }}><span aria-hidden="true" /></button>
        <textarea ref={input} aria-label={c.placeholder} placeholder={s.lastPrompt ? c.continueChat : `${c.newChat}…`} title={s.binding?.sessionLabel} value={draft} rows={1} maxLength={32000} onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => { composing.current = false }}
          onChange={event => { const text = event.target.value; setDraft(text); void command({ type: 'draft', sessionId: bindingId, bindingVersion: s.bindingVersion, text }) }}
          onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && !composing.current && event.nativeEvent.keyCode !== 229) { event.preventDefault(); void send() } }} />
        {s.replyPreview && !pending && <button className={`reply-shortcut ${replyOpen ? 'active' : ''}`} aria-label={replyOpen ? c.closeReply : c.viewReply} title={replyOpen ? c.closeReply : c.viewReply} aria-expanded={replyOpen} aria-controls="companion-latest-reply" onClick={() => { setMenuOpen(false); setReplyOpen(!replyOpen); setFullReply(false); setReplyRequestId(null); follow.current = true }}><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 15H3.5a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1h13a1 1 0 0 1 1 1V14a1 1 0 0 1-1 1H9l-4 3v-3Z" /><path d="M6 7h8M6 10.5h5" /></svg><span>{c.reply}</span></button>}
        <button className="send-button" disabled={!s.canSend || busy || !draft.trim()} aria-label={sendLabel} title={`${sendLabel} · ${c.shortcutHint}`} onClick={() => { void send() }}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20V4m-7 7 7-7 7 7" /></svg></button>
      </div>
    </>}
    </div>
  </main>
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (value: boolean) => void }): React.JSX.Element {
  return <label className="setting-row toggle-row">{label}<input type="checkbox" role="switch" checked={checked} onChange={event => { onChange(event.target.checked) }} /><span className="toggle" aria-hidden="true" /></label>
}

function AvatarControls({ snapshot: s, command }: { snapshot: CompanionSnapshot; command: (value: CompanionCommand) => Promise<boolean> }): React.JSX.Element {
  const c = companionCopy(s.locale)
  const preferences = s.preferences.avatar
  const update = (value: Partial<AvatarPreferences>): void => { void command({ type: 'preferences', value: { avatar: { ...preferences, ...value } } }) }
  const groups = [
    { category: 'body', label: c.avatarBodiesTitle }, { category: 'face', label: c.avatarFacesTitle },
    { category: 'look', label: c.avatarLooksTitle }, { category: 'pose', label: c.avatarPosesTitle },
  ] as const
  return <section className="avatar-controls content-scroll">
    <div className="avatar-transport">
      <button onClick={() => { void command({ type: 'avatar', action: { kind: 'stop' } }) }}>{c.avatarStop}</button>
      <button onClick={() => { void command({ type: 'avatar', action: { kind: 'reset' } }) }}>{c.avatarReset}</button>
    </div>
    {s.avatar.modelPhase === 'failed' && <button className="text-button" onClick={() => { void command({ type: 'avatar', action: { kind: 'reload' } }) }}>{c.retryModel}</button>}
    {s.avatar.playback && <p className="hint" role="status">{c.avatarMotions[s.avatar.playback.motion]}{s.avatar.playback.automatic ? ` · ${c.avatarAutomatic}` : ''}{s.avatar.queued > 0 ? ` · ${c.avatarQueue} ${s.avatar.queued}` : ''}</p>}
    {s.avatar.motionBlocked && <p className="hint">{s.avatar.modelPhase === 'failed' ? c.modelFailed : c.avatarMotionUnavailable}</p>}
    <Toggle label={c.avatarAgentActions} checked={preferences.agentActions} onChange={agentActions => { update({ agentActions }) }} />
    <Toggle label={c.avatarTextReactions} checked={preferences.textReactions} onChange={textReactions => { update({ textReactions }) }} />
    {s.avatar.agent && <p className="hint" role="status">{c.avatarAgentActive}</p>}
    <h2>{c.avatarMotionsTitle}</h2>
    <div className="avatar-grid">{avatarMotionSchema.options.map(id => <button key={id} aria-pressed={s.avatar.playback?.motion === id}
      disabled={s.avatar.motionBlocked && id !== 'ambient'} onClick={() => { void command({ type: 'avatar', action: { kind: 'motion', id } }) }}>{c.avatarMotions[id]}</button>)}</div>
    {groups.map(group => <section key={group.category}>
      <h2>{group.label}</h2>
      <div className="avatar-grid">{avatarExpressionSchema.options.filter(id => AVATAR_EXPRESSIONS[id].category === group.category).map(id => {
        const body = AVATAR_EXPRESSIONS[id].body
        const active = body === undefined ? preferences.expressions.includes(id) : preferences.body === body
        return <button key={id} aria-pressed={active} onClick={() => { void command({ type: 'avatar', action: { kind: 'expression', id } }) }}>{c.avatarExpressions[id]}</button>
      })}</div>
    </section>)}
    <h2>{c.avatarDanceTitle}</h2>
    <Toggle label={c.avatarAutoDance} checked={preferences.autoDance} onChange={autoDance => { update({ autoDance }) }} />
    <p className="hint" role="status">{c.avatarDanceStates[s.avatar.danceState]}</p>
    <label className="setting-row">{c.avatarIdleMinutes}<input type="number" min="1" max="120" value={preferences.danceIdleMinutes} onChange={e => { const value = Number(e.target.value); if (Number.isInteger(value) && value >= 1 && value <= 120) update({ danceIdleMinutes: value }) }} /></label>
    <label className="range-label">{c.avatarChance}<span>{Math.round(preferences.danceChance * 100)}%</span><input type="range" min="0" max="100" step="5" value={preferences.danceChance * 100} onChange={e => { update({ danceChance: Number(e.target.value) / 100 }) }} /></label>
    <label className="setting-row">{c.avatarCooldown}<input type="number" min="1" max="120" value={preferences.danceCooldownMinutes} onChange={e => { const value = Number(e.target.value); if (Number.isInteger(value) && value >= 1 && value <= 120) update({ danceCooldownMinutes: value }) }} /></label>
    <p className="hint">{c.avatarDanceHint}</p>
    <h2>{c.avatarHotkeys}</h2>
    <Toggle label={c.avatarEnableHotkeys} checked={preferences.authorHotkeys} onChange={authorHotkeys => { update({ authorHotkeys }) }} />
    {s.avatar.shortcutErrors.length > 0 && <p className="hint warning" role="status">{c.avatarHotkeyUnavailable}: {s.avatar.shortcutErrors.join(', ')}</p>}
    <details><summary>{c.avatarHotkeys} · {AVATAR_HOTKEYS.length}</summary><dl>{AVATAR_HOTKEYS.map(binding => <div key={binding.accelerator}>
      <dt><kbd>{binding.accelerator}</kbd></dt><dd>{binding.action.kind === 'expression' ? c.avatarExpressions[binding.action.id] : binding.action.kind === 'motion' ? c.avatarMotions[binding.action.id] : c.avatarReset}</dd>
    </div>)}</dl></details>
  </section>
}

createRoot(document.getElementById('root')!).render(<App />)
