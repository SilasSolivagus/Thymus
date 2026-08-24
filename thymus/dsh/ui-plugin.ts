/**
 * 观察界面，**一个 dsh 插件**：它不搭宿主，只用 dsh 给它的 `ctx`。
 *
 * 治理不在这里——约束由 `plugin.ts` 挂。这个插件只做两件事：起一个 HTTP 服务，
 * 和把 `thymusTrace`（`plugin.ts` 挂在 ctx 上的旁路记录）按轮读出来给页面看。
 * 拆成两个插件是有意的：治理那条不依赖界面，界面拿掉治理照常生效。
 */
import { createServer, type Server } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { lastTurnOutcome } from '../src/turn.ts'
import type { ThymusEvent, ThymusTrace } from './plugin.ts'
import { PAGE } from './page.ts'

export const name = 'thymus-ui'
export const inject = ['agents', 'thymusTrace']

export interface Config { port?: number; provider?: string; model?: string }

/** agent 说给用户的最后一段正文。 */
function lastSaid(events: readonly SessionEvent[]): string {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i] as { type?: string; data?: { message?: { content?: { type?: string; text?: string }[] } } }
    if (e.type !== 'assistant/message') continue
    const text = (e.data?.message?.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('')
    if (text !== '') return text
  }
  return ''
}

/**
 * 本轮调过哪些工具、拿回什么。
 *
 * `tool/result` 的 message.content[0] 是一个 `tool-result` 块，正文在它**里面那层**
 * `content` 里——直接读外层的 text 会拿到空字符串。
 */
function toolTrail(events: readonly SessionEvent[], from: number): string[] {
  const out: string[] = []
  for (const ev of events.slice(from)) {
    const e = ev as {
      type?: string
      data?: { name?: string; message?: { content?: { type?: string; isError?: boolean; content?: { type?: string; text?: string }[] }[] } }
    }
    if (e.type === 'tool/call') out.push(`调用 ${e.data?.name ?? '?'}`)
    if (e.type === 'tool/result') {
      const block = e.data?.message?.content?.find(c => c.type === 'tool-result')
      const text = (block?.content ?? []).filter(c => c.type === 'text').map(c => c.text ?? '').join(' ')
      out.push(`${block?.isError === true ? '被拒绝' : '返回'}：${text.slice(0, 120)}`)
    }
  }
  return out
}

export function apply(ctx: Context, config: Config = {}): void {
  const port = config.port ?? 3083
  const provider = config.provider ?? 'deepseek-official'
  const model = config.model ?? process.env.THYMUS_MODEL ?? 'deepseek-chat'
  const host = ctx as unknown as {
    agents: { create(o: unknown): Promise<{ agent: Agent }> }
    thymusTrace: ThymusTrace
  }
  const agents = new Map<string, Agent>()
  let queue: Promise<unknown> = Promise.resolve()

  async function turn(sessionId: string, text: string): Promise<unknown> {
    let agent = agents.get(sessionId)
    if (agent === undefined) {
      const handle = await host.agents.create({
        sessionId: SessionId(sessionId),
        agentOptions: { provider, model },
        setup: async () => {},
      })
      agent = handle.agent
      agents.set(sessionId, agent)
    }
    const before = agent.session.events.length
    host.thymusTrace.reset()
    agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
    await agent.whenIdle()
    const events = [...agent.session.events] as SessionEvent[]
    const outcome = lastTurnOutcome(events)
    const gate: ThymusEvent[] = [...host.thymusTrace.events]
    return {
      said: lastSaid(events), gate, tools: toolTrail(events, before),
      ...outcome.ok ? {} : { warning: outcome.reason },
    }
  }

  const server: Server = createServer((req, res) => {
    if (req.method === 'GET' && (req.url === '/' || req.url?.startsWith('/?'))) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(PAGE)
      return
    }
    if (req.method === 'POST' && req.url === '/api/chat') {
      let body = ''
      req.on('data', chunk => { body += chunk })
      req.on('end', () => {
        const { sessionId, text } = JSON.parse(body) as { sessionId: string; text: string }
        queue = queue.then(() => turn(sessionId, text)).then(
          result => {
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify(result))
          },
          (e: unknown) => {
            res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }))
          },
        )
      })
      return
    }
    res.writeHead(404); res.end()
  })
  server.listen(port, '127.0.0.1', () => { console.log(`[thymus-ui] http://127.0.0.1:${String(port)}`) })
  // 插件卸载时把端口还回去——dsh 的 effect 语义。
  ctx.effect(() => () => { server.close() })
}
