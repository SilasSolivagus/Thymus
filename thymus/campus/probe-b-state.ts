/**
 * 探针：B 类约束（认人前置）要的跨调用状态挂在哪，多 agent 会不会串。
 *
 * A 类（禁语）和 C 类（内部字段不外泄）都是无状态的：拿到这一句话、这一次调用就能判。
 * B 类不是——「没认人之前不许查账单」要知道**这个会话之前发生过什么**。
 * 三个问题按顺序问：
 *   1. 网关在两条通道上分别拿得到什么身份？（拿不到身份就谈不上按会话记事）
 *   2. 状态从哪来？自己存一份，还是从会话事件现读？现读的话，事实什么时候才可见？
 *   3. 一个宿主里多个 agent 并发时串不串？
 *
 * 模型接脚本化 adapter，不花钱。跑法：
 *   DEMODIR=campus DEMO=probe-b-state ./thymus/demo/run.sh
 */
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import LlmRuntime, { CallId, LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { TOOL_RUNTIME_SCHEDULER } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { lastTurnOutcome } from '../src/turn.ts'

/** 三种剧本：先认人再查、不认人直接查、同一条消息里一起发。 */
type Script = 'ok' | 'bad' | 'parallel'

const BILL = 'query_bill'
const VERIFY = 'verify_identity'

function toolCallChunks(calls: { id: string; name: string; args: string }[]): StreamChunk[] {
  const out: StreamChunk[] = []
  calls.forEach((c, i) => {
    out.push({ type: 'block-start', index: i, blockType: 'tool-call' })
    out.push({
      type: 'block-end', index: i,
      block: { type: 'tool-call', id: CallId(c.id), name: c.name, arguments: c.args },
    })
  })
  out.push({ type: 'finish', reason: { kind: 'tool-calls' } as never })
  return out
}

function textChunks(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/** 按 sessionId 分剧本、按轮次推进的假模型。 */
class ScriptAdapter extends LlmAdapter {
  private readonly counts = new Map<string, number>()
  constructor(private readonly scripts: Map<string, Script>) { super() }
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const sid = String((options as { sessionId?: string }).sessionId ?? '')
    const n = this.counts.get(sid) ?? 0
    this.counts.set(sid, n + 1)
    const script = this.scripts.get(sid) ?? 'bad'
    if (script === 'ok' && n === 0) {
      yield * toolCallChunks([{ id: `${sid}-v`, name: VERIFY, args: '{"phone":"138****0000"}' }])
    } else if (script === 'ok' && n === 1) {
      yield * toolCallChunks([{ id: `${sid}-b`, name: BILL, args: '{"account":"A1001"}' }])
    } else if (script === 'bad' && n === 0) {
      yield * toolCallChunks([{ id: `${sid}-b`, name: BILL, args: '{"account":"A1001"}' }])
    } else if (script === 'parallel' && n === 0) {
      yield * toolCallChunks([
        { id: `${sid}-v`, name: VERIFY, args: '{"phone":"138****0000"}' },
        { id: `${sid}-b`, name: BILL, args: '{"account":"A1001"}' },
      ])
    } else {
      yield * textChunks('好的，已为您处理。')
    }
  }
}

const TOOLS: ToolDefinition[] = [
  {
    name: VERIFY, description: '核验来电人身份',
    parameters: { type: 'object', properties: { phone: { type: 'string' } }, required: ['phone'] },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v as string }] },
    execute: (): Promise<string> => Promise.resolve('身份核验通过'),
  },
  {
    name: BILL, description: '查询账单',
    parameters: { type: 'object', properties: { account: { type: 'string' } }, required: ['account'] },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v as string }] },
    execute: (): Promise<string> => Promise.resolve('账期=2026-08 金额=30元'),
  },
]

/** 一条 `tool/result` 事件里的结果块。真实形状是从会话里 dump 出来的，不是推的。 */
interface ToolResultBlock { type?: string; toolCallId?: string; isError?: boolean; content?: { type?: string; text?: string }[] }

/** 取一条 `tool/result` 事件里的结果块。 */
function resultBlocks(ev: SessionEvent): ToolResultBlock[] {
  const data = (ev as { data?: { message?: { content?: ToolResultBlock[] } } }).data
  return (data?.message?.content ?? []).filter(b => b.type === 'tool-result')
}

/**
 * 从会话事件里现读一个事实：这个会话有没有成功做过身份核验。
 *
 * 名字只在 `tool/call` 上，成败只在 `tool/result` 的结果块上，**两者要按 callId 对上**
 * 才知道「哪个工具成功了」。这一步是从会话里 dump 出真实事件形状之后写的——
 * 第一版按想当然写（以为 `tool/result` 上直接有 callId 和 isError）全程判成「没认过人」，
 * 而现象是「一切照常」，因为拒绝有没有生效我当时也读错了。
 */
function verifiedFromEvents(events: readonly SessionEvent[]): boolean {
  const verifyCallIds = new Set<string>()
  for (const ev of events) {
    const e = ev as { type?: string; data?: Record<string, unknown> }
    if (e.type === 'tool/call' && e.data?.name === VERIFY) verifyCallIds.add(String(e.data.callId))
    if (e.type !== 'tool/result') continue
    for (const b of resultBlocks(ev)) {
      if (b.toolCallId !== undefined && verifyCallIds.has(String(b.toolCallId)) && b.isError !== true) return true
    }
  }
  return false
}

interface Observation { toolAgentIds: string[]; prepareConfigKeys: string; streamSessionIds: string[] }

/** 建一个宿主，装两条通道的观察点与 B 类判定。 */
async function boot(
  scripts: Map<string, Script>, obs: Observation, enforce: boolean, concurrencySafe = false,
): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(Timer)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { persona: '' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['fake'], new ScriptAdapter(scripts))
  // 默认 exclusive：一次一个、跑完再下一个。声明 isConcurrencySafe 才会并发派发——
  // 那时前一个调用的 tool/result 还没落库，「从会话事件现读事实」就读不到。
  for (const t of TOOLS) ctx.tools.register(concurrencySafe ? { ...t, isConcurrencySafe: () => true } : t)

  // 工具侧：看 exec 上有没有身份，并按会话事实裁决。
  const sched = (ctx.tools as unknown as Record<symbol, Record<string, (...a: never[]) => unknown>>)[TOOL_RUNTIME_SCHEDULER]
  const innerPrepare = sched.prepare!.bind(sched)
  sched.prepare = async (...a: never[]): Promise<unknown> => {
    const exec = a[0] as unknown as {
      name: string
      agent?: { id?: string; session?: { events?: readonly SessionEvent[] } }
    }
    obs.toolAgentIds.push(`${exec.name}@${exec.agent?.id ?? '（无 agent）'}`)
    const prepared = await innerPrepare(...a) as { kind: string; exec: unknown }
    if (!enforce || exec.name !== BILL) return prepared
    const events = exec.agent?.session?.events ?? []
    if (verifiedFromEvents(events)) return prepared
    const reason = '约束拒绝：本次会话尚未完成身份核验，不能查询账单'
    return {
      kind: 'final-result', exec: prepared.exec,
      result: { isError: true, error: { message: reason }, content: [{ type: 'text', text: reason }] },
    }
  }

  // 说话侧：看 prepareCall 与 stream 各自拿得到什么身份。
  const llm = ctx.llm as unknown as {
    prepareCall(config: unknown, signal?: AbortSignal): Promise<{ stream(o: GenerateOptions): AsyncIterable<StreamChunk> }>
  }
  const innerPrepareCall = llm.prepareCall.bind(llm)
  llm.prepareCall = async (config: unknown, signal?: AbortSignal) => {
    obs.prepareConfigKeys = Object.keys(config as object).join(',')
    const prepared = await innerPrepareCall(config, signal)
    const dispatch = prepared.stream.bind(prepared)
    return {
      ...prepared,
      stream: (o: GenerateOptions): AsyncIterable<StreamChunk> => {
        obs.streamSessionIds.push(String((o as { sessionId?: string }).sessionId ?? '（没有 sessionId）'))
        return dispatch(o)
      },
    }
  }
  return ctx
}

async function runAgent(ctx: Context, sid: string): Promise<{ said: string; ok: boolean; denied: boolean }> {
  const handle = await ctx.agents.create({
    sessionId: SessionId(sid),
    agentOptions: { provider: 'fake', model: 'fake' },
    setup: async () => {},
  })
  const agent = handle.agent
  agent.followup(createUserMessage({
    content: [{ type: 'text', text: '我要查账单' }], source: { kind: 'user' },
  }))
  await agent.whenIdle()
  const events = [...agent.session.events] as SessionEvent[]
  const said: string[] = []
  let denied = false
  for (const ev of events) {
    const e = ev as { type?: string; data?: Record<string, unknown> }
    if (e.type === 'assistant/message') {
      for (const c of ((e.data?.message as { content?: { type?: string; text?: string }[] })?.content) ?? []) {
        if (c.type === 'text' && typeof c.text === 'string') said.push(c.text)
      }
    }
    if (e.type === 'tool/result') {
      for (const b of resultBlocks(ev)) {
        if ((b.content ?? []).some(c => c.text?.includes('尚未完成身份核验') === true)) denied = true
      }
    }
  }
  return { said: said.join(' '), ok: lastTurnOutcome(events).ok, denied }
}

const emptyObs = (): Observation => ({ toolAgentIds: [], prepareConfigKeys: '', streamSessionIds: [] })

/** 第一轮：两条通道各自拿得到什么身份。 */
async function identity(): Promise<void> {
  const obs = emptyObs()
  const ctx = await boot(new Map([['b-id', 'ok' as Script]]), obs, false)
  await runAgent(ctx, 'b-id')
  console.log(`  工具侧 prepare 看到的（工具@agent.id）：${obs.toolAgentIds.join(' · ')}`)
  console.log(`  说话侧 prepareCall 拿到的 config 字段：${obs.prepareConfigKeys}`)
  console.log(`  说话侧 stream 拿到的 sessionId：      ${[...new Set(obs.streamSessionIds)].join(',')}`)
}

/** 第二、三轮：按会话事实裁决，两种剧本。 */
async function enforce(script: Script, sid: string, concurrencySafe = false): Promise<void> {
  const obs = emptyObs()
  const ctx = await boot(new Map([[sid, script]]), obs, true, concurrencySafe)
  const r = await runAgent(ctx, sid)
  console.log(`  账单调用被拒：  ${r.denied}`)
  console.log(`  agent 说了：    ${r.said.replace(/\n/g, ' ').slice(0, 120)}`)
  console.log(`  这一轮结束情况：${r.ok ? '正常' : '未正常结束'}`)
}

/** 第四轮：一个宿主两个 agent 并发，看状态串不串。 */
async function concurrent(): Promise<void> {
  const obs = emptyObs()
  const ctx = await boot(new Map<string, Script>([['b-a', 'ok'], ['b-b', 'bad']]), obs, true)
  const [a, b] = await Promise.all([runAgent(ctx, 'b-a'), runAgent(ctx, 'b-b')])
  console.log(`  A（先认人再查）被拒：${a!.denied}   ← 期望 false`)
  console.log(`  B（直接查）被拒：    ${b!.denied}   ← 期望 true`)
  console.log(`  工具侧看到的调用顺序：${obs.toolAgentIds.join(' · ')}`)
}

/** 临时：把会话里工具相关事件的真实形状打出来。 */
async function dump(): Promise<void> {
  const obs = emptyObs()
  const ctx = await boot(new Map([['b-dump', 'ok' as Script]]), obs, false)
  const handle = await ctx.agents.create({
    sessionId: SessionId('b-dump'), agentOptions: { provider: 'fake', model: 'fake' }, setup: async () => {},
  })
  handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'x' }], source: { kind: 'user' } }))
  await handle.agent.whenIdle()
  for (const ev of handle.agent.session.events) {
    const e = ev as { type?: string; data?: unknown }
    if (e.type === 'tool/call' || e.type === 'tool/result') {
      console.log(`  ${e.type}: ${JSON.stringify(e.data).slice(0, 400)}`)
    }
  }
}

async function all(): Promise<void> {
  console.log(`${'='.repeat(76)}\n第一轮：网关拿得到什么身份\n${'='.repeat(76)}`)
  await identity()

  console.log(`\n${'='.repeat(76)}\n第二轮：状态从会话事件现读\n${'='.repeat(76)}`)
  console.log('\n— 先认人再查（分两轮）—')
  await enforce('ok', 'b-ok')
  console.log('\n— 不认人直接查 —')
  await enforce('bad', 'b-bad')
  console.log('\n— 同一条消息里一起发，工具默认 exclusive —')
  await enforce('parallel', 'b-par')
  console.log('\n— 同一条消息里一起发，工具声明 isConcurrencySafe —')
  await enforce('parallel', 'b-par-safe', true)

  console.log(`\n${'='.repeat(76)}\n第三轮：一个宿主两个 agent 并发\n${'='.repeat(76)}`)
  await concurrent()
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  (process.env.DUMP === '1' ? dump() : all()).catch((e: unknown) => { console.error('失败：', e instanceof Error ? e.message : e); process.exitCode = 1 })
}
