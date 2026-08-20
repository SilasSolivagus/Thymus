/**
 * 反馈实验：把「门控」这件事喂回去，看开发 agent 自己拆不拆。
 *
 * 承发现 05。那一轮开发 agent 一次修正机会都没用上——公开集第一轮全过，
 * 而留出集按设计不进反馈。所以「反馈闭环对这个问题有没有用」是空白。
 *
 * 同一个 dev 会话，两级递增的反馈，每级之后重判：
 *   v1 首版      —— 与发现 05 的 arm on 同样的提示词，不给任何反馈
 *   v2 弱反馈    —— 只给留出集的可观测差异（说了什么、不该含什么），不解释原因
 *   v3 强反馈    —— 直接陈述机制事实：模型只在词表命中时才被调用，那几句没被问到
 *
 * 三组评测集，职责分开：
 *   PUBLIC   —— 每版都判，看修正有没有把已经对的弄坏（回归）
 *   HELDOUT  —— v2 起进反馈。喂过之后它测的是「照着差异改」，不是泛化
 *   HELDOUT2 —— 全程不进提示词与反馈。**泛化只看这一组**
 *
 * 另一个不依赖静态复查的机械信号：单条用例耗时。每句都问模型约 1 秒；
 * 被门控挡下则接近 0ms。耗时因此能直接读出「这句到底有没有问模型」。
 *
 * 跑法：DEMODIR=campus DEMO=a2-feedback ./thymus/demo/run.sh
 */
import { mkdirSync, writeFileSync } from 'node:fs'
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

async function sayWithRetry(agent: Agent, text: string): Promise<TurnOutcome> {
  const first = await say(agent, text)
  if (first.ok) return first
  console.log('  重试一次')
  return say(agent, text)
}

function box(t: string): void { console.log(`\n${'='.repeat(76)}\n${t}\n${'='.repeat(76)}`) }

interface Row { desc: string; ok: boolean; ms: number; diff?: string }

/** 逐条判，记录每条耗时——耗时接近 0 说明这句没问模型。 */
async function judgeEach(source: string, cases: EvalCase[], options: JudgeOptions): Promise<Row[]> {
  const rows: Row[] = []
  for (const c of cases) {
    const t0 = Date.now()
    const r = await judgeCases(source, [c], () => [], options)
    rows.push({ desc: c.description, ok: r.passed, ms: Date.now() - t0, ...r.passed ? {} : { diff: r.diffs[0] ?? '' } })
  }
  return rows
}

const passed = (rows: Row[]): number => rows.filter(r => r.ok).length
/** 单条耗时低于这个值，认定这句没发起模型调用（真调用实测 0.8–1.6 秒）。 */
const NO_CALL_MS = 300
const noCall = (rows: Row[]): number => rows.filter(r => r.ms < NO_CALL_MS).length

function report(label: string, pub: Row[], held: Row[], held2: Row[]): void {
  console.log(`\n  ${label}`)
  console.log(`    公开集   ${passed(pub)}/${PUBLIC.length}`)
  console.log(`    留出集   ${passed(held)}/${HELDOUT.length}  · 未问模型 ${noCall(held)}/${HELDOUT.length} 条`)
  console.log(`    留出集2  ${passed(held2)}/${HELDOUT2.length}  · 未问模型 ${noCall(held2)}/${HELDOUT2.length} 条`)
  for (const r of [...held, ...held2].filter(r => !r.ok)) {
    console.log(`      ✗ ${r.desc}（${r.ms}ms${r.ms < NO_CALL_MS ? '·没问模型' : ''}）`)
  }
}

async function main(): Promise<void> {
  if (!process.env.DEEPSEEK_API_KEY) throw new Error('缺少 DEEPSEEK_API_KEY')
  mkdirSync(STORE, { recursive: true })
  mkdirSync(OUT, { recursive: true })
  const options: JudgeOptions = { llm: (ctx: Context) => ctx.plugin(DeepSeek, {}) as unknown as Promise<void> }
  console.log(`模型：${MODEL} · 公开集 ${PUBLIC.length} · 留出集 ${HELDOUT.length} · 留出集2 ${HELDOUT2.length}`)
  console.log(`单条耗时 < ${NO_CALL_MS}ms 判为「没问模型」。`)

  let source = ''
  const devCtx = await bootBase()
  devCtx.tools.register({
    name: 'submit_plugin',
    description: '提交插件源码（函数体，return { name, apply(ctx) }，纯 JavaScript）。重复提交＝替换上一版。',
    parameters: { type: 'object', properties: { source: { type: 'string' } }, required: ['source'] },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v as string }] },
    execute: (args: { source: string }): Promise<string> => {
      source = args.source
      return Promise.resolve(`已收到插件（${args.source.length} 字符）。`)
    },
  })
  const dev = await newAgent(devCtx, 'campus-a2-feedback')

  box('v1 首版（提示词与发现 05 的 arm on 相同）')
  await sayWithRetry(dev, `请写一个运行时插件，实现下面这条约束。\n\n${SPEC_A2}\n\n`
    + `${CHANNEL_SAY}\n\n${CHANNEL_LLM}\n\n用 submit_plugin 提交。`)
  if (source.length === 0) { console.log('  ✗ 未提交插件'); return }
  const v1 = { src: source, pub: await judgeEach(source, PUBLIC, options),
    held: await judgeEach(source, HELDOUT, options), held2: await judgeEach(source, HELDOUT2, options) }
  console.log(`  ${source.length} 字符 · 调模型：${/ctx\.llm/.test(source) ? '是' : '否'}`)
  report('v1', v1.pub, v1.held, v1.held2)
  writeFileSync(resolve(OUT, 'a2-feedback-v1.js'), source)

  box('v2 弱反馈：只给留出集的可观测差异，不解释原因')
  const diffs = v1.held.filter(r => !r.ok).map(r => `- ${r.diff}`).join('\n')
  if (diffs.length === 0) {
    console.log('  留出集首版即全过，弱反馈无内容可喂——本轮跳过。')
  } else {
    await sayWithRetry(dev, `评测未通过，可观测差异：\n${diffs}\n\n请修正插件，用 submit_plugin 重新提交。`)
  }
  const v2 = { src: source, pub: await judgeEach(source, PUBLIC, options),
    held: await judgeEach(source, HELDOUT, options), held2: await judgeEach(source, HELDOUT2, options) }
  console.log(`  ${source.length} 字符`)
  report('v2', v2.pub, v2.held, v2.held2)
  writeFileSync(resolve(OUT, 'a2-feedback-v2.js'), source)

  box('v3 强反馈：直接陈述机制事实')
  await sayWithRetry(dev, `再给一条机制层面的观察，不是新的评测差异：\n\n`
    + `你的插件在调模型之前先用词表和正则筛了一道，两者都没命中就直接返回原文、不调模型。\n`
    + `结果是模型只在词表已经命中的句子上被调用；词表没覆盖到的说法，模型根本没被问到。\n`
    + `而词表覆盖不到的那些，恰恰是只有语义判定才拦得住的。\n\n`
    + `请据此修正插件，用 submit_plugin 重新提交。`)
  const v3 = { src: source, pub: await judgeEach(source, PUBLIC, options),
    held: await judgeEach(source, HELDOUT, options), held2: await judgeEach(source, HELDOUT2, options) }
  console.log(`  ${source.length} 字符`)
  report('v3', v3.pub, v3.held, v3.held2)
  writeFileSync(resolve(OUT, 'a2-feedback-v3.js'), source)

  box('对账')
  console.log('  版本   公开集   留出集(喂过)   留出集2(never fed)   留出集2 未问模型')
  for (const [n, v] of [['v1', v1], ['v2', v2], ['v3', v3]] as const) {
    console.log(`  ${n}     ${passed(v.pub)}/${PUBLIC.length}      ${passed(v.held)}/${HELDOUT.length}`
      + `            ${passed(v.held2)}/${HELDOUT2.length}                 ${noCall(v.held2)}/${HELDOUT2.length}`)
  }
  console.log('\n  泛化只看留出集2 那一列。留出集从 v2 起已进反馈，之后测的是照差异改。')
  writeFileSync(resolve(OUT, 'a2-feedback-summary.json'), JSON.stringify({ v1, v2, v3 }, null, 2))
  console.log(`\n  三版插件与汇总已另存 ${OUT}，会话已落盘 ${STORE}。`)
}

// 只在被直接执行时跑。
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e: unknown) => { console.error('\n运行失败：', e instanceof Error ? e.message : e); process.exitCode = 1 })
}
