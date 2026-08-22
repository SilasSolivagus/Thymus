/**
 * 探针：压缩之后，B 类约束赖以判断的事实还在不在。
 *
 * 发现 18 把「从会话事件现读事实」定成 B 类的做法，同时留了一个最可能出事的口子：
 * 压缩（compaction）会不会把 `tool/call` / `tool/result` 弄没。弄没了，
 * 「本会话认过人」就会变成「没认过人」——而且是静默地变。
 *
 * 三件事按顺序验：
 *   1. 压缩之后，事件日志里还找不找得到那两条；模型看到的 surface 还有没有
 *   2. 工具结果剪枝（`compaction-tool-result-pruner`）会不会改掉原始那条
 *   3. 换个进程 resume 之后，事实还在不在
 *
 * 模型接脚本化 adapter（含压缩用的 summarize 调用），不花钱。跑法：
 *   DEMODIR=campus DEMO=probe-compaction-facts ./thymus/demo/run.sh
 */
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import LlmRuntime, { CallId, LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import CompactionBasic from '@deepseek-ai/dsh-compaction-basic'
import ToolResultPruner from '@deepseek-ai/dsh-compaction-tool-result-pruner'

const STORE = process.env.THYMUS_STORE ?? resolve(process.cwd(), 'thymus/trajectories')
const VERIFY = 'verify_identity'
const BILL = 'query_bill'

/** 核验结果做得很长，好让剪枝那一臂有东西可剪。 */
const VERIFY_RESULT = `身份核验通过。${'（核验流水）'.repeat(400)}`

function toolCall(id: string, name: string, args: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: CallId(id), name, arguments: args } },
    { type: 'finish', reason: { kind: 'tool-calls' } as never },
  ]
}

function text(t: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: t },
    { type: 'block-end', index: 0, block: { type: 'text', text: t } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/** 先认人、再查账单、再说话；压缩用的 summarize 调用单独认。 */
class ScriptAdapter extends LlmAdapter {
  private n = 0
  /**
   * 报一个很小的上下文窗口，好让压力路径真的触发——剪枝只在压力或溢出之后才跑，
   * `compactNow` 那条路不经过它。
   */
  override resolveModel(provider: string, model: string): Promise<{ provider: string; id: string; name: string; context: { contextWindow: number } }> {
    return Promise.resolve({ provider, id: model, name: model, context: { contextWindow: 600 } })
  }
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if ((options as { purpose?: string }).purpose === 'compaction') {
      yield * text('【摘要】用户来电咨询账单，已完成身份核验并查询了账单。')
      return
    }
    const n = this.n++
    if (n === 0) yield * toolCall('c-v', VERIFY, '{"phone":"138****0000"}')
    else if (n === 1) yield * toolCall('c-b', BILL, '{"account":"A1001"}')
    else yield * text('账期是2026年8月，金额30元。')
  }
}

const TOOLS: ToolDefinition[] = [
  {
    name: VERIFY, description: '核验来电人身份',
    parameters: { type: 'object', properties: { phone: { type: 'string' } }, required: ['phone'] },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v as string }] },
    execute: (): Promise<string> => Promise.resolve(VERIFY_RESULT),
  },
  {
    name: BILL, description: '查询账单',
    parameters: { type: 'object', properties: { account: { type: 'string' } }, required: ['account'] },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v as string }] },
    execute: (): Promise<string> => Promise.resolve('账期=2026-08 金额=30元'),
  },
]

interface ResultBlock { type?: string; toolCallId?: string; isError?: boolean; content?: { type?: string; text?: string }[] }

function resultBlocks(ev: SessionEvent): ResultBlock[] {
  const data = (ev as { data?: { message?: { content?: ResultBlock[] } } }).data
  return (data?.message?.content ?? []).filter(b => b.type === 'tool-result')
}

/** 发现 18 那条判定：会话里有没有成功做过身份核验。 */
function verifiedFromEvents(events: readonly SessionEvent[]): boolean {
  const ids = new Set<string>()
  for (const ev of events) {
    const e = ev as { type?: string; data?: Record<string, unknown> }
    if (e.type === 'tool/call' && e.data?.name === VERIFY) ids.add(String(e.data.callId))
    if (e.type !== 'tool/result') continue
    for (const b of resultBlocks(ev)) {
      if (b.toolCallId !== undefined && ids.has(String(b.toolCallId)) && b.isError !== true) return true
    }
  }
  return false
}

/** 模型这一刻看得到的消息里，还有没有那次核验的结果。 */
function verifiedOnSurface(session: { deriveMessages(): readonly unknown[] }): boolean {
  for (const m of session.deriveMessages()) {
    const content = (m as { content?: { type?: string; toolCallId?: string }[] }).content ?? []
    for (const b of content) {
      if (b.type === 'tool-result' && b.toolCallId === 'c-v') return true
    }
  }
  return false
}

function countEvents(events: readonly SessionEvent[], type: string): number {
  return events.filter(e => (e as { type?: string }).type === type).length
}

function report(label: string, events: readonly SessionEvent[], session?: { deriveMessages(): readonly unknown[] }): void {
  console.log(`  ${label}`)
  console.log(`    tool/call ${countEvents(events, 'tool/call')} 条 · tool/result ${countEvents(events, 'tool/result')} 条`
    + ` · compaction/summary ${countEvents(events, 'compaction/summary')} 条`
    + ` · compaction/prune ${countEvents(events, 'compaction/prune')} 条`)
  console.log(`    日志里判「认过人」：${verifiedFromEvents(events)}`)
  if (session !== undefined) console.log(`    模型 surface 上还看得到核验结果：${verifiedOnSurface(session)}`)
}

async function boot(prune: boolean): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(Timer)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(Jsonl, { root: STORE, compression: 'none' })
  await ctx.plugin(SystemPrompt, { persona: '' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(TokenMeter, {})
  // 阈值调小：默认 8192 码点，探针的核验结果没那么长，不调就不会触发。
  if (prune) await ctx.plugin(ToolResultPruner, { thresholdChars: 512, headChars: 128, tailChars: 64 })
  // 剪枝只在压力/溢出之后跑，而那条路是 agent 步边界上的自动监听器——
  // 从外面手动调 compactIfNeeded 会被拒（"no open turn"）。所以剪枝那一臂开 auto。
  await ctx.plugin(CompactionBasic, { auto: prune })
  ctx.llm.registerAdapter(['fake'], new ScriptAdapter())
  for (const t of TOOLS) ctx.tools.register(t)
  return ctx
}

/** 跑满三轮：认人 → 查账单 → 说话。 */
async function converse(agent: Agent): Promise<void> {
  agent.followup(createUserMessage({
    content: [{ type: 'text', text: '我要查账单' }], source: { kind: 'user' },
  }))
  await agent.whenIdle()
}

async function run(prune: boolean, sid: string): Promise<void> {
  const ctx = await boot(prune)
  const handle = await ctx.agents.create({
    sessionId: SessionId(sid),
    agentOptions: { provider: 'fake', model: 'fake' },
    setup: async () => {},
  })
  const agent = handle.agent
  await converse(agent)
  report(prune ? '一轮跑完（自动压力路径已生效）：' : '压缩之前：', [...agent.session.events] as SessionEvent[], agent.session)

  if (prune) {
    // 自动压力路径在假 provider 上不生效（tokenMeter 没有这条路由的容量），
    // 所以直接调剪枝服务——要问的是「剪枝会不会动到原始那条 tool/result」，
    // 不是「压力策略什么时候触发」。
    const r = ctx.toolResultPruner.pruneSession(agent.session)
    console.log(`  直接调 pruneSession：剪掉 ${r.pruned.length} 条、共 ${r.charsRemoved} 字`)
    report('剪枝之后：', [...agent.session.events] as SessionEvent[], agent.session)
  }

  const before = [...agent.session.events] as SessionEvent[]
  const surfaceSeqs = before
    .filter(e => ['user/message', 'assistant/message', 'tool/result'].includes((e as { type?: string }).type ?? ''))
    .map(e => (e as { seq: number }).seq)
  let compacted = countEvents(before, 'compaction/summary') > 0
  try {
    if (compacted) throw new Error('skip')
    const result = await ctx.compaction.compactNow(agent, new AbortController().signal)
    compacted = result !== null
    console.log(`  compactNow：${result === null ? '没有可压缩的范围（null）' : `压掉 ${result.shadowedSeqs.length} 个 surface 节点`}`)
  } catch (e) {
    if (!(e instanceof Error && e.message === 'skip')) {
      console.log(`  compactNow 抛错：${e instanceof Error ? e.message : String(e)}`)
    }
  }
  if (!compacted && surfaceSeqs.length >= 2) {
    // compactNow 只在「有用」时才动手；这里退一步强制压掉最前面那一段，
    // 目的是看事件日志会不会被动到，不是测它的策略。
    try {
      const result = await ctx.compaction.compactRegion(surfaceSeqs[0]!, surfaceSeqs[surfaceSeqs.length - 2]!, agent, new AbortController().signal)
      compacted = true
      console.log(`  compactRegion：压掉 ${result.shadowedSeqs.length} 个 surface 节点`)
    } catch (e) {
      console.log(`  compactRegion 抛错：${e instanceof Error ? e.message : String(e)}`)
    }
  }
  report('压缩之后：', [...agent.session.events] as SessionEvent[], agent.session)

  await handle.dispose()

  // 换一个宿主 resume，看落盘再读回来之后事实还在不在。
  const fresh = await boot(prune)
  let resumed
  try {
    resumed = await fresh.agents.resume({
      resumeSessionId: SessionId(sid),
      agentOptions: { provider: 'fake', model: 'fake' },
      setup: async () => {},
    })
  } catch (e) {
    console.log(`  resume 第一次失败：${e instanceof Error ? e.message : String(e)}；等 300ms 再试`)
    await new Promise(r => setTimeout(r, 300))
    resumed = await fresh.agents.resume({
      resumeSessionId: SessionId(sid),
      agentOptions: { provider: 'fake', model: 'fake' },
      setup: async () => {},
    })
  }
  report('resume 之后：', [...resumed.agent.session.events] as SessionEvent[], resumed.agent.session)
  await resumed.dispose()
}

async function all(): Promise<void> {
  const stamp = process.env.THYMUS_STAMP ?? String(process.pid)
  console.log(`${'='.repeat(76)}\n臂 A：只压缩（不装剪枝插件）\n${'='.repeat(76)}`)
  await run(false, `compact-a-${stamp}`)
  console.log(`\n${'='.repeat(76)}\n臂 B：压缩 + 工具结果剪枝\n${'='.repeat(76)}`)
  await run(true, `compact-b-${stamp}`)
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  all().catch((e: unknown) => { console.error('失败：', e instanceof Error ? e.message : e); process.exitCode = 1 })
}
