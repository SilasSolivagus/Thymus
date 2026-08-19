/**
 * THYMUS SPIKE PROBE — 一次性探针，不是要保留的代码。
 *
 * 验证 DESIGN.md 3.1 节的核心断言：Agent 运行时自己写出来的动态包，
 * 能否触及主循环的 waterfall（Policy 层），而不只是追加工具（Tool 层）。
 */
import { describe, expect, it } from 'vitest'
import { CallId } from '@deepseek-ai/dsh-llm'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import { AGENT_A, mount, setup } from './helpers.ts'

/** 一个普通的宿主侧工具，充当被拦截的靶子。 */
function victimTool(name: string): ToolDefinition {
  return {
    name,
    description: `tool ${name}`,
    parameters: { type: 'object', properties: {} },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value as string }],
    },
    execute: (): Promise<string> => Promise.resolve(`ran:${name}`),
  }
}

let callCounter = 0
async function run(ctx: Context, name: string): Promise<string> {
  const result = await ctx.tools.execute({
    signal: new AbortController().signal,
    callId: CallId(`probe-${++callCounter}`),
    name,
    arguments: {},
  })
  const first = result.content[0]
  return first?.type === 'text' ? first.text : JSON.stringify(result.content)
}

/** 动态包：只拦 blocked_tool，放行其余。这是 Policy 层的最小形态。 */
const POLICY_CODE = `
  return {
    name: 'thymus-policy',
    apply(ctx) {
      ctx.on('tools/pre-execute', (exec, next) => {
        if (exec.name === 'blocked_tool') {
          return Promise.resolve({ kind: 'deny', reason: 'thymus policy veto' })
        }
        return next()
      })
    },
  }
`

/** 动态包：拦截一切。用来测「主循环可被掐断」这条风险。 */
const TOTAL_LOCKOUT_CODE = `
  return {
    name: 'thymus-lockout',
    apply(ctx) {
      ctx.on('tools/pre-execute', () => {
        return Promise.resolve({ kind: 'deny', reason: 'everything denied' })
      })
    },
  }
`

describe('THYMUS PROBE: Policy 层可达性', () => {
  it('探针 A：动态包能挂上 tools/pre-execute 并真的拦住工具调用', async () => {
    const harness = await setup()
    harness.ctx.tools.register(victimTool('blocked_tool'))
    harness.ctx.tools.register(victimTool('allowed_tool'))

    // 挂载前：两个工具都正常
    expect(await run(harness.ctx, 'blocked_tool')).toBe('ran:blocked_tool')
    expect(await run(harness.ctx, 'allowed_tool')).toBe('ran:allowed_tool')

    await mount(harness, POLICY_CODE)

    // 挂载后：被拦的拦住，没拦的照常
    expect(await run(harness.ctx, 'blocked_tool')).toBe('Error: thymus policy veto')
    expect(await run(harness.ctx, 'allowed_tool')).toBe('ran:allowed_tool')
  })

  it('探针 B：cordis_stop 后拦截器干净 unwind，工具恢复', async () => {
    const harness = await setup()
    harness.ctx.tools.register(victimTool('blocked_tool'))
    const pluginId = await mount(harness, POLICY_CODE)

    expect(await run(harness.ctx, 'blocked_tool')).toBe('Error: thymus policy veto')

    await expect(harness.runner.stop(AGENT_A, pluginId)).resolves.toEqual({ ok: true })

    expect(await run(harness.ctx, 'blocked_tool')).toBe('ran:blocked_tool')
  })

  it('探针 C：一个拦一切的 Policy 会掐断 Agent 自己的逃生口，但宿主侧 stop 仍可解', async () => {
    const harness = await setup()
    harness.ctx.tools.register(victimTool('any_tool'))
    // 站位：Agent 唯一的卸载手段 cordis_stop 本身也是一个工具，同样走 pre-execute
    harness.ctx.tools.register(victimTool('cordis_stop'))

    const pluginId = await mount(harness, TOTAL_LOCKOUT_CODE)

    expect(await run(harness.ctx, 'any_tool')).toBe('Error: everything denied')
    // 关键：Agent 想调 cordis_stop 自救，也被自己挂的东西拦下
    expect(await run(harness.ctx, 'cordis_stop')).toBe('Error: everything denied')

    // 宿主侧直接调 runner.stop（不经过工具分发）仍然有效 —— 带外杀手锏成立
    await expect(harness.runner.stop(AGENT_A, pluginId)).resolves.toEqual({ ok: true })
    expect(await run(harness.ctx, 'any_tool')).toBe('ran:any_tool')
  })
})
