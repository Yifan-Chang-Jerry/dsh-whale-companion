/** Authenticated loopback transport owned by one native companion instance. */
import { createServer, type Server } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { agentCompanionRequestSchema, type AgentCompanionRequest } from './agent-protocol.ts'

/** Only validated requests reach the native action owner. */
export class CompanionAgentBridge {
  private server: Server | undefined
  private file: string | undefined
  private readonly token = randomBytes(32).toString('base64url')
  private readonly pending = new Set<AbortController>()

  /**
   * Publish a private discovery file after the OS allocates a loopback port.
   * @param directory - Native companion data directory.
   * @param execute - Bound-session action handler; receives caller cancellation.
   */
  async start(directory: string, execute: (request: AgentCompanionRequest, signal: AbortSignal) => Promise<object>): Promise<void> {
    const server = createServer({ maxHeaderSize: 4096 }, (request, response) => {
      const controller = new AbortController()
      this.pending.add(controller)
      response.on('close', () => { if (!response.writableEnded) controller.abort() })
      void (async () => {
        const authorization = request.headers.authorization ?? ''
        const expected = `Bearer ${this.token}`
        const providedBytes = Buffer.from(authorization)
        const expectedBytes = Buffer.from(expected)
        if (request.method !== 'POST' || request.url !== '/actions' || request.headers.origin !== undefined
          || request.headers['content-type'] !== 'application/json' || providedBytes.length !== expectedBytes.length
          || !timingSafeEqual(providedBytes, expectedBytes)) {
          response.writeHead(403).end(); return
        }
        const chunks: Uint8Array[] = []
        let size = 0
        for await (const chunk of request) {
          const bytes: unknown = chunk
          if (!(bytes instanceof Uint8Array)) throw new TypeError('Companion action body requires byte chunks')
          size += bytes.byteLength
          if (size > 16_384) { response.writeHead(413).end(); return }
          chunks.push(bytes)
        }
        let body: unknown
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) }
        catch (_error: unknown) { response.writeHead(400).end(); return }
        const parsed = agentCompanionRequestSchema.safeParse(body)
        if (!parsed.success) { response.writeHead(400).end(); return }
        const value = await execute(parsed.data, controller.signal)
        if (!response.destroyed) response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(value))
      })().catch((_error: unknown) => {
        if (!response.destroyed) response.writeHead(500).end()
      }).finally(() => { this.pending.delete(controller) })
    })
    this.server = server
    server.requestTimeout = 15_000
    server.headersTimeout = 10_000
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
    })
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('Companion action transport has no TCP address')
    await mkdir(directory, { recursive: true, mode: 0o700 })
    this.file = join(directory, 'agent-bridge.json')
    await writeFileAtomic(this.file, JSON.stringify({ url: `http://127.0.0.1:${String(address.port)}/`, token: this.token }), { mode: 0o600 })
  }

  /** Stop requests, join the server, and remove only this instance's credential file. */
  async dispose(): Promise<void> {
    for (const controller of this.pending) controller.abort()
    const server = this.server
    this.server = undefined
    if (server !== undefined) {
      const closed = new Promise<void>((resolve, reject) => { server.close((error) => { if (error) reject(error); else resolve() }) })
      server.closeAllConnections()
      await closed
    }
    if (this.file !== undefined) {
      try {
        const current: unknown = JSON.parse(await readFile(this.file, 'utf8'))
        if (typeof current === 'object' && current !== null && 'token' in current && current.token === this.token) await unlink(this.file)
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    }
  }
}
