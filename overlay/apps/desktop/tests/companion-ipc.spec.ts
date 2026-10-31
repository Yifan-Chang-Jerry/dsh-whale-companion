/** Registered-frame authorization and the first-snapshot handoff, without rendering a UI. */
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it, vi } from 'vitest'
import type { BrowserWindow, IpcMainEvent } from 'electron'
import { CompanionWindows } from '../src/companion/windows.ts'
import { CompanionStore } from '../src/companion/store.ts'
import type { CompanionSnapshot } from '../src/companion/api.ts'

const native = vi.hoisted(() => ({ directory: '', shortcuts: new Map<string, () => void>(), blocked: new Set<string>() }))
vi.mock('electron', () => ({
  app: { getPath: () => native.directory },
  ipcMain: { removeHandler: vi.fn(), off: vi.fn() },
  powerMonitor: { off: vi.fn() },
  globalShortcut: {
    register: (key: string, callback: () => void) => {
      if (native.blocked.has(key) || native.shortcuts.has(key)) return false
      native.shortcuts.set(key, callback)
      return true
    },
    unregister: (key: string) => { native.shortcuts.delete(key) },
  },
  screen: {
    off: vi.fn(),
    getDisplayNearestPoint: () => ({ id: 1, workArea: { x: 0, y: 0, width: 1440, height: 900 } }),
    getDisplayMatching: () => ({ id: 1, workArea: { x: 0, y: 0, width: 1440, height: 900 } }),
  },
}))

it('admits only the registered main frame and refuses Pet prompt submission', async () => {
  native.directory = await mkdtemp(join(tmpdir(), 'dsh-companion-ipc-'))
  try {
    const owner = new CompanionWindows({ locale: () => 'zh', openWorkbench: async () => {} })
    const frame = { url: 'dsh-app://companion/index.html?view=pet' }
    const contents = { id: 1, mainFrame: frame, send: vi.fn() }
    let destroyed = false
    // Partial Electron resources exercise only the IPC fields the bridge reads.
    const window = { webContents: contents, isDestroyed: () => destroyed } as never
    owner['windows'].set(1, { window, role: 'pet', subscribed: false })
    const event = { sender: contents, senderFrame: frame } as never
    const prompt = { type: 'send', sessionId: 'session-a', bindingVersion: 0, requestId: 'c0ef9058-39a2-4aad-b02b-383da3945d96', text: 'do not run' }
    expect((await owner['command'](event, prompt)).ok).toBe(false)
    expect((await owner['command'](event, { type: 'shortcut-recording', active: true })).ok).toBe(false)
    expect(owner.store.data.submissions).toEqual([])
    const child = { sender: contents, senderFrame: { url: frame.url } } as never
    expect((await owner['command'](child, { type: 'pat' })).ok).toBe(false)
    frame.url = 'https://untrusted.example/index.html?view=pet'
    expect((await owner['command'](event, { type: 'pat' })).ok).toBe(false)
    frame.url = 'dsh-app://companion/index.html?view=pet'
    destroyed = true
    expect((await owner['command'](event, { type: 'pat' })).ok).toBe(false)
  } finally { await rm(native.directory, { recursive: true, force: true }) }
})

it('records and restores the global wake shortcut while retaining the saved combination on conflict', async () => {
  native.directory = await mkdtemp(join(tmpdir(), 'dsh-companion-shortcut-'))
  const owner = new CompanionWindows({ locale: () => 'zh', openWorkbench: async () => {} })
  try {
    const frame = { url: 'dsh-app://companion/index.html?view=panel' }
    const contents = { id: 10, mainFrame: frame, send: vi.fn(), setIgnoreMenuShortcuts: vi.fn() }
    const panel = { webContents: contents, isDestroyed: () => false, isVisible: () => true,
      setAlwaysOnTop: vi.fn(), destroy: vi.fn() } as never
    owner['panel'] = panel
    owner['windows'].set(10, { window: panel, role: 'panel', subscribed: false })
    owner.store.data.preferences.avatar.autoDance = false
    const event = { sender: contents, senderFrame: frame } as never
    const original = owner.store.data.preferences.shortcut
    owner['refreshShortcut']()
    expect(native.shortcuts.has(original)).toBe(true)
    expect(await owner['command'](event, { type: 'shortcut-recording', active: true })).toMatchObject({ ok: true })
    expect(native.shortcuts.has(original)).toBe(false)
    expect(contents.setIgnoreMenuShortcuts).toHaveBeenLastCalledWith(true)
    expect(await owner['command'](event, { type: 'shortcut-recording', active: false })).toMatchObject({ ok: true })
    expect(native.shortcuts.has(original)).toBe(true)
    await owner['command'](event, { type: 'shortcut-recording', active: true })
    const custom = 'Control+Alt+K'
    expect(await owner['command'](event, { type: 'preferences', value: { shortcut: custom, shortcutEnabled: true } })).toMatchObject({ ok: true })
    expect(native.shortcuts.has(custom)).toBe(true)
    expect(contents.setIgnoreMenuShortcuts).toHaveBeenLastCalledWith(false)
    const open = vi.spyOn(owner, 'showPanel').mockImplementation(() => {})
    native.shortcuts.get(custom)!()
    expect(open).toHaveBeenCalledOnce()
    native.blocked.add('Control+Alt+L')
    await owner['command'](event, { type: 'shortcut-recording', active: true })
    expect(await owner['command'](event, { type: 'preferences', value: { shortcut: 'Control+Alt+L' } })).toMatchObject({ ok: false })
    expect(owner.store.data.preferences.shortcut).toBe(custom)
    expect(native.shortcuts.has(custom)).toBe(true)
    const restored = new CompanionStore(join(native.directory, 'companion'), () => {})
    await restored.load()
    expect(restored.data.preferences).toMatchObject({ shortcut: custom, shortcutEnabled: true })
  } finally {
    await owner.dispose()
    native.blocked.clear()
    await rm(native.directory, { recursive: true, force: true })
  }
})

it('registers a subscription before delivering a current complete snapshot', async () => {
  native.directory = await mkdtemp(join(tmpdir(), 'dsh-companion-ipc-'))
  try {
    const owner = new CompanionWindows({ locale: () => 'zh', openWorkbench: async () => {} })
    const frame = { url: 'dsh-app://companion/index.html?view=panel' }
    const snapshots: CompanionSnapshot[] = []
    let observedRegistered = false
    const contents = { id: 2, mainFrame: frame, send: (_channel: string, snapshot: CompanionSnapshot) => {
      observedRegistered = owner['windows'].get(2)!.subscribed
      snapshots.push(snapshot)
    } }
    const window = { webContents: contents, isDestroyed: () => false } as BrowserWindow
    owner['windows'].set(2, { window, role: 'panel', subscribed: false })
    owner.store.data.preferences.mode = 'quiet'
    const event = { sender: contents, senderFrame: frame } as IpcMainEvent
    owner['subscribe'](event)
    expect(observedRegistered).toBe(true)
    expect(snapshots[0]?.preferences.mode).toBe('quiet')
    owner['unsubscribe'](event)
    owner.store.data.drafts.unbound = '中文恢复草稿'
    owner['subscribe'](event)
    expect(snapshots.at(-1)?.draft).toBe('中文恢复草稿')
    expect(snapshots.at(-1)!.revision).toBeGreaterThan(snapshots[0]!.revision)
  } finally { await rm(native.directory, { recursive: true, force: true }) }
})

it('keeps a fast drag distinct from a click even when IPC receives only its start and end', async () => {
  native.directory = await mkdtemp(join(tmpdir(), 'dsh-companion-drag-'))
  try {
    const owner = new CompanionWindows({ locale: () => 'zh', openWorkbench: async () => {} })
    const bounds = { x: 200, y: 200, width: 220, height: 265 }
    owner['pet'] = {
      getBounds: () => ({ ...bounds }), isVisible: () => false,
      setPosition: (x: number, y: number) => { bounds.x = x; bounds.y = y },
    } as never
    const open = vi.spyOn(owner, 'showPanel')
    owner['movePet']('start', { x: 250, y: 250 })
    owner['movePet']('end', { x: 280, y: 290 })
    await owner.store.flush()
    expect(bounds).toMatchObject({ x: 230, y: 240 })
    expect(open).not.toHaveBeenCalled()
    expect(owner.store.data.position?.displayId).toBe(1)
  } finally { await rm(native.directory, { recursive: true, force: true }) }
})

it('keeps appearance choices across unrelated preferences and replaces only conflicting presets', async () => {
  native.directory = await mkdtemp(join(tmpdir(), 'dsh-companion-presets-'))
  const owner = new CompanionWindows({ locale: () => 'zh', openWorkbench: async () => {} })
  try {
    const frame = { url: 'dsh-app://companion/index.html?view=panel' }
    const contents = { id: 3, mainFrame: frame, send: vi.fn() }
    owner['windows'].set(3, { window: { webContents: contents, isDestroyed: () => false } as never, role: 'panel', subscribed: false })
    const event = { sender: contents, senderFrame: frame } as never
    owner.store.data.preferences.avatar.body = 1
    for (const id of ['heart-eyes', 'glasses', 'spiral-eyes'] as const) {
      expect((await owner['command'](event, { type: 'avatar', action: { kind: 'expression', id } })).ok).toBe(true)
    }
    expect((await owner['command'](event, { type: 'preferences', value: { reducedMotion: true } })).ok).toBe(true)
    expect(owner.store.data.preferences.avatar).toMatchObject({ body: 1, expressions: ['glasses', 'spiral-eyes'] })
    await owner['command'](event, { type: 'avatar', action: { kind: 'expression', id: 'glasses' } })
    expect(owner.store.data.preferences.avatar.expressions).toEqual(['spiral-eyes'])
    owner.store.data.preferences.reducedMotion = false
    owner['pet'] = { isVisible: () => true, destroy: vi.fn() } as never
    owner['avatarModelPhase'] = 'ready'
    await owner['command'](event, { type: 'avatar', action: { kind: 'expression', id: 'point-on' } })
    expect(owner.store.data.preferences.avatar.expressions).toContain('point-on')
    await owner['command'](event, { type: 'avatar', action: { kind: 'motion', id: 'point-off' } })
    expect(owner.store.data.preferences.avatar.expressions).toEqual(['spiral-eyes'])
  } finally { await owner.dispose(); await rm(native.directory, { recursive: true, force: true }) }
})

it('starts one idle dance, interrupts on interaction, and ignores acknowledgements from a replaced playback', async () => {
  native.directory = await mkdtemp(join(tmpdir(), 'dsh-companion-dance-'))
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  const owner = new CompanionWindows({ locale: () => 'zh', openWorkbench: async () => {} })
  try {
    vi.setSystemTime(new Date('2026-10-30T12:00:00Z'))
    const frame = { url: 'dsh-app://companion/index.html?view=pet' }
    const contents = { id: 4, mainFrame: frame, send: vi.fn() }
    owner['pet'] = { webContents: contents, isVisible: () => true, setIgnoreMouseEvents: vi.fn(), destroy: vi.fn() } as never
    owner['windows'].set(4, { window: { webContents: contents, isDestroyed: () => false } as never, role: 'pet', subscribed: false })
    const event = { sender: contents, senderFrame: frame } as never
    owner.store.data.preferences.quietHours = false
    Object.assign(owner.store.data.preferences.avatar, { danceIdleMinutes: 1, danceChance: 1, danceCooldownMinutes: 1 })
    await owner['command'](event, { type: 'avatar-model', phase: 'ready' })
    await vi.advanceTimersByTimeAsync(59_999)
    expect(owner['snapshot']().avatar.playback).toBeNull()
    await vi.advanceTimersByTimeAsync(1)
    const first = owner['snapshot']().avatar.playback!
    expect(first).toMatchObject({ motion: 'dance', automatic: true, started: false })
    await owner['command'](event, { type: 'avatar-started', sequence: first.sequence })
    await owner['command'](event, { type: 'interactive', value: true })
    expect(owner['snapshot']().avatar.playback).toBeNull()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(owner['snapshot']().avatar.playback).toBeNull()
    await owner['command'](event, { type: 'interactive', value: false })
    await vi.advanceTimersByTimeAsync(60_000)
    const second = owner['snapshot']().avatar.playback!
    expect(second.sequence).toBeGreaterThan(first.sequence)
    await owner['command'](event, { type: 'avatar-finished', sequence: first.sequence })
    expect(owner['snapshot']().avatar.playback?.sequence).toBe(second.sequence)
    owner['adapter'].activity = 'thinking'
    owner['publish']()
    expect(owner['snapshot']().avatar.playback).toBeNull()
    await owner.dispose()
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    await owner.dispose()
    vi.useRealTimers()
    await rm(native.directory, { recursive: true, force: true })
  }
})

it('admits only the bound Agent, waits for the matching renderer receipt, and honors manual stop', async () => {
  native.directory = await mkdtemp(join(tmpdir(), 'dsh-companion-agent-'))
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  const owner = new CompanionWindows({ locale: () => 'zh', openWorkbench: async () => {} })
  try {
    const frame = { url: 'dsh-app://companion/index.html?view=pet' }
    const contents = { id: 5, mainFrame: frame, send: vi.fn() }
    owner['pet'] = { webContents: contents, isVisible: () => true, destroy: vi.fn() } as never
    owner['windows'].set(5, { window: { webContents: contents, isDestroyed: () => false } as never, role: 'pet', subscribed: false })
    const panelFrame = { url: 'dsh-app://companion/index.html?view=panel' }
    const panelContents = { id: 6, mainFrame: panelFrame, send: vi.fn() }
    owner['windows'].set(6, { window: { webContents: panelContents, isDestroyed: () => false } as never, role: 'panel', subscribed: false })
    const event = { sender: contents, senderFrame: frame } as never
    const panelEvent = { sender: panelContents, senderFrame: panelFrame } as never
    owner.store.data.binding = { sessionId: 'whale', workspaceId: null, workspaceLabel: 'local', sessionLabel: 'Whale', cwd: native.directory }
    owner.store.data.preferences.avatar.autoDance = false
    owner['avatarModelPhase'] = 'ready'
    Object.assign(owner['adapter'], { available: true, connectionState: 'online', activity: 'tool-running', runKey: 'run-a' })
    expect(await owner['performAgentAction']({ sessionId: 'other', operation: 'perform', expressions: ['blush'], seconds: 4 }, new AbortController().signal))
      .toMatchObject({ ok: false, status: 'refused' })
    let settled = false
    const receipt = owner['performAgentAction']({ sessionId: 'whale', operation: 'perform', motion: 'chest-on', expressions: ['blush'], seconds: 4 }, new AbortController().signal)
      .then((value: object) => { settled = true; return value })
    const sequence = owner['snapshot']().avatar.agent!.sequence
    await owner['command'](event, { type: 'avatar-applied', sequence })
    expect(settled).toBe(false)
    expect((await owner['command'](panelEvent, { type: 'avatar-started', sequence })).ok).toBe(false)
    await owner['command'](event, { type: 'avatar-started', sequence })
    expect(await receipt).toMatchObject({ ok: true, status: 'started', sequence })
    expect(owner.store.data.preferences.avatar.expressions).toEqual([])
    await owner['command'](panelEvent, { type: 'avatar', action: { kind: 'stop' } })
    expect(owner['snapshot']().avatar.agent).toBeNull()
    expect(await owner['performAgentAction']({ sessionId: 'whale', operation: 'perform', expressions: ['blush'], seconds: 4 }, new AbortController().signal))
      .toMatchObject({ ok: false, status: 'refused' })
    await owner.dispose()
    expect(vi.getTimerCount()).toBe(0)
  } finally { await owner.dispose(); vi.useRealTimers(); await rm(native.directory, { recursive: true, force: true }) }
})

it('keeps background notifications across restart, deduplicates delivery, and clears only the continued Session', async () => {
  native.directory = await mkdtemp(join(tmpdir(), 'dsh-companion-notifications-'))
  const owner = new CompanionWindows({ locale: () => 'zh', openWorkbench: async () => {} })
  const restored = new CompanionWindows({ locale: () => 'zh', openWorkbench: async () => {} })
  const binding = { sessionId: 'foreground', workspaceId: null, workspaceLabel: 'local', sessionLabel: 'Foreground', cwd: native.directory }
  const source = { ...binding, sessionId: 'background', sessionLabel: 'Background reminder' }
  try {
    owner.store.data.binding = binding
    vi.spyOn(owner['adapter'], 'catalog').mockResolvedValue({ sessions: [source], workspaces: [] })
    const first = { operation: 'notify', sessionId: source.sessionId, requestId: 'call-1', text: '休息一下吧', emotion: 'happy' } as const
    expect(await owner['notifyOwner'](first, new AbortController().signal)).toMatchObject({ status: 'queued' })
    expect(await owner['notifyOwner'](first, new AbortController().signal)).toMatchObject({ status: 'queued' })
    expect(owner.store.data.notifications).toHaveLength(1)
    expect(owner.store.data.notifications[0]).toMatchObject({ emotion: 'happy', motion: 'sway', expressions: ['rabbit-teeth'] })
    expect(owner.store.data.binding).toEqual(binding)
    expect(await owner['notifyOwner']({ ...first, sessionId: 'unknown', expressions: [] }, new AbortController().signal))
      .toMatchObject({ ok: false, status: 'refused' })
    await owner['notifyOwner']({ ...first, requestId: 'call-2', text: '喝口水再继续', expressions: [] }, new AbortController().signal)
    await owner.dispose()
    await restored.store.load()
    expect(restored.store.data.notifications.map(item => item.text)).toEqual(['休息一下吧', '喝口水再继续'])
    expect(restored.store.data.binding).toEqual(binding)
    expect(restored.store.data.preferences.avatar.body).toBe(2)
    await restored['receiveAgentRequest']({ operation: 'read-notifications', sessionId: 'foreground', before: Date.now() }, new AbortController().signal)
    expect(restored.store.data.notifications).toHaveLength(2)
    await restored['receiveAgentRequest']({ operation: 'read-notifications', sessionId: source.sessionId,
      before: restored.store.data.notifications[0]!.createdAt - 1 }, new AbortController().signal)
    expect(restored.store.data.notifications).toHaveLength(2)
    await restored['receiveAgentRequest']({ operation: 'read-notifications', sessionId: source.sessionId, before: Date.now() }, new AbortController().signal)
    expect(restored.store.data.notifications).toEqual([])
    expect(restored.store.data.readNotifications).toHaveLength(2)
    vi.spyOn(restored['adapter'], 'catalog').mockResolvedValue({ sessions: [source], workspaces: [] })
    expect(await restored['notifyOwner']({ ...first, expressions: [] }, new AbortController().signal))
      .toMatchObject({ status: 'already-read' })
  } finally {
    await owner.dispose(); await restored.dispose()
    await rm(native.directory, { recursive: true, force: true })
  }
})

it('reports displayed only after the notification window acknowledges, including quiet static messages', async () => {
  native.directory = await mkdtemp(join(tmpdir(), 'dsh-companion-notify-receipt-'))
  const owner = new CompanionWindows({ locale: () => 'zh', openWorkbench: async () => {} })
  const acknowledgements: Promise<unknown>[] = []
  const observed = new Set<string>()
  try {
    owner.store.data.preferences.mode = 'quiet'
    owner.store.data.binding = { sessionId: 'whale', workspaceId: null, workspaceLabel: 'local', sessionLabel: 'Whale', cwd: native.directory }
    Object.assign(owner['adapter'], { available: true, connectionState: 'online' })
    owner['pet'] = {
      isVisible: () => true, getBounds: () => ({ x: 1100, y: 400, width: 220, height: 405 }), destroy: vi.fn(),
    } as never
    const frame = { url: 'dsh-app://companion/index.html?view=notice' }
    const contents = { id: 7, mainFrame: frame, send: (_channel: string, snapshot: CompanionSnapshot) => {
      const notice = snapshot.notification
      if (notice === null || observed.has(notice.id)) return
      observed.add(notice.id)
      acknowledgements.push(owner['command']({ sender: contents, senderFrame: frame } as never,
        { type: 'notification-shown', id: notice.id }))
    } }
    const window = { webContents: contents, isDestroyed: () => false, isVisible: () => true,
      setBounds: vi.fn(), hide: vi.fn(), destroy: vi.fn() } as never
    owner['notice'] = window
    owner['windows'].set(7, { window, role: 'notice', subscribed: true })
    const result = await owner['notifyOwner']({ operation: 'notify', sessionId: 'whale', requestId: 'shown',
      text: '本地任务完成啦', expressions: [] }, new AbortController().signal)
    expect(result).toMatchObject({ ok: true, status: 'displayed', animation: { status: 'suppressed' } })
    expect(owner['snapshot']().notification).toMatchObject({ text: '本地任务完成啦', unread: 1, speech: null, announced: true })
    const id = owner.store.data.notifications[0]!.id
    const foreignFrame = { url: 'dsh-app://companion/index.html?view=panel' }
    const foreignContents = { id: 8, mainFrame: foreignFrame, send: vi.fn() }
    owner['windows'].set(8, { window: { webContents: foreignContents, isDestroyed: () => false } as never,
      role: 'panel', subscribed: false })
    expect((await owner['command']({ sender: foreignContents, senderFrame: foreignFrame } as never,
      { type: 'notification-dismiss', id })).ok).toBe(false)
    await owner['command']({ sender: contents, senderFrame: frame } as never, { type: 'notification-dismiss', id })
    await Promise.all(acknowledgements)
    expect(owner['snapshot']().notification).toBeNull()
  } finally { await owner.dispose(); await rm(native.directory, { recursive: true, force: true }) }
})
