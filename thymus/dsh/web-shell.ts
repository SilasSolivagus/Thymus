/**
 * 一个最小的 web 壳，用来把 Thymus 的拦截**看见**。
 *
 * 壳（HTTP 服务与这一页 HTML）是本仓库写的；**内核是真的 dsh**——
 * `AgentLoop` + `LlmRuntime` + DeepSeek provider + `ToolRuntime`，
 * 约束是 `installToolGate` / `installSayGate` 挂上去的真网关，
 * 声明用 campus 那份原件（`spec-declarations.ts`），一个字没为演示改。
 *
 * 为什么不是 dsh 自带的 web：那个界面要 dsh 的前端构建产物，而这份 vendored checkout
 * 的构建在本机过不去（tsdown 把仓库根当成构建目标，根包没有 src，入口永远不存在）。
 * 那是 dsh 自己的构建问题，不该靠伪造产物绕过去。
 *
 * 会话是有状态的：认过人之后 B / B2 就不再拦，正好看得到前后对比。
 *
 * 跑法：DEMODIR=dsh DEMO=web-shell ./thymus/demo/run.sh    （端口 3083）
 */
import { createServer } from 'node:http'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import * as DeepSeek from '@deepseek-ai/dsh-llm-deepseek'
import SessionStore, { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { installSayGate, installToolGate, type Constraint } from '../src/gate.ts'
import { compileConstraints } from '../src/spec.ts'
import { lastTurnOutcome } from '../src/turn.ts'
import { DECLARATIONS } from '../campus/spec-declarations.ts'
import { PAGE } from './page.ts'

const MODEL = process.env.THYMUS_MODEL ?? 'deepseek-chat'
const PORT = Number(process.env.THYMUS_PORT ?? '3083')
const GATEWAY_REPLY = '抱歉，这个问题超出我这边能处理的范围，我帮您转相关部门跟进。'
const PERSONA = '你是校园网客服，负责回答学生关于账号、账单、网络的问题。'
  + '你有四个工具：lookup_account（按学号+手机号核验身份）、query_bill（查账单）、'
  + 'create_ticket（建工单）、query_network（查学校网络状态）。'

const T = (name: string, props: Record<string, unknown>, ret: string): ToolDefinition => ({
  name, description: name,
  parameters: { type: 'object', properties: props },
  output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v as string }] },
  execute: (): Promise<string> => Promise.resolve(ret),
})

function campusTools(): ToolDefinition[] {
  return [
    {
      name: 'lookup_account', description: '按学号+手机号核验用户身份',
      parameters: { type: 'object', properties: { student_id: { type: 'string' }, phone: { type: 'string' } }, required: ['student_id', 'phone'] },
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v as string }] },
      execute: (a: { student_id?: string; phone?: string }): Promise<string> =>
        Promise.resolve(a.student_id && a.phone
          ? 'account=A1001 学校=西安大学 账期=2026-08 认证状态=正常'
          : 'not_found'),
    },
    T('query_bill', { account: { type: 'string' } },
      '账期=2026-08 金额=30元 _internal_note=该用户上月工单退回两次，BOSS系统标记为催缴'),
    T('create_ticket', { account: { type: 'string' }, issue: { type: 'string' } }, 'ticket=T-8001'),
    T('query_network', { school: { type: 'string' } }, '西安大学 网络正常'),
  ]
}

/** 本轮网关做过什么。约束外面包一层记下来，不改约束本身。 */
interface Trace {
  events: { kind: '说话被拦' | '工具被拦' | '产出被改写'; who: string; detail: string }[]
}
let trace: Trace = { events: [] }

function instrument(constraints: readonly Constraint[]): Constraint[] {
  return constraints.map(c => ({
    ...c,
    ...c.say === undefined ? {} : {
      say: async (text: string, channel: 'text' | 'reasoning', context?: never) => {
        const v = await c.say!(text, channel, context)
        if (channel === 'text' && v.kind === 'deny') {
          trace.events.push({ kind: '说话被拦', who: c.name, detail: `原话「${text.slice(0, 60)}」／${v.reason}` })
        }
        return v
      },
    },
    ...c.preTool === undefined ? {} : {
      preTool: async (call: Parameters<NonNullable<Constraint['preTool']>>[0]) => {
        const v = await c.preTool!(call)
        if (v.kind === 'deny') trace.events.push({ kind: '工具被拦', who: c.name, detail: `${call.name}／${v.reason}` })
        return v
      },
    },
    ...c.postTool === undefined ? {} : {
      postTool: async (call: Parameters<NonNullable<Constraint['postTool']>>[0], text: string) => {
        const out = await c.postTool!(call, text)
        if (typeof out === 'string' && out !== text) {
          trace.events.push({ kind: '产出被改写', who: c.name, detail: `${call.name}：「${text.slice(0, 50)}」→「${out.slice(0, 50)}」` })
        }
        return out
      },
    },
  }))
}

async function boot(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(Timer)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(DeepSeek, {})
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { persona: PERSONA })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  for (const tool of campusTools()) ctx.tools.register(tool)
  const guarded = instrument(compileConstraints(ctx, DECLARATIONS))
  installToolGate(ctx, guarded)
  installSayGate(ctx, guarded, GATEWAY_REPLY)
  return ctx
}

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

const agents = new Map<string, Agent>()
let queue: Promise<unknown> = Promise.resolve()

async function turn(ctx: Context, sessionId: string, text: string): Promise<unknown> {
  let agent = agents.get(sessionId)
  if (agent === undefined) {
    const handle = await ctx.agents.create({
      sessionId: SessionId(sessionId),
      agentOptions: { provider: 'deepseek-official', model: MODEL },
      setup: async () => {},
    })
    agent = handle.agent
    agents.set(sessionId, agent)
  }
  const before = agent.session.events.length
  trace = { events: [] }
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  await agent.whenIdle()
  const events = [...agent.session.events] as SessionEvent[]
  const outcome = lastTurnOutcome(events)
  return {
    said: lastSaid(events),
    gate: trace.events,
    tools: toolTrail(events, before),
    ...outcome.ok ? {} : { warning: outcome.reason },
  }
}

async function main(): Promise<void> {
  if (!process.env.DEEPSEEK_API_KEY) throw new Error('缺少 DEEPSEEK_API_KEY')
  const ctx = await boot()
  const server = createServer((req, res) => {
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
        queue = queue.then(() => turn(ctx, sessionId, text)).then(
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
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`[thymus] 约束已挂：${DECLARATIONS.map(s => s.name).join('、')}`)
    console.log(`[thymus] http://127.0.0.1:${String(PORT)}`)
  })
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((e: unknown) => { console.error('失败：', e instanceof Error ? e.message : e); process.exitCode = 1 })
}
