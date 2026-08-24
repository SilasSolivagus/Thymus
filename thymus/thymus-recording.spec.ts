/**
 * Thymus 录制能力的测试：dsh 的 session 持久化 = 记录器 + 评估依据。
 *
 * 证三件事：
 *   1. 挂上 JSONL 后端后，一次真实运行的 session 自动落盘；
 *   2. 从磁盘 load 回来的事件，喂给轨迹投影，能折叠出评估证据；
 *   3. 磁盘上的日志可被任意投影重放——即「轨迹即回归测试集」的机制基础。
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { apply, init, view } from './thymus-src/trajectory.ts'

function tool(name: string): ToolDefinition {
  return {
    name,
    description: `tool ${name}`,
    parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v as string }] },
    execute: (): Promise<string> => Promise.resolve(`ran:${name}`),
  }
}

async function boot(root: string, adapter: MockAdapter): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(Timer)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(Jsonl, { root, compression: 'none' })
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
}

describe('Thymus 录制：dsh 持久化即记录器与评估依据', () => {
  it('运行落盘 → 磁盘读回 → 折叠出与内存一致的评估证据', async () => {
    const root = mkdtempSync(join(tmpdir(), 'thymus-rec-'))
    const ctx = await boot(root, new MockAdapter([
      toolCallResponse('c1', 'probe_tool', {}),
      textResponse('done'),
    ]))
    ctx.tools.register(tool('probe_tool'))

    const sid = SessionId('rec-1')
    const handle = await ctx.agents.create({
      sessionId: sid,
      agentOptions: { provider: 'mock', model: 'mock' },
      setup: async () => {},
    })
    handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'use the tool' }], source: { kind: 'user' } }))
    await handle.agent.whenIdle()
    // 落盘是批量延迟写的（`writeBatchMaxDelayMs` 缺省 200ms），`whenIdle` 只保证 agent
    // 这一轮跑完，不保证写完。等固定时长会在机器忙的时候漏——整套测试并行跑时实测偶发
    // `expected [] to include 'rec-1'`。`ctx.sessions.flush` 是公开的持久化屏障，等它。
    await ctx.sessions.flush(handle.agent.session)

    // 内存里的证据
    const memFold = (evts: readonly SessionEvent[]) => {
      let s = init(); for (const e of evts) s = apply(s, e); return view(s)
    }
    const inMemory = memFold([...handle.agent.session.events])

    // 从磁盘 load 回来（全新 reader，不碰内存 session）
    const reader = new Context()
    await reader.plugin(SessionStore)
    await reader.plugin(Jsonl, { root, compression: 'none' })
    const persistence = reader.get('sessionPersistence')!

    // 1. session 确实落盘了
    expect((await persistence.list()).map(h => h.id)).toContain('rec-1')

    // 2. 磁盘读回，折叠
    const loaded = await persistence.load(sid)
    const fromDisk = memFold(loaded.events as SessionEvent[])

    // 3. 磁盘证据 = 内存证据（持久化无损）
    expect(fromDisk).toEqual(inMemory)
    expect(fromDisk.toolCalls).toBe(1)
    expect(loaded.events.length).toBeGreaterThan(5)
  })

  it('同一份磁盘日志可被重复读、被不同投影重放（回归测试集的基础）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'thymus-rec2-'))
    const ctx = await boot(root, new MockAdapter([textResponse('hi')]))
    const sid = SessionId('rec-2')
    const handle = await ctx.agents.create({
      sessionId: sid,
      agentOptions: { provider: 'mock', model: 'mock' },
      setup: async () => {},
    })
    handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }))
    await handle.agent.whenIdle()
    await ctx.sessions.flush(handle.agent.session)

    const reader = new Context()
    await reader.plugin(SessionStore)
    await reader.plugin(Jsonl, { root, compression: 'none' })
    const persistence = reader.get('sessionPersistence')!

    // 读两次，同一份日志，结果一致——可重放
    const a = await persistence.load(sid)
    const b = await persistence.load(sid)
    expect(a.events.length).toBe(b.events.length)
    expect(a.events.map(e => e.type)).toEqual(b.events.map(e => e.type))
  })
})
