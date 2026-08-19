/**
 * Thymus 轨迹证据投影的测试。
 *
 * 主测试喂的是真 agent loop 跑出来的事件序列，不是手搓的——
 * 要验的是这个折叠能不能对上 dsh 实际产生的事件，而不是我的算术。
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { apply, contribution, init, view, type TrajectoryEvidence } from './thymus-src/trajectory.ts'

function fold(events: readonly SessionEvent[]): TrajectoryEvidence {
  let state = init()
  for (const event of events) state = apply(state, event)
  return view(state)
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

async function harness(adapter: MockAdapter): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(Timer)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
}

async function poke(agent: Agent, text: string): Promise<void> {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  await agent.whenIdle()
}

/** 真实事件里，一次带工具调用的对话应该折出什么。 */
describe('Thymus 轨迹证据：对真实事件序列', () => {
  it('一轮、两步、一次工具调用，且结果被消费（无空转）', async () => {
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'probe_tool', {}),
      textResponse('done'),
    ])
    const ctx = await harness(adapter)
    ctx.tools.register(tool('probe_tool'))
    const agent = ctx.agentLoop.create(SessionId('traj-1'), { provider: 'mock', model: 'mock' })

    await poke(agent, 'use the tool')

    const events = [...agent.session.events]
    const evidence = fold(events)

    // 先把真实事件里各类事件的条数摊开，作为断言的锚
    const count = (t: string): number => events.filter(e => e.type === t).length
    expect(count('tool/call')).toBe(1)
    expect(count('tool/result')).toBe(1)

    expect(evidence.turns).toBe(1)
    expect(evidence.steps).toBe(count('step/end'))
    expect(evidence.toolCalls).toBe(1)
    // 工具结果之后 agent loop 又起了一步去读它，所以不是空转
    expect(evidence.deadCalls).toBe(0)
  })

  it('纯对话没有工具调用，也没有空转', async () => {
    const ctx = await harness(new MockAdapter([textResponse('hi')]))
    const agent = ctx.agentLoop.create(SessionId('traj-2'), { provider: 'mock', model: 'mock' })
    await poke(agent, 'hello')

    const evidence = fold([...agent.session.events])
    expect(evidence).toEqual({ turns: 1, steps: 1, toolCalls: 0, deadCalls: 0, errorResults: 0 })
  })

  it('两轮对话累加', async () => {
    const ctx = await harness(new MockAdapter([textResponse('one'), textResponse('two')]))
    const agent = ctx.agentLoop.create(SessionId('traj-3'), { provider: 'mock', model: 'mock' })
    await poke(agent, 'first')
    await poke(agent, 'second')

    const evidence = fold([...agent.session.events])
    expect(evidence.turns).toBe(2)
    expect(evidence.steps).toBe(2)
  })
})

/** 空转那条路真实事件里不好造，用构造事件把算术钉死。 */
describe('Thymus 轨迹证据：空转与消融的算术', () => {
  const ev = (type: string): SessionEvent => ({ type } as unknown as SessionEvent)
  /** tool/result 要带真实结构，折叠要读 message.content[0].isError。 */
  const result = (isError = false): SessionEvent => ({
    type: 'tool/result',
    data: { message: { content: [{ type: 'tool-result', isError }] } },
  } as unknown as SessionEvent)

  it('结果到本轮结束都没被后续步骤消费，记为空转', () => {
    const evidence = fold([
      ev('turn/start'), ev('step/start'), ev('step/end'),
      ev('tool/call'), result(),
      ev('turn/end'),                      // 结果之后再没有 step/start
    ])
    expect(evidence).toEqual({ turns: 1, steps: 1, toolCalls: 1, deadCalls: 1, errorResults: 0 })
  })

  it('结果之后又起了一步，就不算空转', () => {
    const evidence = fold([
      ev('turn/start'), ev('step/start'), ev('step/end'),
      ev('tool/call'), result(),
      ev('step/start'), ev('step/end'),    // 这一步读了它
      ev('turn/end'),
    ])
    expect(evidence.deadCalls).toBe(0)
    expect(evidence.steps).toBe(2)
  })

  it('一个闭合步骤都没有的轮次不计入 turns', () => {
    expect(fold([ev('turn/start'), ev('turn/end')]).turns).toBe(0)
  })

  it('不关心的事件必须返回同一个引用（投影座靠它判断有没有变）', () => {
    const state = init()
    expect(apply(state, ev('assistant/chunk'))).toBe(state)
    expect(apply(state, ev('user/message'))).toBe(state)
  })

  it('被拒的调用计入 errorResults —— Policy 层的拦截代理量', () => {
    const evidence = fold([
      ev('turn/start'), ev('step/start'), ev('step/end'),
      ev('tool/call'), result(true),
      ev('step/start'), ev('step/end'),
      ev('turn/end'),
    ])
    expect(evidence.errorResults).toBe(1)
    expect(evidence.toolCalls).toBe(1)
  })

  it('消融相减：器官省下了步数与空转', () => {
    const withOrgan: TrajectoryEvidence = { turns: 3, steps: 7, toolCalls: 4, deadCalls: 0, errorResults: 5 }
    const without: TrajectoryEvidence = { turns: 3, steps: 11, toolCalls: 9, deadCalls: 3, errorResults: 0 }
    expect(contribution(withOrgan, without)).toEqual({ turns: 0, steps: -4, toolCalls: -5, deadCalls: -3, errorResults: 5 })
  })
})
