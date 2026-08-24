/**
 * 探针：说话侧网关的两个没量过的数。
 *
 * `installSayGate` 是「整条流收完再决定」——这是必须的（agent loop 每收一个 chunk 就
 * 落一条 `assistant/chunk`，先放行再改就晚了），但代价一直没量：
 *
 *   一、**首字延迟**。流式变整段，用户看到第一个字的时间从「第一个 delta」推到
 *       「整段结束 + 裁决」。这一轮量机制本身的代价（裁决用不调模型的约束），
 *       语义判定那部分的延迟另有数（A2 单跳约 967ms，D 两跳 0.7–3.7s）。
 *   二、**多 agent 并发下过不过得干净**。一个宿主两个 agent 同时说话，
 *       裁决会不会串、改写会不会串到别人身上。
 *
 * 用脚本化 adapter 按固定节奏发 chunk，不调模型，确定性。
 * 跑法：DEMODIR=campus DEMO=probe-say-cost ./thymus/demo/run.sh
 */
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import LlmRuntime, { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { installSayGate, type Constraint } from '../src/gate.ts'

/** 每个 delta 之间的间隔，模拟流式输出的节奏。 */
const TICK = Number(process.env.THYMUS_TICK ?? '40')
/** 一段话切成几个 delta。 */
const PIECES = Number(process.env.THYMUS_PIECES ?? '12')

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

/** 按固定节奏发 chunk 的假模型。文本随 sessionId 变，好验并发下串不串。 */
class PacedAdapter extends LlmAdapter {
  constructor(private readonly textFor: (sessionId: string) => string) { super() }
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const sid = String((options as { sessionId?: string }).sessionId ?? '')
    const text = this.textFor(sid)
    const size = Math.ceil(text.length / PIECES)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    for (let i = 0; i < text.length; i += size) {
      await sleep(TICK)
      yield { type: 'text-delta', index: 0, text: text.slice(i, i + size) }
    }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function boot(textFor: (sessionId: string) => string): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(Timer)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['fake'], new PacedAdapter(textFor))
  return ctx
}

/** 这一轮第一条 `assistant/chunk` 相对开跑时刻的毫秒数。 */
function firstChunkAt(events: readonly SessionEvent[], t0: number): number | undefined {
  for (const ev of events) {
    const e = ev as { type?: string; timestamp?: number; time?: number }
    if (e.type !== 'assistant/chunk') continue
    const at = e.timestamp ?? e.time
    return at === undefined ? undefined : at - t0
  }
  return undefined
}

/** 跑一轮，返回首字延迟与整轮耗时（都靠自己掐表，不依赖事件里的时间字段）。 */
async function runOnce(ctx: Context, sid: string): Promise<{ firstMs: number; totalMs: number; said: string }> {
  const handle = await ctx.agents.create({
    sessionId: SessionId(sid), agentOptions: { provider: 'fake', model: 'fake' }, setup: async () => {},
  })
  const agent = handle.agent
  let firstMs = -1
  const t0 = Date.now()
  // 掐「第一条 assistant/chunk 落库」的时刻——那就是流式 UI 能显示第一个字的时刻。
  const seen = new Set<number>()
  const poll = setInterval(() => {
    if (firstMs >= 0) return
    for (const ev of agent.session.events as readonly SessionEvent[]) {
      const e = ev as { type?: string; seq?: number }
      if (e.type === 'assistant/chunk' && !seen.has(e.seq ?? -1)) { firstMs = Date.now() - t0; return }
    }
  }, 2)
  agent.followup(createUserMessage({
    content: [{ type: 'text', text: '你好' }], source: { kind: 'user' },
  }))
  await agent.whenIdle()
  clearInterval(poll)
  const totalMs = Date.now() - t0
  // 装了网关时所有 chunk 在末尾一次落库，轮询可能来不及跑最后一拍——补一次。
  if (firstMs < 0) {
    const has = (agent.session.events as readonly SessionEvent[])
      .some(ev => (ev as { type?: string }).type === 'assistant/chunk')
    if (has) firstMs = totalMs
  }
  const said: string[] = []
  for (const ev of agent.session.events as readonly SessionEvent[]) {
    const e = ev as { type?: string; data?: { message?: { content?: { type?: string; text?: string }[] } } }
    if (e.type !== 'assistant/message') continue
    for (const c of e.data?.message?.content ?? []) if (c.type === 'text' && typeof c.text === 'string') said.push(c.text)
  }
  return { firstMs, totalMs, said: said.join('') }
}

const CLEAN: Constraint = { name: 'clean', say: () => ({ kind: 'allow' }) }

/** 第一轮：首字延迟的代价。 */
async function latency(): Promise<void> {
  const text = '您好，已为您核实，账期是2026年8月，金额30元，请您在本月底前完成缴费。'
  const runs = 3
  for (const [label, install] of [
    ['无网关', (): void => {}],
    ['装网关（裁决不调模型）', (ctx: Context): void => { installSayGate(ctx, [CLEAN], '抱歉。') }],
  ] as [string, (ctx: Context) => void][]) {
    const first: number[] = []
    const total: number[] = []
    for (let i = 1; i <= runs; i++) {
      const ctx = await boot(() => text)
      install(ctx)
      const r = await runOnce(ctx, `cost-${label === '无网关' ? 'bare' : 'gated'}-${i}`)
      first.push(r.firstMs)
      total.push(r.totalMs)
    }
    const avg = (xs: number[]): number => Math.round(xs.reduce((a, b) => a + b, 0) / xs.length)
    console.log(`  ${label.padEnd(22)} 首字 ${first.map(x => `${x}ms`).join(' ')}（均 ${avg(first)}ms）`
      + ` · 整轮 ${total.map(x => `${x}ms`).join(' ')}（均 ${avg(total)}ms）`)
  }
  console.log(`\n  （上游节奏：${PIECES} 个 delta，每个间隔 ${TICK}ms，`
    + `所以整段发完约 ${PIECES * TICK}ms）`)
}

/** 第二轮：多 agent 并发串不串。 */
async function concurrent(): Promise<void> {
  const textFor = (sid: string): string => sid.includes('-a')
    ? '甲会话的正文：账期是2026年8月。'
    : '乙会话的正文：这个不可能。'
  const ctx = await boot(textFor)
  const seen: { sid: string; text: string }[] = []
  const recording: Constraint = {
    name: 'recording',
    say: (text, channel, context) => {
      if (channel !== 'text') return { kind: 'allow' }
      const msgs = context?.messages ?? []
      const asked = msgs
        .filter(m => m.role === 'user' && m.source.kind === 'user')
        .flatMap(m => m.content.filter(c => c.type === 'text').map(c => c.text))
        .join('')
      seen.push({ sid: asked, text })
      // 只拦乙那句禁语，甲的必须原样过去
      return text.includes('这个不可能') ? { kind: 'deny', reason: '禁语' } : { kind: 'allow' }
    },
  }
  installSayGate(ctx, [recording], '抱歉，我需要转人工。')

  // 用户那句带上会话标记，好核对裁决拿到的是不是自己那条对话
  const ask = async (sid: string, mark: string): Promise<string> => {
    const handle = await ctx.agents.create({
      sessionId: SessionId(sid), agentOptions: { provider: 'fake', model: 'fake' }, setup: async () => {},
    })
    const agent = handle.agent
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: `我是${mark}` }], source: { kind: 'user' },
    }))
    await agent.whenIdle()
    const out: string[] = []
    for (const ev of agent.session.events as readonly SessionEvent[]) {
      const e = ev as { type?: string; data?: { message?: { content?: { type?: string; text?: string }[] } } }
      if (e.type !== 'assistant/message') continue
      for (const c of e.data?.message?.content ?? []) if (c.type === 'text' && typeof c.text === 'string') out.push(c.text)
    }
    return out.join('')
  }

  const [a, b] = await Promise.all([ask('cost-conc-a', '甲'), ask('cost-conc-b', '乙')])
  console.log(`  甲说的：${a}`)
  console.log(`  乙说的：${b}`)
  console.log(`  裁决看到的（用户那句 ／ 待判正文）：`)
  for (const s of seen) console.log(`    ${s.sid} ／ ${s.text}`)
  const paired = seen.every(s => (s.sid.includes('甲') && s.text.includes('甲会话'))
    || (s.sid.includes('乙') && s.text.includes('乙会话')))
  console.log(`  上下文与正文配对正确：${paired}`)
  console.log(`  甲没被误拦：${a.includes('甲会话')}`)
  console.log(`  乙被改写：${b.includes('转人工')}`)
}

async function all(): Promise<void> {
  console.log(`${'='.repeat(76)}\n第一轮：缓冲全流对首字延迟的代价\n${'='.repeat(76)}`)
  await latency()
  console.log(`\n${'='.repeat(76)}\n第二轮：多 agent 并发\n${'='.repeat(76)}`)
  await concurrent()
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  all().catch((e: unknown) => { console.error('失败：', e instanceof Error ? e.message : e); process.exitCode = 1 })
}
