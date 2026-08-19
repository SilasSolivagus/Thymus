/**
 * THYMUS SPIKE PROBE — 闭环。一次性探针。
 *
 * 一个器官走完作用域阶梯的全程：
 *   定义 → 通用筛 → L1 单会话 → 场景筛 → L2 preset 层 → 消融验证
 *        → 转正 → L3 全局层 → 降级 → 退役 → 档案
 * 外加一条旁路：清除。
 *
 * L2 / L3 用的模块由 promote() 从同一段沙箱源码生成，所以全程是同一个器官。
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import LlmRuntime, { CallId } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import AgentPresets from '@deepseek-ai/dsh-agent-presets'
import { createScope } from '@deepseek-ai/dsh-scope'
import DynamicCordisRunnerService from '../src/index.ts'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)),
  '../../../preset/agent-presets/tests/fixtures')
const ROOTS = [
  { path: join(FIXTURES, 'system'), trust: 'system' as const },
  { path: join(FIXTURES, 'user'), trust: 'user' as const },
]

/** 模型写的器官：拦 blocked_tool，放行其余。全程就这一段源码。 */
const ORGAN_SOURCE = `
  return {
    name: 'thymus-guard',
    apply(ctx) {
      ctx.on('tools/pre-execute', (exec, next) => {
        if (exec.name === 'blocked_tool') {
          return Promise.resolve({ kind: 'deny', reason: 'guard veto' })
        }
        return next()
      })
    },
  }
`

/** 转正器：沙箱形态 → 正式插件模块。已由探针 L 验证忠实。 */
function promote(src: string): string {
  return `const __p = (function () {${src}})()
export const name = __p.name
export const apply = __p.apply
export const inject = __p.inject
`
}

async function harness(): Promise<Context> {
  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(FIXTURES).href + '/'
  await ctx.plugin(Timer)
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { persona: '' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(AgentPresets, { default: 'standard', roots: ROOTS, includeUserRoot: false })
  await ctx.plugin(DynamicCordisRunnerService, { scopeToSession: true })
  return ctx
}

async function agentOn(ctx: Context, id: string, presetId: string): Promise<Agent> {
  const handle = await ctx.agents.create({
    sessionId: SessionId(id),
    setup: async (agentCtx: Context) => void await ctx.agentPresets.mount(agentCtx, presetId),
  })
  return handle.agent
}

function tool(name: string): ToolDefinition {
  return {
    name,
    description: `tool ${name}`,
    parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v as string }] },
    execute: (): Promise<string> => Promise.resolve(`ran:${name}`),
  }
}

let n = 0
async function callAs(ctx: Context, agent: Agent, name: string): Promise<string> {
  const r = await ctx.tools.execute({
    signal: new AbortController().signal,
    callId: CallId(`c-${++n}`), name, arguments: {}, agent,
  })
  const first = r.content[0]
  return first?.type === 'text' ? first.text : JSON.stringify(r.content)
}

/** 该 agent 此刻是否受这个器官管辖。 */
async function guarded(ctx: Context, agent: Agent): Promise<boolean> {
  return (await callAs(ctx, agent, 'blocked_tool')) === 'Error: guard veto'
}

/** 一条记录下来的轨迹：调用序列 + 当时的输出。场景筛拿它重放。 */
const TRAJECTORY = ['allowed_tool', 'other_tool', 'allowed_tool']

describe('THYMUS 闭环：一个器官走完作用域阶梯', () => {
  it('全程', async () => {
    const journey: string[] = []
    const ctx = await harness()
    for (const t of ['blocked_tool', 'allowed_tool', 'other_tool']) ctx.tools.register(tool(t))

    const a  = await agentOn(ctx, 'A',  'standard')   // 造这个器官的会话
    const b  = await agentOn(ctx, 'B',  'standard')   // 同一个 preset 的另一个会话
    const c  = await agentOn(ctx, 'C',  'minimal')    // 另一个 preset

    // ---- 记录基线轨迹（器官尚未存在）----
    const baseline: string[] = []
    for (const t of TRAJECTORY) baseline.push(await callAs(ctx, a, t))
    expect(await guarded(ctx, a)).toBe(false)
    journey.push('基线：三个会话都不受管')

    // ---- L0 定义 + 通用筛 ----
    const { pluginId, packageId } = ctx.dynamicCordisRunner.define({
      sessionId: a.id,
      plugin: { kind: 'new', idPrefix: 'guard' },
      name: 'thymus-guard', purpose: 'closed-loop probe',
      code: { host: ORGAN_SOURCE },
    })
    expect(pluginId).toMatch(/^guard-\d+$/)
    expect(await guarded(ctx, a)).toBe(false)      // 定义 ≠ 生效
    journey.push(`L0 已定义 ${pluginId}/${packageId}，通用筛通过，尚未生效`)

    // ---- L1 单会话 ----
    const receipt = await ctx.dynamicCordisRunner.run(a, pluginId, packageId, 'run')
    expect(receipt.ok).toBe(true)
    expect(await guarded(ctx, a)).toBe(true)
    expect(await guarded(ctx, b)).toBe(false)
    expect(await guarded(ctx, c)).toBe(false)
    journey.push('L1 单会话：只有 A 受管，同 preset 的 B 与他 preset 的 C 都不受影响')

    // ---- 场景筛：重放基线轨迹，确认没有退化 ----
    const replay: string[] = []
    for (const t of TRAJECTORY) replay.push(await callAs(ctx, a, t))
    expect(replay).toEqual(baseline)
    journey.push('场景筛：基线轨迹重放逐条一致，无退化')

    // ---- 升到 L2 preset 层 ----
    await expect(ctx.dynamicCordisRunner.stop(a, pluginId)).resolves.toEqual({ ok: true })
    expect(await guarded(ctx, a)).toBe(false)      // 卸干净了

    const dir = mkdtempSync(join(tmpdir(), 'thymus-loop-'))
    const file = join(dir, 'organ.mjs')
    writeFileSync(file, promote(ORGAN_SOURCE))
    const organ = await import(file)

    const standingKey = await ctx.agentPresets.standingKeyFor('standard')
    const l2 = createScope(ctx, standingKey)
    const l2fiber = l2.ctx.plugin(organ)
    await l2fiber.await()

    expect(await guarded(ctx, a)).toBe(true)
    expect(await guarded(ctx, b)).toBe(true)       // 同 preset 一起受管
    expect(await guarded(ctx, c)).toBe(false)      // 他 preset 仍然不受管
    journey.push('L2 preset 层：A 与 B 同受管，C 不受影响')

    // ---- 消融验证：卸掉看差异 ----
    await l2fiber.dispose()
    const without = await guarded(ctx, b)
    const l2again = l2.ctx.plugin(organ)
    await l2again.await()
    const withOrgan = await guarded(ctx, b)
    expect(without).toBe(false)
    expect(withOrgan).toBe(true)
    journey.push('消融：卸掉则 B 不受管，装回则受管 —— 贡献度非零')

    // ---- 转正到 L3 全局层 ----
    await l2again.dispose()
    const l3fiber = ctx.plugin(organ)
    await l3fiber.await()
    expect(await guarded(ctx, a)).toBe(true)
    expect(await guarded(ctx, b)).toBe(true)
    expect(await guarded(ctx, c)).toBe(true)       // 跨 preset，全局生效
    journey.push('L3 全局层：三个会话全部受管')

    // ---- 降级 L3 → L2 ----
    await l3fiber.dispose()
    const back2 = l2.ctx.plugin(organ)
    await back2.await()
    expect(await guarded(ctx, c)).toBe(false)
    expect(await guarded(ctx, b)).toBe(true)
    journey.push('降级 L3→L2：C 脱离管辖，A/B 仍在观察期内')

    // ---- 降级 L2 → L1 ----
    await back2.dispose()
    const back1 = await ctx.dynamicCordisRunner.run(a, pluginId, packageId, 'run')
    expect(back1.ok).toBe(true)
    expect(await guarded(ctx, a)).toBe(true)
    expect(await guarded(ctx, b)).toBe(false)
    journey.push('降级 L2→L1：退回单会话')

    // ---- 退役 → 档案 ----
    await ctx.dynamicCordisRunner.stop(a, pluginId)
    await l2.dispose()
    expect(await guarded(ctx, a)).toBe(false)
    expect(await guarded(ctx, b)).toBe(false)
    expect(await guarded(ctx, c)).toBe(false)

    const archive = {
      pluginId, packageId,
      source: ORGAN_SOURCE,
      promoted: promote(ORGAN_SOURCE),
      reachedRung: 'L3',
      trajectory: { recorded: TRAJECTORY.length, regressions: 0 },
      reason: 'probe complete',
    }
    expect(archive.source).toContain('tools/pre-execute')
    expect(archive.reachedRung).toBe('L3')
    journey.push('退役：三个会话全部恢复，档案留存源码与到达过的最高层级')

    // eslint-disable-next-line no-console
    console.log('\n=== 闭环走完 ===\n' + journey.map((s, i) => `${i + 1}. ${s}`).join('\n') + '\n')
  })
})

describe('THYMUS 闭环：两条旁路', () => {
  it('通用筛：畸形器官在定义当场就被拦下，上不了梯子', async () => {
    const ctx = await harness()
    ctx.tools.register(tool('blocked_tool'))
    const a = await agentOn(ctx, 'MAL', 'standard')

    // 语法就不合法
    expect(() => ctx.dynamicCordisRunner.define({
      sessionId: a.id,
      plugin: { kind: 'new', idPrefix: 'bad' },
      name: 'malformed', purpose: 'probe',
      code: { host: 'return { name: "x", apply(ctx) { this is not javascript } }' },
    })).toThrow()

    // 语法合法但不返回 plugin —— 拖到挂载才暴露
    const { pluginId, packageId } = ctx.dynamicCordisRunner.define({
      sessionId: a.id,
      plugin: { kind: 'new', idPrefix: 'bad' },
      name: 'not-a-plugin', purpose: 'probe',
      code: { host: 'return 42' },
    })
    const receipt = await ctx.dynamicCordisRunner.run(a, pluginId, packageId, 'run')
    expect(receipt.ok).toBe(false)
    expect(await guarded(ctx, a)).toBe(false)
  })

  it('清除：拦一切的器官会锁死自己的逃生口，只能带外拔掉', async () => {
    const ctx = await harness()
    for (const t of ['blocked_tool', 'cordis_stop']) ctx.tools.register(tool(t))
    const a = await agentOn(ctx, 'PUR', 'standard')

    const { pluginId, packageId } = ctx.dynamicCordisRunner.define({
      sessionId: a.id,
      plugin: { kind: 'new', idPrefix: 'lock' },
      name: 'lockout', purpose: 'probe',
      code: { host: `return { name: 'lockout', apply(ctx) {
        ctx.on('tools/pre-execute', () => Promise.resolve({ kind: 'deny', reason: 'all denied' }))
      } }` },
    })
    await ctx.dynamicCordisRunner.run(a, pluginId, packageId, 'run')

    // Agent 想调 cordis_stop 自救，被自己挂的东西拦下
    expect(await callAs(ctx, a, 'cordis_stop')).toBe('Error: all denied')

    // 宿主侧直接卸载不经过工具分发 —— 带外通道有效
    await expect(ctx.dynamicCordisRunner.stop(a, pluginId)).resolves.toEqual({ ok: true })
    expect(await callAs(ctx, a, 'cordis_stop')).toBe('ran:cordis_stop')
  })
})
