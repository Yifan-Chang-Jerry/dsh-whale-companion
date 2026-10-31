/** Native action transport authentication, cancellation, and prose-trigger policy. */
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { CompanionAgentBridge } from '../src/companion/agent-bridge.ts'
import { agentAvatarEndpointSchema } from '../src/companion/agent-protocol.ts'
import { narrationCue } from '../src/companion/narration.ts'

it('requires the native credential and validates the bounded request before dispatch', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-avatar-bridge-'))
  const bridge = new CompanionAgentBridge()
  const seen: string[] = []
  try {
    await bridge.start(directory, async (request) => { seen.push(request.operation); return { ok: true, status: 'applied' } })
    const file = join(directory, 'agent-bridge.json')
    const endpoint = agentAvatarEndpointSchema.parse(JSON.parse(await readFile(file, 'utf8')))
    if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600)
    const url = new URL('actions', endpoint.url)
    const headers = { authorization: `Bearer ${endpoint.token}`, 'content-type': 'application/json' }
    expect((await fetch(url, { method: 'POST', headers: { ...headers, authorization: 'Bearer invalid' }, body: '{}' })).status).toBe(403)
    expect((await fetch(url, { method: 'POST', headers, body: JSON.stringify({ sessionId: 'a', operation: 'perform', expressions: ['made-up'] }) })).status).toBe(400)
    expect((await fetch(url, { method: 'POST', headers: { ...headers, origin: 'https://example.com' }, body: '{}' })).status).toBe(403)
    const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ sessionId: 'a', operation: 'perform', expressions: ['blush'] }) })
    expect(await response.json()).toEqual({ ok: true, status: 'applied' })
    const notification = { operation: 'notify', sessionId: 'a', requestId: 'tool-call', text: '主人，任务完成啦' }
    expect((await fetch(url, { method: 'POST', headers, body: JSON.stringify({ ...notification, text: 'x'.repeat(61) }) })).status).toBe(400)
    expect((await fetch(url, { method: 'POST', headers, body: JSON.stringify({ ...notification, emotion: 'invented' }) })).status).toBe(400)
    expect((await fetch(url, { method: 'POST', headers, body: JSON.stringify({ ...notification, text: 'x'.repeat(60), emotion: 'happy' }) })).status).toBe(200)
    expect(seen).toEqual(['perform', 'notify'])
    await bridge.dispose()
    await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' })
  } finally { await bridge.dispose(); await rm(directory, { recursive: true, force: true }) }
})

it('recognizes opening character asides without interpreting examples, quotes, code, or ordinary prose', () => {
  expect(narrationCue('（脸红，往你身边靠了靠）收到啦。')).toEqual({ expressions: ['blush', 'lean'] })
  expect(narrationCue('（开心地点头）好呀')).toEqual({ expressions: ['rabbit-teeth'], motion: 'nod' })
  expect(narrationCue('（尾巴晃了两下）你好')).toEqual({ expressions: [], motion: 'sway' })
  for (const text of ['示例：（脸红）', '> （脸红）引用', '```text\n（脸红）\n```', '`（脸红）`']) expect(narrationCue(text)).toEqual({ expressions: [] })
})
