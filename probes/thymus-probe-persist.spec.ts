/**
 * THYMUS SPIKE PROBE — 落盘。一次性探针。
 *
 * 问三件事：
 *   沙箱源码能不能机械转成磁盘上的正式插件，且行为一致
 *   全新进程能不能只凭磁盘配置把它捡起来（= 重启后仍在）
 *   从磁盘加载的器官是不是天然就在全局层
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { boot } from '../../../boot/app-boot/src/index.ts'
import { call, mount, REVERSE_TOOL_CODE, setup, text } from './helpers.ts'

/** 模型写的器官：拦 blocked_tool，放行其余。就是探针 A 那一个。 */
const ORGAN_SOURCE = `
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

/**
 * 转正器：把沙箱的「函数体，返回一个 plugin」机械包成一个正式插件模块。
 * 这是本探针要验证的那个转换，不是随手写的胶水。
 */
function promote(sandboxSource: string): string {
  return `const __plugin = (function () {${sandboxSource}})()
export const name = __plugin.name
export const apply = __plugin.apply
export const inject = __plugin.inject
`
}

function victimTool(name: string): ToolDefinition {
  return {
    name,
    description: `tool ${name}`,
    parameters: { type: 'object', properties: {} },
    output: {
      schema: { type: 'string' },
      render: (_a, v) => [{ type: 'text', text: v as string }],
    },
    execute: (): Promise<string> => Promise.resolve(`ran:${name}`),
  }
}

let n = 0
async function run(ctx: Context, name: string): Promise<string> {
  const r = await ctx.tools.execute({
    signal: new AbortController().signal,
    callId: CallId(`p-${++n}`),
    name,
    arguments: {},
  })
  const first = r.content[0]
  return first?.type === 'text' ? first.text : JSON.stringify(r.content)
}

describe('THYMUS PROBE: 落盘', () => {
  it('探针 L：沙箱形态与落盘形态行为一致', async () => {
    // (a) 沙箱路径
    const h = await setup()
    h.ctx.tools.register(victimTool('blocked_tool'))
    h.ctx.tools.register(victimTool('allowed_tool'))
    await mount(h, ORGAN_SOURCE)
    const sandboxBlocked = text(await call(h.ctx, 'blocked_tool', {}))
    const sandboxAllowed = text(await call(h.ctx, 'allowed_tool', {}))

    // (b) 落盘路径：同一段源码，经转正器写成文件，在全新 Context 里加载
    const dir = mkdtempSync(join(tmpdir(), 'thymus-promote-'))
    const file = join(dir, 'organ.mjs')
    writeFileSync(file, promote(ORGAN_SOURCE))

    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    ctx.tools.register(victimTool('blocked_tool'))
    ctx.tools.register(victimTool('allowed_tool'))
    const mod = await import(file)
    await ctx.plugin(mod)

    expect(await run(ctx, 'blocked_tool')).toBe(sandboxBlocked)
    expect(await run(ctx, 'allowed_tool')).toBe(sandboxAllowed)
    expect(sandboxBlocked).toBe('Error: thymus policy veto')
    expect(sandboxAllowed).toBe('ran:allowed_tool')
  })

  it('探针 M：全新进程只凭磁盘配置把器官捡起来（重启后仍在）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'thymus-boot-'))
    writeFileSync(join(dir, 'organ.mjs'), promote(ORGAN_SOURCE))
    writeFileSync(join(dir, 'cordis.yml'), '- id: thymus-organ\n  name: ./organ.mjs\n')

    // 内存里什么都没有：全新 Context，器官只能来自磁盘那一行配置
    const ctx = await boot('dsh-thymus-probe', join(dir, 'cordis.yml'), undefined, async (host) => {
      await host.plugin(SystemPrompt)
      await host.plugin(ToolRuntime)
      host.tools.register(victimTool('blocked_tool'))
      host.tools.register(victimTool('allowed_tool'))
    })

    expect(await run(ctx, 'blocked_tool')).toBe('Error: thymus policy veto')
    expect(await run(ctx, 'allowed_tool')).toBe('ran:allowed_tool')
  })

  it('对照组：同一棵树，配置里不写那一行，器官就不在', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'thymus-boot-ctl-'))
    writeFileSync(join(dir, 'organ.mjs'), promote(ORGAN_SOURCE))
    writeFileSync(join(dir, 'cordis.yml'), '[]\n')

    const ctx = await boot('dsh-thymus-probe', join(dir, 'cordis.yml'), undefined, async (host) => {
      await host.plugin(SystemPrompt)
      await host.plugin(ToolRuntime)
      host.tools.register(victimTool('blocked_tool'))
    })

    expect(await run(ctx, 'blocked_tool')).toBe('ran:blocked_tool')
  })
})

describe('THYMUS PROBE: 转正器的边界', () => {
  it('探针 N：用到沙箱专有辅助对象的动态包，机械转正会失败', async () => {
    // REVERSE_TOOL_CODE 通过 `harness.defineTool` / `harness.registerTool` 注册工具，
    // 这两个只存在于 vm 沙箱注入的全局里，正式模块里没有。
    expect(REVERSE_TOOL_CODE).toContain('harness.')

    // 沙箱里跑得好好的
    const h = await setup()
    await mount(h, REVERSE_TOOL_CODE)
    expect(text(await call(h.ctx, 'reverse_text', { text: 'abc' }))).toBe('cba')

    // 同一段源码机械转正后，加载即炸
    const dir = mkdtempSync(join(tmpdir(), 'thymus-promote-fail-'))
    const file = join(dir, 'organ.mjs')
    writeFileSync(file, promote(REVERSE_TOOL_CODE))

    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    const mod = await import(file)
    await expect((async () => {
      const fiber = ctx.plugin(mod)
      await fiber.await()
      // 工具没注册上，就是转正失败
      if (ctx.tools.schemas().every(s => s.name !== 'reverse_text')) {
        throw new Error('reverse_text was not registered after promotion')
      }
    })()).rejects.toThrow()
  })
})
