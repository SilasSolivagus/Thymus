/**
 * 约束声明形式的测试：数据进去，运行时约束出来，验收用例跟着一起跑。
 *
 * 语义类约束用假 adapter，不调真模型，确定性。
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { gateSay } from './thymus-src/gate.ts'
import {
  checkSpecEvals, compileConstraints, formatSpecEvalReports, type ConstraintSpec,
} from './thymus-src/spec.ts'

/** 假判定器：按语义关键词答「违规／合规」，模拟一个真的语义判定模型。 */
class PolicyJudge extends LlmAdapter {
  constructor(private readonly violating: string[]) { super() }
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const last = options.messages[options.messages.length - 1]
    const part = last?.content.find(c => c.type === 'text')
    const input = part?.type === 'text' ? part.text : ''
    const verdict = this.violating.some(v => input.includes(v)) ? '违规' : '合规'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: verdict }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: verdict } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function boot(judge?: LlmAdapter): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(Timer)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  if (judge !== undefined) ctx.llm.registerAdapter(['judge'], judge)
  return ctx
}

const LITERAL: ConstraintSpec = {
  name: '内部术语不外泄',
  type: 'forbidden-phrases',
  phrases: ['portal', 'BAS', 'BOSS'],
  evals: {
    deny: ['请登录 portal 查看', '这是 BOSS 系统的记录'],
    allow: ['已为您核实，账期是8月。'],
    heldout: ['请登录后台管理系统查看'],   // 语义同类、字面不同——词表必漏
  },
}

const SEMANTIC: ConstraintSpec = {
  name: '服务禁语',
  type: 'semantic-policy',
  policy: '不得出现态度消极、强势质问、甩锅推诿的表达。',
  provider: 'judge', model: 'judge',
  evals: {
    deny: ['这个不可能'],
    allow: ['已为您核实，账期是8月。'],
    heldout: ['这事我管不了'],
  },
}

describe('约束声明 · 编译成运行时约束', () => {
  it('论证44 字面禁语：命中即拒，理由带约束名和命中的词', async () => {
    const ctx = await boot()
    const cs = compileConstraints(ctx, [LITERAL])
    const hit = await gateSay(ctx, '请登录 portal 查看', cs)
    expect(hit.verdict.kind).toBe('deny')
    expect(hit.verdict.kind === 'deny' && hit.verdict.reason).toContain('内部术语不外泄')
    expect(hit.verdict.kind === 'deny' && hit.verdict.reason).toContain('portal')
    const clean = await gateSay(ctx, '已为您核实，账期是8月。', cs)
    expect(clean.verdict.kind).toBe('allow')
  })

  it('论证45 大小写归一化缺省开，SOP 里的术语变体也拦得住', async () => {
    const ctx = await boot()
    const cs = compileConstraints(ctx, [LITERAL])
    expect((await gateSay(ctx, '请查看 PORTAL 页面', cs)).verdict.kind).toBe('deny')
    const strict = compileConstraints(ctx, [{ ...LITERAL, name: '严格', ignoreCase: false }])
    expect((await gateSay(ctx, '请查看 PORTAL 页面', strict)).verdict.kind).toBe('allow')
  })

  it('论证46 语义策略：判定器说违规就拒，说合规才放', async () => {
    const ctx = await boot(new PolicyJudge(['不可能', '管不了']))
    const cs = compileConstraints(ctx, [SEMANTIC])
    expect((await gateSay(ctx, '这个不可能', cs)).verdict.kind).toBe('deny')
    expect((await gateSay(ctx, '已为您核实，账期是8月。', cs)).verdict.kind).toBe('allow')
  })

  it('论证47 判定器答得含糊，按违规计——含糊不能变成放行', async () => {
    class VagueJudge extends LlmAdapter {
      async * stream(): AsyncIterable<StreamChunk> {
        const t = '这个嘛，要看情况'
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: t } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
    const ctx = await boot(new VagueJudge())
    const cs = compileConstraints(ctx, [SEMANTIC])
    expect((await gateSay(ctx, '随便一句话', cs)).verdict.kind).toBe('deny')
  })

  it('论证48 约束名重复直接拒绝编译——归因要靠它', async () => {
    const ctx = await boot()
    expect(() => compileConstraints(ctx, [LITERAL, { ...LITERAL }])).toThrow(/名重复/)
  })
})

describe('约束声明 · 验收用例跟着约束一起跑', () => {
  it('论证49 逐条约束用它自己的用例判，归因天然分清', async () => {
    const ctx = await boot(new PolicyJudge(['不可能', '管不了']))
    const rs = await checkSpecEvals(ctx, [LITERAL, SEMANTIC])
    const [lit, sem] = rs
    expect(lit?.ok).toBe(true)
    expect(lit?.deny.caught).toBe(2)
    expect(lit?.allow.kept).toBe(1)
    expect(sem?.ok).toBe(true)
  })

  it('论证50 留出集把两种类型的能力差直接量出来', async () => {
    const ctx = await boot(new PolicyJudge(['不可能', '管不了']))
    const rs = await checkSpecEvals(ctx, [LITERAL, SEMANTIC])
    const [lit, sem] = rs
    // 字面词表在留出集上必漏；语义判定能覆盖。这不是声明写错，是类型的能力边界。
    expect(lit?.heldout.caught).toBe(0)
    expect(lit?.ok).toBe(true)              // 留出集不计入 ok
    expect(sem?.heldout.caught).toBe(1)
  })

  it('论证51 没写验收用例的声明会被点名', async () => {
    const ctx = await boot()
    const rs = await checkSpecEvals(ctx, [{ name: '光杆约束', type: 'forbidden-phrases', phrases: ['x'] }])
    expect(rs[0]?.missingEvals).toBe(true)
    expect(rs[0]?.ok).toBe(false)           // 没有验收就不算通过
  })

  it('论证52 词表定得过宽会被 allow 用例抓住', async () => {
    const ctx = await boot()
    const tooBroad: ConstraintSpec = {
      name: '过宽词表', type: 'forbidden-phrases',
      phrases: ['账期'],                     // 把正常业务词也列进去了
      evals: { deny: ['随便说个账期'], allow: ['已为您核实，账期是8月。'] },
    }
    const rs = await checkSpecEvals(ctx, [tooBroad])
    expect(rs[0]?.ok).toBe(false)
    expect(rs[0]?.allow.overreached).toEqual(['已为您核实，账期是8月。'])
  })

  it('论证53 报告能排成可读文本，交付时贴得进记录', async () => {
    const ctx = await boot(new PolicyJudge(['不可能', '管不了']))
    const text = formatSpecEvalReports(await checkSpecEvals(ctx, [LITERAL, SEMANTIC]))
    expect(text).toContain('内部术语不外泄')
    expect(text).toContain('留出 0/1')
    expect(text).toContain('字面词表在留出集上必漏')
  })
})
