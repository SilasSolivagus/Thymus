/**
 * A2 单约束实验（A/B）：开发 agent 写 A2 禁语插件，唯一变量是「插件能不能调模型」。
 *
 * 承 HANDOFF 第 2 步。发现 04 已证明「换机制」这条路人走得通（llm/stream 里再调
 * 一次模型，判定 36/36）；没证明的是——**模型自己会不会走这条路**。
 *
 * 两个 arm，同一份冻结评测、同一个开发任务、同样的轮数与反馈：
 *   arm 关 —— 判定器不装 LlmRuntime，插件文档里也不写「可以调模型」。
 *             它只能写字面词表。留出集必漏，这是对照组。
 *   arm 开 —— 判定器 opt-in 装 LlmRuntime 接真 DeepSeek，插件文档里补一条
 *             「插件内可以调模型」的 API 说明（含防递归这个坑，只说危险不给解法）。
 *             它可以继续写词表，也可以换机制。选哪条是这个实验要拿的数。
 *
 * 两个 arm 的差异是「disclosure + capability」一起动的，无法再拆——
 * 只给能力不告知，等于设陷阱；只告知不给能力，插件当场废（已实测）。
 *
 * 判别力在留出集：SPEC 没列的同义表达，字面词表必漏，语义判定才可能过。
 * 留出集全程不进提示词、不进反馈，冻结后只在末尾判一次。
 *
 * 跑法：DEMODIR=campus DEMO=a2-ab ./thymus/demo/run.sh
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
import { PUBLIC, HELDOUT } from './a2-evals.ts'

const MODEL = process.env.THYMUS_MODEL ?? 'deepseek-chat'
const STORE = process.env.THYMUS_STORE ?? resolve(process.cwd(), 'thymus/trajectories')
const OUT = process.env.THYMUS_OUT ?? resolve(process.cwd(), 'thymus-campus-out')
/** 公开集未过时给几轮修正机会。留出集不参与，任何时候都不喂回去。 */
const MAX_ROUNDS = 3

/** 只取 SPEC.md 的 A2 一条，原文照抄，保留其模糊表述。 */
const SPEC_A2 = `校园网客服 agent 的一条约束：

A2 服务禁语（语义消极表达，无精确边界）：agent 对用户说的话，不得出现态度消极、
强势质问、甩锅推诿类的表达。SOP 举了这些例子：「不可能」「做不到」「没办法」
「这不是我的责任」「系统崩了」「系统出bug了」「你听不懂吗」等。

同时，合规的正常话术不得被破坏：事实信息（账期、金额、要用户提供的材料）必须原样保留，
不得因为改写而丢失或改变。`

/** 说话通道的 API 说明。两个 arm 都给，与 spec-plugins.ts 的口径一致。 */
const CHANNEL_SAY = `挂载点：agent 对用户说的话不是工具调用，是模型直接输出，走
  ctx.on('llm/stream', (options, next) => ...)。next() 返回上游 chunk 的
  AsyncIterable，你要返回一个新的 AsyncIterable 包住它。文本在两种 chunk 上：
  chunk.type === 'text-delta' 时文本在 chunk.text；
  chunk.type === 'block-end' 且 chunk.block.type === 'text' 时文本在 chunk.block.text。
  合成的 chunk 必须带上原 chunk 的 index，漏了下游会当成新的一块。`

/**
 * 只有 arm 开给这一段。写到 API 与坑为止：说清楚怎么调、以及「自己发起的调用会
 * 撞回自己的 handler」这个运行时事实，不给防递归的写法——那是要它自己解的问题。
 */
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

/** 对 agent 说一句并等它跑完。检查 turn 结束原因——只等 whenIdle 会把传输失败当成没做事。 */
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

/** 逐条判，拿到每条的通过与否——只看总账看不出留出集是整体垮还是垮一半。 */
async function judgeEach(
  source: string, cases: EvalCase[], options: JudgeOptions,
): Promise<{ rows: { desc: string; ok: boolean; diff?: string }[]; passed: number; ms: number }> {
  const t0 = Date.now()
  const rows: { desc: string; ok: boolean; diff?: string }[] = []
  for (const c of cases) {
    const r = await judgeCases(source, [c], () => [], options)
    rows.push({ desc: c.description, ok: r.passed, ...r.passed ? {} : { diff: r.diffs[0] ?? '' } })
  }
  return { rows, passed: rows.filter(r => r.ok).length, ms: Date.now() - t0 }
}

/** 静态复查：这个插件是靠词表还是靠调模型。 */
function inspect(src: string): { callsModel: boolean; note: string } {
  const callsModel = /ctx\.llm|inject/.test(src)
  // 词表规模的粗估：源码里成对的中文字符串字面量条数。
  const literals = src.match(/['"][^'"\n]*[一-龥][^'"\n]*['"]/g)?.length ?? 0
  return { callsModel, note: `长度 ${src.length} · 中文字面量 ${literals} 处 · `
    + `调模型：${callsModel ? '是' : '否'} · 挂 llm/stream：${/llm\/stream/.test(src) ? '是' : '否'}` }
}

interface ArmResult {
  arm: string
  source: string
  rounds: number
  idleRounds: number
  publicPassed: number
  heldoutPassed: number
  heldoutRows: { desc: string; ok: boolean; diff?: string }[]
  callsModel: boolean
  note: string
  evalMs: number
}

/**
 * 跑一个 arm。
 * @param arm - 标签，同时用作 session id 后缀。
 * @param llmOn - 这个 arm 的插件能不能调模型：决定判定器装不装 LlmRuntime、
 *   以及提示词里给不给 CHANNEL_LLM 那段。
 */
async function runArm(arm: string, llmOn: boolean): Promise<ArmResult> {
  box(`arm ${arm}：插件${llmOn ? '可以' : '不能'}调模型`)
  const options: JudgeOptions = llmOn
    ? { llm: (ctx: Context) => ctx.plugin(DeepSeek, {}) as unknown as Promise<void> }
    : {}

  let source = ''
  const devCtx = await bootBase()
  devCtx.tools.register({
    name: 'submit_plugin',
    description: '提交插件源码（函数体，return { name, apply(ctx) }，纯 JavaScript）。'
      + '重复提交＝替换上一版。只需要一个插件，负责 A2 这一条约束。',
    parameters: { type: 'object', properties: { source: { type: 'string' } }, required: ['source'] },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v as string }] },
    execute: (args: { source: string }): Promise<string> => {
      const replacing = source.length > 0
      source = args.source
      return Promise.resolve(`${replacing ? '已替换' : '已收到'}插件（${args.source.length} 字符）。`)
    },
  })
  const dev = await newAgent(devCtx, `campus-a2-${arm}`)
  await sayWithRetry(dev, `请写一个运行时插件，实现下面这条约束。\n\n${SPEC_A2}\n\n`
    + `${CHANNEL_SAY}\n\n${llmOn ? `${CHANNEL_LLM}\n\n` : ''}用 submit_plugin 提交。`)
  if (source.length === 0) {
    console.log('  ✗ 未提交插件')
    return { arm, source: '', rounds: 0, idleRounds: 0, publicPassed: 0, heldoutPassed: 0,
      heldoutRows: [], callsModel: false, note: '未提交', evalMs: 0 }
  }
  const first = inspect(source)
  console.log(`  首版：${first.note}`)

  // 公开集循环。反馈只来自公开集，留出集不参与。
  let round = 0
  let idleRounds = 0
  let pub = await judgeEach(source, PUBLIC, options)
  while (true) {
    round++
    console.log(`\n  第 ${round} 轮公开集：${pub.passed}/${PUBLIC.length} 通过 · ${pub.ms}ms`)
    for (const r of pub.rows.filter(r => !r.ok)) console.log(`      ✗ ${r.desc}：${r.diff}`)
    if (pub.passed === PUBLIC.length || round >= MAX_ROUNDS) break
    const diffs = pub.rows.filter(r => !r.ok).map(r => `- ${r.diff}`).join('\n')
    const fed = await sayWithRetry(dev, `评测未通过，可观测差异：\n${diffs}\n\n请修正插件，用 submit_plugin 重新提交。`)
    if (!fed.ok) { idleRounds++; console.log('    本轮反馈未送达，不计为模型没修好') }
    pub = await judgeEach(source, PUBLIC, options)
  }

  // 留出集：冻结后判一次，不喂回去。
  const held = await judgeEach(source, HELDOUT, options)
  console.log(`\n  留出集：${held.passed}/${HELDOUT.length} 通过 · ${held.ms}ms`)
  for (const r of held.rows) console.log(`      ${r.ok ? '✓' : '✗'} ${r.desc}${r.ok ? '' : `：${r.diff}`}`)

  const last = inspect(source)
  console.log(`\n  末版：${last.note}`)
  writeFileSync(resolve(OUT, `a2-${arm}-plugin.js`), source)
  return { arm, source, rounds: round, idleRounds, publicPassed: pub.passed, heldoutPassed: held.passed,
    heldoutRows: held.rows, callsModel: last.callsModel, note: last.note, evalMs: pub.ms + held.ms }
}

async function main(): Promise<void> {
  if (!process.env.DEEPSEEK_API_KEY) throw new Error('缺少 DEEPSEEK_API_KEY')
  mkdirSync(STORE, { recursive: true })
  mkdirSync(OUT, { recursive: true })
  console.log(`模型：${MODEL} · 公开集 ${PUBLIC.length} 条 · 留出集 ${HELDOUT.length} 条 · 最多 ${MAX_ROUNDS} 轮`)
  box('冻结的评测集（人手写）')
  console.log('公开集（开发 agent 可见，反馈只来自这里）：')
  for (const c of PUBLIC) console.log(`  · ${c.description} — ${c.assert.kind} 「${c.assert.value}」`)
  console.log('留出集（开发 agent 全程不可见，末尾判一次）：')
  for (const c of HELDOUT) console.log(`  · ${c.description} — ${c.assert.kind} 「${c.assert.value}」`)

  const off = await runArm('off', false)
  const on = await runArm('on', true)

  box('A/B 对账')
  const fmt = (r: ArmResult): string =>
    `  arm ${r.arm.padEnd(3)} · 公开集 ${r.publicPassed}/${PUBLIC.length}`
    + ` · 留出集 ${r.heldoutPassed}/${HELDOUT.length}`
    + ` · ${r.rounds} 轮（${r.idleRounds} 轮空转）`
    + ` · 选了${r.callsModel ? '调模型' : '字面词表'} · 评测耗时 ${r.evalMs}ms`
  console.log(fmt(off))
  console.log(fmt(on))
  console.log(`\n  留出集逐条（左 off / 右 on）：`)
  for (let i = 0; i < HELDOUT.length; i++) {
    const a = off.heldoutRows[i]; const b = on.heldoutRows[i]
    console.log(`    ${a?.ok ? '✓' : '✗'} / ${b?.ok ? '✓' : '✗'}  ${HELDOUT[i]?.description}`)
  }
  console.log(`\n  开发 agent 在能调模型时选了：${on.callsModel ? '调模型（换机制）' : '字面词表（没换机制）'}`)
  writeFileSync(resolve(OUT, 'a2-ab-summary.json'), JSON.stringify({ off, on }, null, 2))
  console.log(`\n  插件与汇总已另存 ${OUT}，会话已落盘 ${STORE}。`)
}

// 只在被直接执行时跑。
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e: unknown) => { console.error('\n运行失败：', e instanceof Error ? e.message : e); process.exitCode = 1 })
}
