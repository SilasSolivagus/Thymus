/**
 * THYMUS SPIKE PROBE — 作用域阶梯。一次性探针。
 *
 * 证的是三件事：
 *   L1 单会话级挂载能不能做出来（现在做不出来，这是梯子的地基）
 *   L3 全局级挂载是不是真的跨会话
 *   同一个器官能不能在两级之间升降
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import DynamicCordisRunnerService from '../src/index.ts'

async function harness(adapter: MockAdapter, scopeToSession: boolean): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(Timer)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(DynamicCordisRunnerService, { scopeToSession })
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
}

/** 「器官」的逻辑：否决一切 step 准入。沙箱版本。 */
const GATEKEEPER_SANDBOX = `
  return {
    name: 'thymus-gatekeeper',
    apply(ctx) {
      ctx.on('agent/pre-step', () => Promise.resolve({ kind: 'reject' }))
    },
  }
`

/** 同一段逻辑的宿主插件形态 —— 这就是「转正」之后它的样子。 */
const gatekeeperPlugin = {
  name: 'thymus-gatekeeper-promoted',
  apply(ctx: Context) {
    ctx.on('agent/pre-step', () => Promise.resolve({ kind: 'reject' as const }))
  },
}

let counter = 0
async function mountDynamic(ctx: Context, agent: Agent, code: string) {
  const { pluginId, packageId } = ctx.dynamicCordisRunner.define({
    sessionId: agent.id,
    plugin: { kind: 'new', idPrefix: 'thymus' },
    name: `ladder-${++counter}`,
    purpose: 'spike probe',
    code: { host: code },
  })
  const receipt = await ctx.dynamicCordisRunner.run(agent, pluginId, packageId, 'run')
  if (!receipt.ok) throw new Error(receipt.message)
  return pluginId
}

function blocked(agent: Agent): boolean {
  return ![...agent.session.events].some((e: SessionEvent) => e.type === 'step/start')
}

async function poke(agent: Agent, text: string): Promise<void> {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  await agent.whenIdle()
}

describe('THYMUS PROBE: 作用域阶梯', () => {
  it('对照组：不挂任何东西时，两个会话都能跑到模型', async () => {
    const ctx = await harness(new MockAdapter([textResponse('a'), textResponse('b')]), true)
    const a = ctx.agentLoop.create(SessionId('base-a'), { provider: 'mock', model: 'mock' })
    const b = ctx.agentLoop.create(SessionId('base-b'), { provider: 'mock', model: 'mock' })
    await poke(a, 'to A'); await poke(b, 'to B')
    expect(blocked(a)).toBe(false)
    expect(blocked(b)).toBe(false)
  })

  it('探针 H（现状）：scopeToSession=false —— 在 A 挂的器官把 B 也挡了', async () => {
    const ctx = await harness(new MockAdapter([textResponse('a'), textResponse('b')]), false)
    const a = ctx.agentLoop.create(SessionId('leak-a'), { provider: 'mock', model: 'mock' })
    const b = ctx.agentLoop.create(SessionId('leak-b'), { provider: 'mock', model: 'mock' })

    await mountDynamic(ctx, a, GATEKEEPER_SANDBOX)
    await poke(a, 'to A'); await poke(b, 'to B')

    expect(blocked(a)).toBe(true)
    expect(blocked(b)).toBe(true)   // 泄漏
  })

  it('探针 I（L1 成立）：scopeToSession=true —— 只挡 A，B 完好', async () => {
    const ctx = await harness(new MockAdapter([textResponse('a'), textResponse('b')]), true)
    const a = ctx.agentLoop.create(SessionId('iso-a'), { provider: 'mock', model: 'mock' })
    const b = ctx.agentLoop.create(SessionId('iso-b'), { provider: 'mock', model: 'mock' })

    await mountDynamic(ctx, a, GATEKEEPER_SANDBOX)
    await poke(a, 'to A'); await poke(b, 'to B')

    expect(blocked(a)).toBe(true)
    expect(blocked(b)).toBe(false)  // 隔离成立
  })

  it('探针 J（L3 成立）：同一逻辑挂到根上下文 —— 两个会话都受管', async () => {
    const ctx = await harness(new MockAdapter([textResponse('a'), textResponse('b')]), true)
    const a = ctx.agentLoop.create(SessionId('glob-a'), { provider: 'mock', model: 'mock' })
    const b = ctx.agentLoop.create(SessionId('glob-b'), { provider: 'mock', model: 'mock' })

    await ctx.plugin(gatekeeperPlugin)
    await poke(a, 'to A'); await poke(b, 'to B')

    expect(blocked(a)).toBe(true)
    expect(blocked(b)).toBe(true)
  })

  it('探针 K（升级可行）：同一个器官，先只管 A，转正后连 B 一起管', async () => {
    const ctx = await harness(new MockAdapter([textResponse('1'), textResponse('2'), textResponse('3')]), true)
    const a = ctx.agentLoop.create(SessionId('up-a'), { provider: 'mock', model: 'mock' })
    const b = ctx.agentLoop.create(SessionId('up-b'), { provider: 'mock', model: 'mock' })

    // L1：挂在 A 的作用域下
    const pluginId = await mountDynamic(ctx, a, GATEKEEPER_SANDBOX)
    await poke(b, 'B 此时不受管')
    expect(blocked(b)).toBe(false)

    // 转正：从 L1 卸下，在 L3 挂上
    await expect(ctx.dynamicCordisRunner.stop(a, pluginId)).resolves.toEqual({ ok: true })
    const fiber = ctx.plugin(gatekeeperPlugin)
    await fiber.await()

    const b2 = ctx.agentLoop.create(SessionId('up-b2'), { provider: 'mock', model: 'mock' })
    await poke(b2, 'B2 现在应当受管')
    expect(blocked(b2)).toBe(true)

    // 降级：从 L3 卸下，两边都恢复
    await fiber.dispose()
    const b3 = ctx.agentLoop.create(SessionId('up-b3'), { provider: 'mock', model: 'mock' })
    await poke(b3, 'B3 应当恢复')
    expect(blocked(b3)).toBe(false)
  })
})
