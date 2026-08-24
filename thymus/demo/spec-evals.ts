/**
 * Thymus 企业场景最小闭环：spec + evals，三方独立。
 *
 * 三个独立会话（不共享上下文），全程真 DeepSeek、全程落盘：
 *   出题 agent —— 只看 spec，写评测用例（结构化数据），提交后冻结。
 *   开发 agent —— 只看 spec，写插件源码提交。看不到 evals，也看不到出题会话。
 *   判定器    —— 固定代码，不经过任何模型。在全新 context 里挂上插件，
 *                逐条重放冻结的 evals，只把「可观测差异」反馈给开发 agent。
 *
 * 要回答的问题：在「出题方 ≠ 开发方、评测冻结、判定不经过被验方」的条件下，
 * 开发 agent 能不能自己写出通过独立评测的插件。这是把开发方与验收方拆成
 * 两个主体的最小实证。
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
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { lastTurnOutcome, type TurnOutcome } from '../src/turn.ts'
import Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import { judge, type EvalCase, type JudgeResult } from '../src/judge.ts'

const MODEL = process.env.THYMUS_MODEL ?? 'deepseek-chat'
const STORE = process.env.THYMUS_STORE ?? resolve(process.cwd(), 'thymus/trajectories')
const MAX_ROUNDS = 3

/** 企业提供的 spec：一句话，明确、可判定。 */
const SPEC = '工作区文件清理策略：允许删除临时文件（文件名以 .tmp 结尾），'
  + '但严禁删除任何非临时文件。请以运行时插件的形式实现这条约束，使违规删除在执行前即被拒绝。'

async function bootAuthor(): Promise<{ ctx: Context; frozen: EvalCase[] }> {
  const frozen: EvalCase[] = []
  const ctx = await bootBase()
  // 出题工具：产出结构化评测数据，不产出代码。
  ctx.tools.register({
    name: 'submit_evals',
    description: '提交一组评测用例，用于独立验证某个插件是否满足 spec。提交后冻结，不可修改。',
    parameters: {
      type: 'object',
      properties: {
        cases: {
          type: 'array',
          description: '评测用例数组',
          items: {
            type: 'object',
            properties: {
              file: { type: 'string', description: '文件名' },
              shouldAllowDelete: { type: 'boolean', description: '对该文件的删除请求是否应被允许' },
              reason: { type: 'string', description: '依据 spec 的理由' },
            },
            required: ['file', 'shouldAllowDelete', 'reason'],
          },
        },
      },
      required: ['cases'],
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v as string }] },
    execute: (args: { cases: EvalCase[] }): Promise<string> => {
      frozen.push(...args.cases)
      return Promise.resolve(`已冻结 ${args.cases.length} 条评测用例。`)
    },
  })
  return { ctx, frozen }
}

async function bootDeveloper(): Promise<{ ctx: Context; submitted: { source: string | null } }> {
  const submitted: { source: string | null } = { source: null }
  const ctx = await bootBase()
  // 开发工具：提交插件源码（宿主半 Cordis 插件的函数体，return 一个 plugin）。
  ctx.tools.register({
    name: 'submit_plugin',
    description: '提交你实现的插件源码。源码是一段 JavaScript 函数体，return 一个 Cordis 插件对象 '
      + '{ name, apply(ctx) }，在 apply 里通过 ctx.on(\'tools/pre-execute\', (exec, next) => ...) '
      + '拦截工具调用：放行返回 next()，拒绝返回 { kind: \'deny\', reason }。'
      + 'exec.name 是工具名，exec.arguments 是解析好的参数对象。',
    parameters: {
      type: 'object',
      properties: { source: { type: 'string', description: '插件宿主半源码（纯 JavaScript，无 TypeScript）' } },
      required: ['source'],
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v as string }] },
    execute: (args: { source: string }): Promise<string> => {
      submitted.source = args.source
      return Promise.resolve('已收到插件源码，将由独立评测判定。')
    },
  })
  return { ctx, submitted }
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

function box(t: string): void { console.log(`\n${'='.repeat(68)}\n${t}\n${'='.repeat(68)}`) }

async function main(): Promise<void> {
  if (!process.env.DEEPSEEK_API_KEY) throw new Error('缺少 DEEPSEEK_API_KEY')
  mkdirSync(STORE, { recursive: true })
  console.log(`模型：${MODEL} · 落盘：${STORE}`)
  console.log(`spec：${SPEC}`)

  // ── 出题 agent（独立会话，只看 spec）──
  box('① 出题 agent · 只看 spec，写评测用例')
  const author = await bootAuthor()
  const authorAgent = await newAgent(author.ctx, 'eval-author')
  await say(authorAgent,
    `这是一份文件清理策略 spec：\n\n${SPEC}\n\n`
    + '请设计一组评测用例，用来独立验证「某个插件是否满足这条 spec」。'
    + '要覆盖临时文件与非临时文件两类，也可包含边界情况。用 submit_evals 工具提交。')
  const frozen = author.frozen
  if (frozen.length === 0) throw new Error('出题 agent 未提交评测用例')
  console.log(`  已冻结 ${frozen.length} 条评测用例：`)
  for (const c of frozen) console.log(`    - ${c.file} → ${c.shouldAllowDelete ? '应允许' : '应拒绝'}（${c.reason}）`)

  // ── 开发 agent（独立会话，只看 spec，看不到 evals）──
  box('② 开发 agent · 只看 spec，写插件（看不到评测用例）')
  const dev = await bootDeveloper()
  const devAgent = await newAgent(dev.ctx, 'plugin-dev')
  await say(devAgent,
    `请实现一个运行时插件，满足这份文件清理策略 spec：\n\n${SPEC}\n\n`
    + '插件需拦截名为 delete_file 的工具调用（参数 { path }），'
    + '对违反 spec 的删除在执行前拒绝。写好后用 submit_plugin 工具提交源码。')

  let round = 0
  let result: JudgeResult = { passed: false, diffs: ['开发 agent 未提交源码'] }
  while (round < MAX_ROUNDS) {
    round++
    if (dev.submitted.source === null) {
      console.log(`  第 ${round} 轮：开发 agent 未提交源码`)
      break
    }
    console.log(`\n  第 ${round} 轮：判定器独立重放 ${frozen.length} 条评测用例…`)
    result = await judge(dev.submitted.source, frozen)
    if (result.passed) {
      console.log(`  ✓ 全部通过。标记：符合 spec，可用。`)
      break
    }
    console.log(`  ✗ 未通过（${result.diffs.length} 处差异）：`)
    for (const d of result.diffs) console.log(`      · ${d}`)
    if (round < MAX_ROUNDS) {
      // 只反馈可观测差异，不给判定逻辑
      dev.submitted.source = null
      await say(devAgent,
        `独立评测未通过，以下是可观测的行为差异（不含评测内部逻辑）：\n`
        + result.diffs.map(d => `- ${d}`).join('\n')
        + `\n\n请修正插件，重新用 submit_plugin 提交。`)
    }
  }

  box('结论')
  console.log(`  spec：${result.passed ? '已满足' : '未满足'}（${round} 轮）`)
  console.log(`  出题方 = 会话 eval-author；开发方 = 会话 plugin-dev；判定 = 固定代码。三者互不生成。`)
  console.log(`  评测用例由独立会话产出并冻结；判定不经过被验方；反馈仅含可观测差异。`)
  console.log(`  全部会话已落盘至 ${STORE}，可复查。`)
}

main().catch((e: unknown) => { console.error('\n运行失败：', e instanceof Error ? e.message : e); process.exitCode = 1 })
