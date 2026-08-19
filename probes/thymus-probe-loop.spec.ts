/**
 * THYMUS SPIKE PROBE — Loop 层。一次性探针。
 *
 * 参照系是 packages/core/agent-loop/tests/interception.spec.ts:234，
 * 那里由宿主侧静态代码挂 agent/pre-step 并 reject。本探针把同一件事
 * 换成 Agent 运行时自己写、经 vm 沙箱挂载的动态包，看真实 agent loop 认不认。
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

async function harness(adapter: MockAdapter): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(Timer)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(DynamicCordisRunnerService)
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
}

let counter = 0
/** 把一段「模型写的」源码经沙箱挂载，返回定义 id。 */
async function mountDynamic(ctx: Context, agent: Agent, code: string) {
  const { pluginId, packageId } = ctx.dynamicCordisRunner.define({
    sessionId: agent.id,
    plugin: { kind: 'new', idPrefix: 'thymus' },
    name: `thymus-loop-${++counter}`,
    purpose: 'spike probe',
    code: { host: code },
  })
  const receipt = await ctx.dynamicCordisRunner.run(agent, pluginId, packageId, 'run')
  if (!receipt.ok) throw new Error(receipt.message)
  return pluginId
}

/** 动态包：无条件否决一切 step 准入。 */
const GATEKEEPER_CODE = `
  return {
    name: 'thymus-gatekeeper',
    apply(ctx) {
      ctx.on('agent/pre-step', () => Promise.resolve({ kind: 'reject' }))
    },
  }
`

/** 动态包：不否决，但在喂给模型前往 messages 里追加一条。 */
const REWRITER_CODE = `
  return {
    name: 'thymus-rewriter',
    apply(ctx) {
      ctx.on('agent/pre-step', async (payload, next) => {
        const decision = await next()
        if (decision.kind === 'reject') return decision
        return {
          kind: 'enter',
          messages: [...decision.messages, {
            role: 'user',
            content: [{ type: 'text', text: 'INJECTED BY DYNAMIC PACKAGE' }],
            source: { kind: 'user' },
          }],
        }
      })
    },
  }
`

function events(agent: Agent): SessionEvent[] {
  return [...agent.session.events]
}

describe('THYMUS PROBE: Loop 层可达性', () => {
  it('探针 D：动态包能否决 step 准入，模型根本不被调用', async () => {
    const adapter = new MockAdapter([textResponse('should not run')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('loop-a'), { provider: 'mock', model: 'mock' })

    await mountDynamic(ctx, agent, GATEKEEPER_CODE)

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'do something' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(adapter.requests).toHaveLength(0)
    const log = events(agent)
    expect(log.some(e => e.type === 'step/start')).toBe(false)
  })

  it('探针 E：动态包能改写喂给模型的 messages', async () => {
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('loop-b'), { provider: 'mock', model: 'mock' })

    await mountDynamic(ctx, agent, REWRITER_CODE)

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(adapter.requests).toHaveLength(1)
    const sent = JSON.stringify(adapter.requests[0])
    expect(sent).toContain('INJECTED BY DYNAMIC PACKAGE')
  })

  it('探针 F：停掉动态包后，agent loop 恢复正常准入', async () => {
    const adapter = new MockAdapter([textResponse('first'), textResponse('second')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('loop-c'), { provider: 'mock', model: 'mock' })

    const pluginId = await mountDynamic(ctx, agent, GATEKEEPER_CODE)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'blocked' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(0)

    await expect(ctx.dynamicCordisRunner.stop(agent, pluginId)).resolves.toEqual({ ok: true })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'now allowed' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(1)
  })
})

describe('THYMUS PROBE: 跨 session 隔离（5.3 消融装置的前提）', () => {
  it('对照组：不挂任何动态包时，两个 session 都能正常跑到模型', async () => {
    const adapter = new MockAdapter([textResponse('a'), textResponse('b')])
    const ctx = await harness(adapter)
    const agentA = ctx.agentLoop.create(SessionId('ctl-a'), { provider: 'mock', model: 'mock' })
    const agentB = ctx.agentLoop.create(SessionId('ctl-b'), { provider: 'mock', model: 'mock' })

    agentA.followup(createUserMessage({ content: [{ type: 'text', text: 'to A' }], source: { kind: 'user' } }))
    await agentA.whenIdle()
    agentB.followup(createUserMessage({ content: [{ type: 'text', text: 'to B' }], source: { kind: 'user' } }))
    await agentB.whenIdle()

    expect(events(agentA).some(e => e.type === 'step/start')).toBe(true)
    expect(events(agentB).some(e => e.type === 'step/start')).toBe(true)
    expect(adapter.requests).toHaveLength(2)
  })

  it('探针 G：在 session A 挂的 Policy 会波及 session B —— 动态包的 ctx.on 不是 agent-scoped', async () => {
    const adapter = new MockAdapter([textResponse('a'), textResponse('b')])
    const ctx = await harness(adapter)
    const agentA = ctx.agentLoop.create(SessionId('iso-a'), { provider: 'mock', model: 'mock' })
    const agentB = ctx.agentLoop.create(SessionId('iso-b'), { provider: 'mock', model: 'mock' })

    // 只在 A 的 session 里定义并挂载
    await mountDynamic(ctx, agentA, GATEKEEPER_CODE)

    agentA.followup(createUserMessage({ content: [{ type: 'text', text: 'to A' }], source: { kind: 'user' } }))
    await agentA.whenIdle()
    agentB.followup(createUserMessage({ content: [{ type: 'text', text: 'to B' }], source: { kind: 'user' } }))
    await agentB.whenIdle()

    expect(events(agentA).some(e => e.type === 'step/start')).toBe(false)
    // 这条就是结论：B 没定义过任何动态包，却一起被挡住了
    expect(events(agentB).some(e => e.type === 'step/start')).toBe(false)
    expect(adapter.requests).toHaveLength(0)
  })
})
