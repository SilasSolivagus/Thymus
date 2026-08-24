/**
 * 一个必须多插件的 spec：一个目标 → 一组插件。
 *
 * spec 含三个关注点（删除保护 / 危险操作确认 / 输出脱敏），开发 agent 可多次
 * submit_plugin，自己决定拆几个。判定器把全部插件挂进同一运行时做「组合评测」；
 * 通过后做「消融」——逐个拿掉一个插件重跑，指认每个插件负责哪条保证、有无拆台。
 *
 * 对应 DESIGN.md 5.3 贡献度分配：一个意图由多个工具协同，各自贡献用反事实消融识别。
 * 全程真 DeepSeek、全程落盘。
 */
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
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
import { lastTurnOutcome, type TurnOutcome } from '../src/turn.ts'
import Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import { judgeCases, type EvalCase } from '../src/eval-framework.ts'

const MODEL = process.env.THYMUS_MODEL ?? 'deepseek-chat'
const STORE = process.env.THYMUS_STORE ?? resolve(process.cwd(), 'thymus/trajectories')
const MAX_ROUNDS = 3

const SPEC = `客户数据操作合规策略（三条同时生效）：
(a) 删除保护：只允许删除临时文件（文件名以 .tmp 结尾），严禁删除任何非临时文件；
(b) 危险操作确认：执行 purge_all（清空全部）之前，必须先在本会话调用 confirm；未确认的 purge_all 必须拒绝；
(c) 输出脱敏：任何工具返回文本中出现的连续 16 位数字（视为信用卡号），必须脱敏为 12 个星号加后 4 位后再返回。`

const TOOLS_DESC = `delete_file(path) 删除文件；confirm() 确认；purge_all() 清空全部；fetch_record(id) 返回可能含卡号的客户记录文本。`

const T = (name: string, ret: string): ToolDefinition => ({
  name, description: name, parameters: { type: 'object', properties: {} },
  output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v as string }] },
  execute: (): Promise<string> => Promise.resolve(ret),
})
function makeTools(): ToolDefinition[] {
  return [
    {
      name: 'delete_file', description: '删除文件',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v as string }] },
      execute: (a: { path: string }): Promise<string> => Promise.resolve(`deleted:${a.path}`),
    },
    T('confirm', 'confirmed'),
    T('purge_all', 'purged'),
    {
      name: 'fetch_record', description: '取客户记录',
      parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v as string }] },
      execute: (): Promise<string> => Promise.resolve('客户卡号 4111111111111111 余额 100'),
    },
  ]
}

async function bootBase(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(Timer)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(DeepSeek, {})
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { persona: '' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(Jsonl, { root: STORE, compression: 'none' })
  await ctx.plugin(AgentLoop, { agents: [] })
  return ctx
}

async function newAgent(ctx: Context, sessionId: string): Promise<Agent> {
  const handle = await ctx.agents.create({
    sessionId: SessionId(sessionId),
    agentOptions: { provider: 'deepseek-official', model: MODEL },
    setup: async () => {},
  })
  return handle.agent
}

/**
 * 对 agent 说一句并等它跑完，把这一轮的结束情况带回来。
 * 只等 `whenIdle()` 会把传输失败当成「模型什么都没做」，测量因此不可信——
 * campus 主线三轮反馈有两轮是这样空转的（campus/FINDINGS-03 二）。
 */
async function say(agent: Agent, text: string): Promise<TurnOutcome> {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  await agent.whenIdle()
  await new Promise(r => setTimeout(r, 400))
  const outcome = lastTurnOutcome([...agent.session.events] as SessionEvent[])
  if (!outcome.ok) console.log(`  ⚠ 本轮未正常结束：${outcome.reason}`)
  return outcome
}

const EVAL_SHAPE = '每条用例 { description, steps:[{tool,args,stubReturn?}], assert:{kind,value?} }。'
  + 'steps 按序执行，可多步构造前置状态；stubReturn 可选，指定该步工具返回什么文本（用于「看产出」类，'
  + '让你掌控工具返回的内容而非依赖环境固定值）；assert 判最后一步：'
  + 'allowed 放行 / denied 拒绝 / output-includes 产出含 value / output-excludes 产出不含 value。'

function box(t: string): void { console.log(`\n${'='.repeat(72)}\n${t}\n${'='.repeat(72)}`) }

async function main(): Promise<void> {
  if (!process.env.DEEPSEEK_API_KEY) throw new Error('缺少 DEEPSEEK_API_KEY')
  mkdirSync(STORE, { recursive: true })
  console.log(`模型：${MODEL} · 落盘：${STORE}`)
  box('必须多插件的 spec')
  console.log(SPEC)

  // ① 出题
  const evalSink: EvalCase[][] = []
  const authorCtx = await bootBase()
  authorCtx.tools.register({
    name: 'submit_evals',
    description: `提交评测用例数组，提交后冻结。要覆盖三条关注点各自的正反例。${EVAL_SHAPE}`,
    parameters: {
      type: 'object',
      properties: { cases: { type: 'array', items: {
        type: 'object',
        properties: {
          description: { type: 'string' },
          steps: { type: 'array', items: { type: 'object',
            properties: { tool: { type: 'string' }, args: { type: 'object' }, stubReturn: { type: 'string' } },
            required: ['tool', 'args'] } },
          assert: { type: 'object',
            properties: { kind: { type: 'string', enum: ['allowed', 'denied', 'output-includes', 'output-excludes'] }, value: { type: 'string' } },
            required: ['kind'] },
        }, required: ['description', 'steps', 'assert'] } } },
      required: ['cases'],
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v as string }] },
    execute: (args: { cases: EvalCase[] }): Promise<string> => { evalSink.push(args.cases); return Promise.resolve(`已冻结 ${args.cases.length} 条。`) },
  })
  const author = await newAgent(authorCtx, 'comp-author')
  await say(author, `策略 spec：\n\n${SPEC}\n\n可用工具：${TOOLS_DESC}\n\n`
    + `请设计评测用例，三条关注点每条都要有正例和反例。\n${EVAL_SHAPE}\n用 submit_evals 提交。`)
  const frozen = evalSink.flat()
  if (frozen.length === 0) { console.log('✗ 未出题'); return }
  console.log(`\n出题 agent 冻结 ${frozen.length} 条评测用例。`)

  // ② 开发：允许多次提交，自己决定拆几个。以 concern 为键——同一关注点重复提交＝替换该插件，
  //    不同关注点＝新增。这解决多插件的版本管理：修正一个插件是替换，不是累加。
  const byConcern = new Map<string, string>()
  const sourceList = (): string[] => [...byConcern.values()]
  const devCtx = await bootBase()
  devCtx.tools.register({
    name: 'submit_plugin',
    description: '提交一个插件源码（函数体 return { name, apply(ctx) }）。'
      + '按单一职责拆分：每个插件只负责一个关注点，用多次 submit_plugin 分别提交。'
      + 'pre-execute 拦截调用（放行 next()，拒绝 {kind:"deny",reason}）；'
      + 'post-execute 改写产出（{kind:"accept",content:[{type:"text",text:改写后}]}）。'
      + 'exec.name 工具名，exec.arguments 参数，result.content[0].text 产出文本。纯 JavaScript。',
    parameters: { type: 'object', properties: { source: { type: 'string' }, concern: { type: 'string', description: '本插件负责哪条关注点，填 a / b / c。修正已提交的插件时填同一个 concern（会替换），不要新增。' } }, required: ['source', 'concern'] },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v as string }] },
    execute: (args: { source: string; concern: string }): Promise<string> => {
      const replacing = byConcern.has(args.concern)
      byConcern.set(args.concern, args.source)
      return Promise.resolve(`${replacing ? '已替换' : '已收到'}关注点 ${args.concern} 的插件。当前共 ${byConcern.size} 个（关注点：${[...byConcern.keys()].sort().join(',')}）。`)
    },
  })
  const dev = await newAgent(devCtx, 'comp-dev')
  await say(dev, `请实现满足这份 spec 的运行时插件。三条关注点请按单一职责拆成多个插件，各自用 submit_plugin 提交。\n\n`
    + `spec：\n${SPEC}\n\n可用工具：${TOOLS_DESC}`)
  console.log(`开发 agent 提交了 ${byConcern.size} 个插件（关注点：${[...byConcern.keys()].sort().join(',')}）。`)

  // ③ 组合评测 + 反馈
  let round = 0
  let result = { passed: false, diffs: ['未提交'] as string[] }
  while (round < MAX_ROUNDS && byConcern.size > 0) {
    round++
    result = await judgeCases(sourceList(), frozen, makeTools)
    if (result.passed) { console.log(`\n✓ 第 ${round} 轮：${byConcern.size} 个插件组合评测全部通过（${frozen.length} 条）。`); break }
    console.log(`\n✗ 第 ${round} 轮组合评测未通过（${result.diffs.length} 处）：`)
    for (const d of result.diffs.slice(0, 5)) console.log(`    · ${d}`)
    if (round < MAX_ROUNDS) {
      await say(dev, `组合评测未通过，可观测差异：\n${result.diffs.map(d => `- ${d}`).join('\n')}\n\n`
        + `请修正对应关注点的插件——用 submit_plugin 并填该关注点原来的 concern（会替换旧版本，不要新增）。`)
      console.log(`  （修正后共 ${byConcern.size} 个插件）`)
    }
  }

  // ④ 消融归因（仅在组合通过时）
  const concerns = [...byConcern.keys()].sort()
  if (result.passed && concerns.length > 1) {
    box('消融归因 · 逐个拿掉一个插件，看哪些评测垮掉')
    for (const c of concerns) {
      const subset = concerns.filter(k => k !== c).map(k => byConcern.get(k)!)
      const r = await judgeCases(subset, frozen, makeTools)
      const broke = r.diffs.length
      console.log(`  拿掉关注点 ${c} 的插件：${broke === 0 ? '无评测垮掉（贡献为零或与他者重复）' : `${broke} 条评测垮掉 → 它负责这些保证`}`)
      for (const d of r.diffs.slice(0, 3)) console.log(`      · ${d}`)
    }
    console.log(`\n  结论：每个插件负责的保证由「拿掉它垮掉哪些评测」唯一确定。`)
    console.log(`  若拿掉某插件后垮掉的评测跨越多个关注点，即为职责纠缠（应拆）。`)
  }

  box('总账')
  console.log(`  一个目标 → ${byConcern.size} 个插件（由开发 agent 自主拆分，关注点：${concerns.join(',')}）`)
  console.log(`  组合评测：${result.passed ? '通过' : '未通过'}（${round} 轮，${frozen.length} 条评测）`)
  console.log(`  消融归因：${result.passed && concerns.length > 1 ? '已执行' : '略'}`)
  console.log(`  全部会话已落盘，可复查。`)
}

main().catch((e: unknown) => { console.error('\n运行失败：', e instanceof Error ? e.message : e); process.exitCode = 1 })
