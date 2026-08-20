/**
 * 评估：把 J-Space Cognition Suite 当开发 agent 的前置提示词，写插件的质量会不会变好。
 *
 * HANDOFF 挂了很久的待办。它自报 2.53× 提速、2.21× token 下降，数字未经我们验证，
 * 所以按我们自己的方法做一次实测再决定引不引进。
 *
 * 基准沿用 A2 写插件任务——我们对它的基线分布已经有 n=4（发现 06 的 v1 与 r1/r2/r3 的 v1），
 * 冻结评测不动，唯一变量是提示词前面加不加 J-Space 的 SKILL.md。
 *
 * 只测首版，不做反馈：要测的是「写码正确率」，反馈是另一个变量，混进来就说不清了。
 *
 * 几处必须写明的偏差：
 *   1. J-Space 的设计是 SKILL.md 入口 + 9 个模块按需加载。我们的 dev agent 没有读文件的
 *      能力，所以只喂入口那 16KB。**这是它能力的下限，不是全貌。**
 *   2. 它面向有 skill 机制的 agent；这里当成普通前置提示词用，属于改造使用。
 *   3. 它文中引的 `Gurnee et al., Anthropic, 2026` 我们没有核实，不作为评估依据——
 *      评估只看它在我们基准上的实测表现。
 *
 * 跑法：JSPACE_SKILL=<SKILL.md 路径> DEMODIR=campus DEMO=a2-jspace ./thymus/demo/run.sh
 */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import * as DeepSeek from '@deepseek-ai/dsh-llm-deepseek'
import SessionStore, { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import { judgeCases, type EvalCase, type JudgeOptions } from '../src/eval-framework.ts'
import { lastTurnOutcome, type TurnOutcome } from '../src/turn.ts'
import { PUBLIC, HELDOUT, HELDOUT2 } from './a2-evals.ts'

const MODEL = process.env.THYMUS_MODEL ?? 'deepseek-chat'
const STORE = process.env.THYMUS_STORE ?? resolve(process.cwd(), 'thymus/trajectories')
const OUT = process.env.THYMUS_OUT ?? resolve(process.cwd(), 'thymus-campus-out')
const REPEATS = Number(process.env.THYMUS_REPEATS ?? '3')
const SKILL_PATH = process.env.JSPACE_SKILL

const SPEC_A2 = `校园网客服 agent 的一条约束：

A2 服务禁语（语义消极表达，无精确边界）：agent 对用户说的话，不得出现态度消极、
强势质问、甩锅推诿类的表达。SOP 举了这些例子：「不可能」「做不到」「没办法」
「这不是我的责任」「系统崩了」「系统出bug了」「你听不懂吗」等。

同时，合规的正常话术不得被破坏：事实信息（账期、金额、要用户提供的材料）必须原样保留，
不得因为改写而丢失或改变。`

const CHANNEL_SAY = `挂载点：agent 对用户说的话不是工具调用，是模型直接输出，走
  ctx.on('llm/stream', (options, next) => ...)。next() 返回上游 chunk 的
  AsyncIterable，你要返回一个新的 AsyncIterable 包住它。文本在两种 chunk 上：
  chunk.type === 'text-delta' 时文本在 chunk.text；
  chunk.type === 'block-end' 且 chunk.block.type === 'text' 时文本在 chunk.block.text。
  合成的 chunk 必须带上原 chunk 的 index，漏了下游会当成新的一块。`

const CHANNEL_LLM = `另外，插件内部可以自己调模型。在返回的对象上写 inject: ['llm']，
  apply(ctx) 里就能用 ctx.llm.stream(options)，options 形如：
  { provider: 'deepseek-official', model: '${MODEL}', reasoningEffort: 'off',
    system: '系统提示词', messages: [{ role: 'user',
    content: [{ type: 'text', text: '用户内容' }], source: { kind: 'user' } }] }
  返回 chunk 的 AsyncIterable，形状与 llm/stream 上游相同（文本同样在 text-delta
  的 chunk.text 和 block-end 的 chunk.block.text 上）。
  ⚠ 你自己发起的这次调用同样会走 llm/stream，撞回你自己的 handler。不自己防住会无限递归。`

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

async function say(agent: Agent, text: string): Promise<TurnOutcome> {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  await agent.whenIdle()
  await new Promise(r => setTimeout(r, 400))
  const outcome = lastTurnOutcome([...agent.session.events] as SessionEvent[])
  if (!outcome.ok) console.log(`  ⚠ 本轮未正常结束：${outcome.reason}`)
  return outcome
}

interface Usage { input: number; output: number; reasoning: number; cacheRead: number }
const ZERO: Usage = { input: 0, output: 0, reasoning: 0, cacheRead: 0 }

/** 从这一轮新增的 session 事件里累加 token 用量。 */
function usageSince(agent: Agent, from: number): Usage {
  const acc = { ...ZERO }
  for (const ev of [...agent.session.events].slice(from)) {
    const found = JSON.stringify(ev).match(/"usage":\{[^}]*\}/g) ?? []
    for (const raw of found) {
      const u = JSON.parse(raw.slice(8)) as Record<string, number>
      acc.input += u.inputTokens ?? 0
      acc.output += u.outputTokens ?? 0
      acc.reasoning += u.reasoningTokens ?? 0
      acc.cacheRead += u.cacheReadTokens ?? 0
    }
  }
  return acc
}

function box(t: string): void { console.log(`\n${'='.repeat(76)}\n${t}\n${'='.repeat(76)}`) }

interface Row { desc: string; ok: boolean; ms: number }
async function judgeEach(source: string, cases: EvalCase[], options: JudgeOptions): Promise<Row[]> {
  const rows: Row[] = []
  for (const c of cases) {
    const t0 = Date.now()
    const r = await judgeCases(source, [c], () => [], options)
    rows.push({ desc: c.description, ok: r.passed, ms: Date.now() - t0 })
  }
  return rows
}
const passed = (rows: Row[]): number => rows.filter(r => r.ok).length
const NO_CALL_MS = 300
const noCall = (rows: Row[]): number => rows.filter(r => r.ms < NO_CALL_MS).length

interface Result {
  arm: string; tag: string; len: number; callsModel: boolean; devMs: number; usage: Usage
  pub: number; held: number; held2: number; held2NoCall: number; submitted: boolean
}

/**
 * 跑一次首版。
 * @param arm - 'base' 或 'jspace'。
 * @param preface - 加在任务提示词前面的内容（J-Space 的 SKILL.md 全文，或空）。
 */
async function runOnce(arm: string, tag: string, preface: string, options: JudgeOptions): Promise<Result> {
  let source = ''
  const ctx = await bootBase()
  ctx.tools.register({
    name: 'submit_plugin',
    description: '提交插件源码（函数体，return { name, apply(ctx) }，纯 JavaScript）。重复提交＝替换上一版。',
    parameters: { type: 'object', properties: { source: { type: 'string' } }, required: ['source'] },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v as string }] },
    execute: (args: { source: string }): Promise<string> => {
      source = args.source
      return Promise.resolve(`已收到插件（${args.source.length} 字符）。`)
    },
  })
  const dev = await newAgent(ctx, `campus-a2-${arm}-${tag}`)
  const task = `请写一个运行时插件，实现下面这条约束。\n\n${SPEC_A2}\n\n`
    + `${CHANNEL_SAY}\n\n${CHANNEL_LLM}\n\n用 submit_plugin 提交。`
  const before = agentEventCount(dev)
  const t0 = Date.now()
  await say(dev, preface.length > 0 ? `${preface}\n\n---\n\n${task}` : task)
  const devMs = Date.now() - t0
  const usage = usageSince(dev, before)

  if (source.length === 0) {
    console.log(`  [${arm}/${tag}] ✗ 未提交插件 · ${devMs}ms`)
    return { arm, tag, len: 0, callsModel: false, devMs, usage,
      pub: 0, held: 0, held2: 0, held2NoCall: 0, submitted: false }
  }
  const pub = await judgeEach(source, PUBLIC, options)
  const held = await judgeEach(source, HELDOUT, options)
  const held2 = await judgeEach(source, HELDOUT2, options)
  writeFileSync(resolve(OUT, `a2-jspace-${arm}-${tag}.js`), source)
  const r: Result = {
    arm, tag, len: source.length, callsModel: /ctx\.llm/.test(source), devMs, usage,
    pub: passed(pub), held: passed(held), held2: passed(held2), held2NoCall: noCall(held2), submitted: true,
  }
  console.log(`  [${arm}/${tag}] 公开集 ${r.pub}/${PUBLIC.length} · 留出集 ${r.held}/${HELDOUT.length}`
    + ` · 留出集2 ${r.held2}/${HELDOUT2.length}（未问模型 ${r.held2NoCall}）`
    + ` · ${r.len} 字符 · 调模型${r.callsModel ? '是' : '否'}`)
  console.log(`         dev 轮 ${devMs}ms · 输出 ${usage.output} tok · 思考 ${usage.reasoning} tok`
    + ` · 输入 ${usage.input} · 缓存读 ${usage.cacheRead}`)
  return r
}

function agentEventCount(agent: Agent): number { return [...agent.session.events].length }

async function main(): Promise<void> {
  if (!process.env.DEEPSEEK_API_KEY) throw new Error('缺少 DEEPSEEK_API_KEY')
  if (SKILL_PATH === undefined) throw new Error('缺少 JSPACE_SKILL（指向 J-Space 的 SKILL.md）')
  const skill = readFileSync(SKILL_PATH, 'utf8')
  mkdirSync(STORE, { recursive: true }); mkdirSync(OUT, { recursive: true })
  const options: JudgeOptions = { llm: (ctx: Context) => ctx.plugin(DeepSeek, {}) as unknown as Promise<void> }
  console.log(`模型：${MODEL} · 每臂 ${REPEATS} 次 · J-Space SKILL.md ${skill.length} 字符`)
  console.log('只测首版，不做反馈。喂的只有入口文件，9 个模块按需加载那部分没有实现。')

  const results: Result[] = []
  box('基线：不加 J-Space')
  for (let i = 1; i <= REPEATS; i++) results.push(await runOnce('base', `r${i}`, '', options))
  box('实验：SKILL.md 全文作为前置提示词')
  for (let i = 1; i <= REPEATS; i++) results.push(await runOnce('jspace', `r${i}`, skill, options))

  box('对账')
  const arms = ['base', 'jspace'] as const
  const avg = (xs: number[]): number => xs.length === 0 ? 0 : Math.round(xs.reduce((a, b) => a + b, 0) / xs.length)
  console.log('  臂      提交 公开集 留出集 留出集2 未问模型 调模型 dev耗时 输出tok 思考tok 插件字符')
  for (const arm of arms) {
    const rs = results.filter(r => r.arm === arm)
    const ok = rs.filter(r => r.submitted)
    console.log(`  ${arm.padEnd(7)} ${ok.length}/${rs.length}`
      + `  ${avg(ok.map(r => r.pub))}/${PUBLIC.length}`
      + `    ${avg(ok.map(r => r.held))}/${HELDOUT.length}`
      + `    ${avg(ok.map(r => r.held2))}/${HELDOUT2.length}`
      + `     ${avg(ok.map(r => r.held2NoCall))}`
      + `       ${ok.filter(r => r.callsModel).length}/${ok.length}`
      + `    ${avg(ok.map(r => r.devMs))}ms`
      + `  ${avg(ok.map(r => r.usage.output))}`
      + `   ${avg(ok.map(r => r.usage.reasoning))}`
      + `   ${avg(ok.map(r => r.len))}`)
  }
  console.log('\n  逐次明细：')
  for (const r of results) {
    console.log(`    ${r.arm}/${r.tag} 公开${r.pub} 留出${r.held} 留出2 ${r.held2}`
      + ` 未问${r.held2NoCall} ${r.devMs}ms 输出${r.usage.output}tok 思考${r.usage.reasoning}tok`)
  }
  writeFileSync(resolve(OUT, 'a2-jspace-summary.json'), JSON.stringify(results, null, 2))
  console.log(`\n  插件与汇总已另存 ${OUT}。`)
}

// 只在被直接执行时跑。
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e: unknown) => { console.error('\n运行失败：', e instanceof Error ? e.message : e); process.exitCode = 1 })
}
