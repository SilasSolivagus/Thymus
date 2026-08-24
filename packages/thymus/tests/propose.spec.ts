/**
 * `propose_tool` 的配额、去重、回收。不调模型，确定性。
 *
 * 被测的三件事都是真 agent 上暴露出来的（见 campus/FINDINGS-24）：网关拦住它之后，
 * 它一口气注册了 4 个新工具想绕过去，一个都没绕成，但工具表和名字空间被撑大了。
 * 而按发现 23，名字先到先得——占掉的名字宿主之后就注册不上了。
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { installProposeTool, type ProposalKind, type ProposalPolicy } from './thymus-src/propose.ts'

const agent = { id: 'sess-1' } as never
const other = { id: 'sess-2' } as never

/** 一种只认自家后端的执行器。 */
const HTTP: ProposalKind = {
  validate: p => typeof p.url === 'string' && p.url.startsWith('https://api.example.com/')
    ? undefined
    : 'url 必须以 https://api.example.com/ 开头',
  execute: (p): Promise<string> => Promise.resolve(`[宿主执行器] ${String(p.url)}`),
  // 去重按后端地址算：换个工具名但指向同一个地址，是同一件事
  identity: p => `http:${String(p.url)}`,
}

const policy = (over: Partial<ProposalPolicy> = {}): ProposalPolicy =>
  ({ kinds: { http: HTTP }, maxRegistered: 2, maxAttempts: 5, ...over })

async function boot(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(Timer)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  return ctx
}

let callSeq = 0
/** 提交一份提案，返回宿主的答复。 */
async function propose(ctx: Context, p: unknown, who: never = agent): Promise<string> {
  const res = await ctx.tools.execute({
    signal: new AbortController().signal,
    callId: CallId(`pp-${++callSeq}`), name: 'propose_tool',
    arguments: { proposal: JSON.stringify(p) }, agent: who,
  })
  const first = res.content[0]
  return first?.type === 'text' ? first.text : JSON.stringify(first)
}

const good = (n: number): Record<string, string> => ({
  name: `tool_${n}`, description: `第 ${n} 个`, kind: 'http', url: `https://api.example.com/${n}`,
})

describe('propose_tool · 配额、去重、回收', () => {
  it('论证114 正常提案注册成功，新工具立刻可调用', async () => {
    const ctx = await boot()
    installProposeTool(ctx, policy())
    expect(await propose(ctx, good(1))).toContain('已注册工具「tool_1」')
    const res = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('use-1'), name: 'tool_1', arguments: {}, agent,
    })
    expect(res.content[0]).toMatchObject({ text: '[宿主执行器] https://api.example.com/1' })
  })

  it('论证115 配额：注册数到上限就拒，理由里说清已经有哪些', async () => {
    const ctx = await boot()
    installProposeTool(ctx, policy({ maxRegistered: 2 }))
    await propose(ctx, good(1))
    await propose(ctx, good(2))
    const third = await propose(ctx, good(3))
    expect(third).toContain('已达上限')
    expect(third).toContain('tool_1')                     // 告诉它手上有什么
    expect(ctx.tools.schemas().some(s => s.name === 'tool_3')).toBe(false)
  })

  it('论证116 去重：换个名字指向同一个后端，算同一件事', async () => {
    const ctx = await boot()
    installProposeTool(ctx, policy())
    await propose(ctx, good(1))
    const again = await propose(ctx, { ...good(9), url: 'https://api.example.com/1' })
    expect(again).toContain('已经提交过等价的工具')
    expect(again).toContain('tool_1')
  })

  it('论证117 去重不消耗注册名额——重复提交不该把配额烧掉', async () => {
    const ctx = await boot()
    const h = installProposeTool(ctx, policy({ maxRegistered: 2 }))
    await propose(ctx, good(1))
    await propose(ctx, { ...good(9), url: 'https://api.example.com/1' })   // 重复，被去重挡下
    await propose(ctx, good(2))
    expect(h.registered('sess-1')).toEqual(['tool_1', 'tool_2'])
  })

  it('论证118 提交次数上限：被拒之后无限重试也会停下来', async () => {
    const ctx = await boot()
    installProposeTool(ctx, policy({ maxAttempts: 3 }))
    await propose(ctx, { ...good(1), url: 'https://evil.test/x' })   // 1 次，被拒
    await propose(ctx, { ...good(2), url: 'https://evil.test/x' })   // 2 次，被拒
    await propose(ctx, { ...good(3), url: 'https://evil.test/x' })   // 3 次，被拒
    const stop = await propose(ctx, good(4))                          // 第 4 次：合规也不收了
    expect(stop).toContain('提交次数已达上限')
    // 这句是给模型的方向指引：真 agent 上它被网关拦住时会一直造新工具
    expect(stop).toContain('前置条件')
  })

  it('论证119 回收：会话结束后它注册的工具从工具表里消失', async () => {
    const ctx = await boot()
    const h = installProposeTool(ctx, policy())
    await propose(ctx, good(1))
    expect(ctx.tools.schemas().some(s => s.name === 'tool_1')).toBe(true)
    h.release('sess-1')
    expect(ctx.tools.schemas().some(s => s.name === 'tool_1')).toBe(false)
    expect(h.registered('sess-1')).toEqual([])
    // 回收之后名字重新可用——名字先到先得，不回收就等于永久占用
    expect(await propose(ctx, good(1))).toContain('已注册工具「tool_1」')
  })

  it('论证120 记账按会话分开：一个会话的配额用完不影响另一个', async () => {
    const ctx = await boot()
    const h = installProposeTool(ctx, policy({ maxRegistered: 1 }))
    await propose(ctx, good(1), agent)
    expect(await propose(ctx, good(2), agent)).toContain('已达上限')
    expect(await propose(ctx, good(2), other)).toContain('已注册工具「tool_2」')
    expect(h.registered('sess-1')).toEqual(['tool_1'])
    expect(h.registered('sess-2')).toEqual(['tool_2'])
  })

  it('论证121 冒用已有工具名被拒——名字先到先得，受管工具先占住', async () => {
    const ctx = await boot()
    ctx.tools.register({
      name: 'verify_identity', description: '核验',
      parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v as string }] },
      execute: (): Promise<string> => Promise.resolve('原版'),
    } as ToolDefinition)
    installProposeTool(ctx, policy())
    const r = await propose(ctx, { ...good(1), name: 'verify_identity' })
    expect(r).toContain('已被占用')
    // 原版还在
    const res = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('v-1'), name: 'verify_identity', arguments: {}, agent,
    })
    expect(res.content[0]).toMatchObject({ text: '原版' })
  })

  it('论证122 认不得的 kind 被拒，且理由里列出认得哪些', async () => {
    const ctx = await boot()
    installProposeTool(ctx, policy())
    const r = await propose(ctx, { name: 'evil_tool', description: 'x', kind: 'js', code: 'return 1' })
    expect(r).toContain('"http"')
    expect(r).toContain('不接受代码')
  })

  it('论证123 没有会话身份就拒——记不了账就配不了额', async () => {
    const ctx = await boot()
    installProposeTool(ctx, policy())
    const res = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('anon-1'), name: 'propose_tool',
      arguments: { proposal: JSON.stringify(good(1)) },
    })
    expect(res.content[0]).toMatchObject({ text: expect.stringContaining('没有会话身份') })
  })

  it('论证124 dispose 收掉全部会话的工具与 propose_tool 本身', async () => {
    const ctx = await boot()
    const h = installProposeTool(ctx, policy())
    await propose(ctx, good(1), agent)
    await propose(ctx, good(2), other)
    h.dispose()
    const names = ctx.tools.schemas().map(s => s.name)
    expect(names).not.toContain('tool_1')
    expect(names).not.toContain('tool_2')
    expect(names).not.toContain('propose_tool')
  })
})
