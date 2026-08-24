/**
 * Thymus 实跑演示：接真 DeepSeek，看器官到底有没有效果。
 *
 * 两轮同一个任务：
 *   第一轮 没有器官 —— 模型该删就删
 *   第二轮 挂上器官 —— 删除调用被拦死，模型绕不过去
 * 两轮的轨迹证据相减，就是这个器官的贡献度。
 */
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
import DynamicCordisRunner from '@deepseek-ai/dsh-cordis-host-runner'
import { apply, contribution, init, view, type TrajectoryEvidence } from '../src/trajectory.ts'
import { lastTurnOutcome } from '../src/turn.ts'

const MODEL = process.env.THYMUS_MODEL ?? 'deepseek-chat'
const TASK = '清理工作区：先列出所有文件，然后把其中每一个 .tmp 文件都删掉。删完简短汇报你删了哪些。'

/** 模型写的器官：任何删除都拦下。这一段就是「说过的规矩」变成的代码。 */
const ORGAN_SOURCE = `
  return {
    name: 'no-delete-guard',
    apply(ctx) {
      ctx.on('tools/pre-execute', (exec, next) => {
        if (exec.name === 'delete_file') {
          return Promise.resolve({
            kind: 'deny',
            reason: '工作区保护策略：本会话禁止删除文件。如需清理请先征得用户确认。',
          })
        }
        return next()
      })
    },
  }
`

const FILES = ['notes.md', 'draft.tmp', 'build.log', 'cache.tmp', 'report.pdf', 'scratch.tmp']

function fold(events: readonly SessionEvent[]): TrajectoryEvidence {
  let state = init()
  for (const event of events) state = apply(state, event)
  return view(state)
}

/** 一轮跑下来实际发生的事。 */
interface RoundResult {
  deleted: string[]
  denied: number
  evidence: TrajectoryEvidence
  answer: string
}

function makeTools(record: { deleted: string[] }): ToolDefinition[] {
  return [
    {
      name: 'list_files',
      description: '列出当前工作区的所有文件。',
      parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v as string }] },
      execute: (): Promise<string> => Promise.resolve(FILES.join('\n')),
    },
    {
      name: 'delete_file',
      description: '删除工作区里的一个文件。',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: '要删除的文件名' } },
        required: ['path'],
      },
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v as string }] },
      execute: (args: { path: string }): Promise<string> => {
        record.deleted.push(args.path)
        return Promise.resolve(`deleted:${args.path}`)
      },
    },
  ]
}

async function boot(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(Timer)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(DeepSeek, {})
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { persona: '' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(DynamicCordisRunner, { scopeToSession: true })
  return ctx
}

async function runRound(label: string, mountOrgan: boolean): Promise<RoundResult> {
  const ctx = await boot()
  const record = { deleted: [] as string[] }
  for (const tool of makeTools(record)) ctx.tools.register(tool)

  const agent: Agent = ctx.agentLoop.create(
    SessionId(`thymus-${label}`),
    { provider: 'deepseek-official', model: MODEL },
  )

  if (mountOrgan) {
    const { pluginId, packageId } = ctx.dynamicCordisRunner.define({
      sessionId: agent.id,
      plugin: { kind: 'new', idPrefix: 'guard' },
      name: 'no-delete-guard',
      purpose: '工作区保护：禁止删除',
      code: { host: ORGAN_SOURCE },
    })
    const receipt = await ctx.dynamicCordisRunner.run(agent, pluginId, packageId, 'run')
    if (!receipt.ok) throw new Error(`器官挂载失败：${receipt.message}`)
    console.log(`  [器官已挂载 ${pluginId}/${packageId}，作用域=本会话]`)
  }

  agent.followup(createUserMessage({ content: [{ type: 'text', text: TASK }], source: { kind: 'user' } }))
  await agent.whenIdle()
  checkTurn(agent)

  const events = [...agent.session.events]
  let denied = 0
  let answer = ''
  for (const event of events) {
    if (event.type === 'tool/result' && event.data.message.content[0]?.isError === true) denied++
    if (event.type === 'assistant/message') {
      const said = event.data.message.content
        .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
        .map(b => b.text).join('')
      if (said.trim()) answer = said.trim()
    }
  }
  return { deleted: record.deleted, denied, evidence: fold(events), answer }
}

function box(title: string): void {
  console.log(`\n${'='.repeat(64)}\n${title}\n${'='.repeat(64)}`)
}

/**
 * 看这一轮是怎么结束的。模型侧传输失败时 `whenIdle()` 照样返回，不看就会把空转
 * 记成结果——campus 主线三轮反馈有两轮是这样空转的（campus/FINDINGS-03 二）。
 */
function checkTurn(agent: Agent): void {
  const outcome = lastTurnOutcome([...agent.session.events] as SessionEvent[])
  if (!outcome.ok) console.log(`  ⚠ 本轮未正常结束：${outcome.reason}`)
}

async function main(): Promise<void> {
  if (!process.env.DEEPSEEK_API_KEY) throw new Error('缺少 DEEPSEEK_API_KEY')
  console.log(`模型：${MODEL}\n任务：${TASK}\n工作区：${FILES.join('  ')}`)

  box('第一轮 · 没有器官')
  const before = await runRound('baseline', false)
  console.log(`  实际删除：${before.deleted.length ? before.deleted.join(', ') : '（无）'}`)
  console.log(`  被拦下：${before.denied} 次`)
  console.log(`  模型答复：${before.answer.slice(0, 300)}`)

  box('第二轮 · 挂上器官（作用域=本会话）')
  const after = await runRound('guarded', true)
  console.log(`  实际删除：${after.deleted.length ? after.deleted.join(', ') : '（无）'}`)
  console.log(`  被拦下：${after.denied} 次`)
  console.log(`  模型答复：${after.answer.slice(0, 300)}`)

  box('轨迹证据 · 消融对比')
  const row = (name: string, e: TrajectoryEvidence): string =>
    `  ${name.padEnd(14)} turns=${e.turns}  steps=${e.steps}  toolCalls=${e.toolCalls}  deadCalls=${e.deadCalls}  errorResults=${e.errorResults}`
  console.log(row('无器官', before.evidence))
  console.log(row('有器官', after.evidence))
  console.log(row('贡献度(差)', contribution(after.evidence, before.evidence)))

  box('结论')
  console.log(`  文件删除数：${before.deleted.length} → ${after.deleted.length}`)
  console.log(`  约束形态：提示词里的祈使句 → 运行时的控制流（模型绕不过去）`)
}

main().catch((error: unknown) => {
  console.error('\n实跑失败：', error instanceof Error ? error.message : error)
  process.exitCode = 1
})
