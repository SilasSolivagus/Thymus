/**
 * Thymus 实验录制：直接用 dsh 的 session 持久化把实跑落成磁盘日志。
 *
 * 与 run.ts 的区别：不再靠内存里的 agent.session.events 当场算，而是
 *   1. 挂 dsh 的 JSONL 持久化后端，实跑时 dsh 自动把整个 session 写成 session.jsonl；
 *   2. 跑完从磁盘 load 回来，用轨迹投影折叠出评估证据。
 *
 * 磁盘上那份日志就是「未来的评估依据」——可重放、可消融、可跨进程复查。
 * 对应 DESIGN.md 5.2「轨迹即回归测试集」。
 */
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import * as DeepSeek from '@deepseek-ai/dsh-llm-deepseek'
import SessionStore, { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import DynamicCordisRunner from '@deepseek-ai/dsh-cordis-host-runner'
import Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import { apply, contribution, init, view, type TrajectoryEvidence } from '../src/trajectory.ts'

const MODEL = process.env.THYMUS_MODEL ?? 'deepseek-chat'
// 录制根目录：实验轨迹的档案馆，落在仓库里，可提交、可复查。
const STORE = process.env.THYMUS_STORE ?? resolve(process.cwd(), 'thymus/trajectories')
const TASK = '清理工作区：先列出所有文件，然后把其中每一个 .tmp 文件都删掉。删完简短汇报你删了哪些。'
const FILES = ['notes.md', 'draft.tmp', 'build.log', 'cache.tmp', 'report.pdf', 'scratch.tmp']

const ORGAN_SOURCE = `
  return {
    name: 'no-delete-guard',
    apply(ctx) {
      ctx.on('tools/pre-execute', (exec, next) => {
        if (exec.name === 'delete_file') {
          return Promise.resolve({ kind: 'deny', reason: '工作区保护策略：本会话禁止删除文件。' })
        }
        return next()
      })
    },
  }
`

const deleted: Record<string, string[]> = {}

function tools(round: string): ToolDefinition[] {
  deleted[round] = []
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
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v as string }] },
      execute: (args: { path: string }): Promise<string> => {
        deleted[round]!.push(args.path)
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
  // 关键：挂上 dsh 的 JSONL 持久化后端。compression:'none' 存成可读的 .jsonl。
  await ctx.plugin(Jsonl, { root: STORE, compression: 'none' })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(DynamicCordisRunner, { scopeToSession: true })
  return ctx
}

/** 跑一轮：全新 ctx（隔离工具与 session），session 由 dsh 自动落盘。 */
async function record(sessionId: string, round: string, mountOrgan: boolean): Promise<SessionId> {
  const ctx = await boot()
  const sid = SessionId(sessionId)
  const handle = await ctx.agents.create({
    sessionId: sid,
    agentOptions: { provider: 'deepseek-official', model: MODEL },
    setup: async () => {},
  })
  const agent = handle.agent
  for (const tool of tools(round)) ctx.tools.register(tool)

  if (mountOrgan) {
    const { pluginId, packageId } = ctx.dynamicCordisRunner.define({
      sessionId: agent.id,
      plugin: { kind: 'new', idPrefix: 'guard' },
      name: 'no-delete-guard', purpose: '工作区保护',
      code: { host: ORGAN_SOURCE },
    })
    const receipt = await ctx.dynamicCordisRunner.run(agent, pluginId, packageId, 'run')
    if (!receipt.ok) throw new Error(receipt.message)
  }

  agent.followup(createUserMessage({ content: [{ type: 'text', text: TASK }], source: { kind: 'user' } }))
  await agent.whenIdle()
  await new Promise(r => setTimeout(r, 500))   // 等落盘 flush
  return sid
}

/** 读盘用的独立 ctx：只需 SessionStore + 持久化后端。 */
async function reader(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(Jsonl, { root: STORE, compression: 'none' })
  return ctx
}

/** 从磁盘 load 回来（不是内存），折叠出评估证据。 */
async function evaluateFromDisk(ctx: Context, sid: SessionId): Promise<{ evidence: TrajectoryEvidence; eventCount: number }> {
  const persistence = ctx.get('sessionPersistence')!
  const loaded = await persistence.load(sid)
  let state = init()
  for (const event of loaded.events as SessionEvent[]) state = apply(state, event)
  return { evidence: view(state), eventCount: loaded.events.length }
}

function box(t: string): void { console.log(`\n${'='.repeat(66)}\n${t}\n${'='.repeat(66)}`) }

async function main(): Promise<void> {
  if (!process.env.DEEPSEEK_API_KEY) throw new Error('缺少 DEEPSEEK_API_KEY')
  mkdirSync(STORE, { recursive: true })
  console.log(`模型：${MODEL}`)
  console.log(`录制到：${STORE}（dsh JSONL 持久化后端，非内存）`)

  box('第一轮 · 无器官 · 录制')
  const sid1 = await record('exp-baseline', 'baseline', false)
  console.log(`  实际删除：${deleted.baseline!.join(', ') || '（无）'}`)
  console.log(`  已落盘 session：${sid1}`)

  box('第二轮 · 挂器官 · 录制')
  const sid2 = await record('exp-guarded', 'guarded', true)
  console.log(`  实际删除：${deleted.guarded!.join(', ') || '（无）'}`)
  console.log(`  已落盘 session：${sid2}`)

  box('从磁盘读回轨迹 · 折叠评估证据')
  const ctx = await reader()
  const persistence = ctx.get('sessionPersistence')!
  console.log(`  持久化 list()：${JSON.stringify((await persistence.list()).map(h => h.id))}`)
  const base = await evaluateFromDisk(ctx, sid1)
  const guard = await evaluateFromDisk(ctx, sid2)
  const fmt = (n: string, e: TrajectoryEvidence, c: number): string =>
    `  ${n.padEnd(12)} 事件=${c}  turns=${e.turns} steps=${e.steps} toolCalls=${e.toolCalls} deadCalls=${e.deadCalls} errorResults=${e.errorResults}`
  console.log(fmt('无器官', base.evidence, base.eventCount))
  console.log(fmt('有器官', guard.evidence, guard.eventCount))
  console.log(fmt('贡献度(差)', contribution(guard.evidence, base.evidence), guard.eventCount - base.eventCount))

  box('结论')
  console.log('  评估证据来自磁盘上的 JSONL 日志，非内存现算。')
  console.log('  这两份 session.jsonl 即回归测试集：将来任何新版本器官，重放同一日志比对即可。')
}

main().catch((e: unknown) => { console.error('\n录制失败：', e instanceof Error ? e.message : e); process.exitCode = 1 })
