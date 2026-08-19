/**
 * 用三档递增的 spec 试着弄坏 spec+evals 模式。
 *
 * 每档都是同一套三方独立流程（出题 agent / 开发 agent / 固定判定器），
 * 但要求评测框架表达的东西越来越复杂：
 *   第一档 无状态：单次调用看参数
 *   第二档 有状态：决策依赖历史，评测需给调用序列
 *   第三档 看产出：产出须满足谓词，评测需断言输出内容
 *
 * 问题：同一套评测框架 + 同一套三方流程，能不能覆盖这三档？
 * 全程真 DeepSeek、全程落盘。
 */
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import * as DeepSeek from '@deepseek-ai/dsh-llm-deepseek'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import { judgeCases, type EvalCase, type JudgeResult } from '../src/eval-framework.ts'

const MODEL = process.env.THYMUS_MODEL ?? 'deepseek-chat'
const STORE = process.env.THYMUS_STORE ?? resolve(process.cwd(), 'thymus/trajectories')
const MAX_ROUNDS = 3

interface Spec {
  id: string
  tier: string
  spec: string
  toolsForDev: string        // 给开发 agent 看的工具签名说明
  makeTools: () => ToolDefinition[]
}

const T = (name: string, ret: string): ToolDefinition => ({
  name, description: name,
  parameters: { type: 'object', properties: {} },
  output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v as string }] },
  execute: (): Promise<string> => Promise.resolve(ret),
})

const SPECS: Spec[] = [
  {
    id: 'tier1-stateless', tier: '第一档 无状态',
    spec: '文件清理策略：允许删除临时文件（文件名以 .tmp 结尾），但严禁删除任何非临时文件。违规删除须在执行前被拒绝。',
    toolsForDev: 'delete_file(path: string) —— 删除一个文件。',
    makeTools: () => [{
      name: 'delete_file', description: '删除文件',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v as string }] },
      execute: (a: { path: string }): Promise<string> => Promise.resolve(`deleted:${a.path}`),
    }],
  },
  {
    id: 'tier2-stateful', tier: '第二档 有状态',
    spec: '危险操作保护：在本会话内执行 dangerous_action 之前，必须先调用 confirm 完成确认；'
      + '任何未经确认的 dangerous_action 必须被拒绝。已确认后，dangerous_action 应被放行。',
    toolsForDev: 'confirm() —— 记录一次确认；dangerous_action() —— 执行危险操作。两者同属当前会话。',
    makeTools: () => [T('confirm', 'confirmed'), T('dangerous_action', 'executed')],
  },
  {
    id: 'tier3-output', tier: '第三档 看产出',
    spec: '数据脱敏策略：任何工具返回的文本中，若出现连续 16 位数字（视为信用卡号），'
      + '必须在返回给模型之前被脱敏——只保留后 4 位，前面用星号替换。不得原样返回完整卡号。',
    toolsForDev: 'fetch_record(id: string) —— 返回一段可能含 16 位卡号的客户记录文本。',
    makeTools: () => [{
      name: 'fetch_record', description: '取客户记录',
      parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v as string }] },
      execute: (): Promise<string> => Promise.resolve('客户卡号 4111111111111111 余额 100'),
    }],
  },
]

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

async function say(agent: Agent, text: string): Promise<void> {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  await agent.whenIdle()
  await new Promise(r => setTimeout(r, 400))
}

const EVAL_SHAPE = '每条用例形如 { "description": 简述, "steps": [{"tool": 工具名, "args": {参数}}...], '
  + '"assert": {"kind": 断言类型, "value": 可选值} }。'
  + 'steps 是按顺序执行的一段调用序列（可多步，用来构造前置状态）；assert 判定最后一步的可观测结果。'
  + '断言类型 kind 取值：allowed（放行）、denied（拒绝）、output-includes（产出含 value）、output-excludes（产出不含 value）。'

async function submitEvalsTool(sink: EvalCase[][]): Promise<ToolDefinition> {
  return {
    name: 'submit_evals',
    description: `提交评测用例数组，提交后冻结。${EVAL_SHAPE}`,
    parameters: {
      type: 'object',
      properties: {
        cases: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              description: { type: 'string' },
              steps: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: { tool: { type: 'string' }, args: { type: 'object' } },
                  required: ['tool', 'args'],
                },
              },
              assert: {
                type: 'object',
                properties: {
                  kind: { type: 'string', enum: ['allowed', 'denied', 'output-includes', 'output-excludes'] },
                  value: { type: 'string' },
                },
                required: ['kind'],
              },
            },
            required: ['description', 'steps', 'assert'],
          },
        },
      },
      required: ['cases'],
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v as string }] },
    execute: (args: { cases: EvalCase[] }): Promise<string> => {
      sink.push(args.cases)
      return Promise.resolve(`已冻结 ${args.cases.length} 条评测用例。`)
    },
  }
}

function submitPluginTool(sink: { source: string | null }): ToolDefinition {
  return {
    name: 'submit_plugin',
    description: '提交插件源码。源码是一段 JavaScript 函数体，return 一个 Cordis 插件 { name, apply(ctx) }。'
      + '在 apply 里用 ctx.on(\'tools/pre-execute\',(exec,next)=>...) 拦截调用（放行 next()，拒绝返回 {kind:\'deny\',reason}），'
      + '或用 ctx.on(\'tools/post-execute\',(exec,result,next)=>...) 改写产出（返回 {kind:\'accept\',content:[{type:\'text\',text:改写后}]}）。'
      + 'exec.name 是工具名，exec.arguments 是参数对象，result.content[0].text 是产出文本。纯 JavaScript，无 TypeScript。',
    parameters: { type: 'object', properties: { source: { type: 'string' } }, required: ['source'] },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v as string }] },
    execute: (args: { source: string }): Promise<string> => {
      sink.source = args.source
      return Promise.resolve('已收到插件源码，将由独立评测判定。')
    },
  }
}

function box(t: string): void { console.log(`\n${'='.repeat(70)}\n${t}\n${'='.repeat(70)}`) }

async function runSpec(s: Spec): Promise<{ passed: boolean; rounds: number; evalCount: number }> {
  box(`${s.tier} · ${s.id}`)
  console.log(`  spec：${s.spec}`)

  // ① 出题
  const evalSink: EvalCase[][] = []
  const authorCtx = await bootBase()
  authorCtx.tools.register(await submitEvalsTool(evalSink))
  const author = await newAgent(authorCtx, `${s.id}-author`)
  await say(author,
    `这是一份策略 spec：\n\n${s.spec}\n\n可用工具：${s.toolsForDev}\n\n`
    + `请设计一组评测用例，独立验证「某插件是否满足这条 spec」，覆盖正例与反例（含边界）。\n${EVAL_SHAPE}\n用 submit_evals 提交。`)
  const frozen = evalSink.flat()
  if (frozen.length === 0) { console.log('  ✗ 出题 agent 未提交评测'); return { passed: false, rounds: 0, evalCount: 0 } }
  console.log(`  出题 agent 冻结 ${frozen.length} 条评测用例，例如：`)
  for (const c of frozen.slice(0, 3)) {
    console.log(`    · ${c.description} → steps=${c.steps.map(x => x.tool).join('→')} assert=${c.assert.kind}${c.assert.value ? `(${c.assert.value})` : ''}`)
  }

  // ② 开发
  const devSink = { source: null as string | null }
  const devCtx = await bootBase()
  devCtx.tools.register(submitPluginTool(devSink))
  const dev = await newAgent(devCtx, `${s.id}-dev`)
  await say(dev,
    `请实现一个运行时插件，满足这份策略 spec：\n\n${s.spec}\n\n可用工具：${s.toolsForDev}\n\n写好后用 submit_plugin 提交源码。`)

  // ③ 判定 + 反馈循环
  let round = 0
  let result: JudgeResult = { passed: false, diffs: ['未提交源码'] }
  while (round < MAX_ROUNDS) {
    round++
    if (devSink.source === null) break
    result = await judgeCases(devSink.source, frozen, s.makeTools)
    if (result.passed) { console.log(`  ✓ 第 ${round} 轮：独立评测全部通过（${frozen.length} 条）。标记：符合 spec。`); break }
    console.log(`  ✗ 第 ${round} 轮未通过（${result.diffs.length} 处差异）：`)
    for (const d of result.diffs.slice(0, 4)) console.log(`      · ${d}`)
    if (round < MAX_ROUNDS) {
      devSink.source = null
      await say(dev, `独立评测未通过，可观测差异如下（不含评测内部逻辑）：\n`
        + result.diffs.map(d => `- ${d}`).join('\n') + `\n\n请修正插件，重新用 submit_plugin 提交。`)
    }
  }
  return { passed: result.passed, rounds: round, evalCount: frozen.length }
}

async function main(): Promise<void> {
  if (!process.env.DEEPSEEK_API_KEY) throw new Error('缺少 DEEPSEEK_API_KEY')
  mkdirSync(STORE, { recursive: true })
  console.log(`模型：${MODEL} · 落盘：${STORE}`)

  const results: { tier: string; r: { passed: boolean; rounds: number; evalCount: number } }[] = []
  for (const s of SPECS) results.push({ tier: s.tier, r: await runSpec(s) })

  box('总账：同一评测框架 + 同一三方流程，覆盖三档')
  for (const { tier, r } of results) {
    console.log(`  ${tier.padEnd(12)} ${r.passed ? '✓ 通过' : '✗ 未通过'}  评测 ${r.evalCount} 条 · ${r.rounds} 轮`)
  }
}

main().catch((e: unknown) => { console.error('\n运行失败：', e instanceof Error ? e.message : e); process.exitCode = 1 })
