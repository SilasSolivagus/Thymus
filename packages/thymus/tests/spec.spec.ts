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
import { CallId } from '@deepseek-ai/dsh-llm'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { gateSay, installToolGate, type Constraint } from './thymus-src/gate.ts'
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

const agent = { id: 'spec' } as never

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

// ── C 类：内部字段不外泄，在工具产出交给模型之前抹掉 ──
// 做成「抹掉」而不是「说话时检查」，依据是 probe-verbatim-leak 的实测：
// 模型 3/3 会把内部信息说出去，整句逐字 0/3，其中一次连记号都没带、信息却全泄了。

const BILL_TEXT = '账期=2026-08 金额=30元 _internal_note=风控标记R7-9931，建议不予受理'

const NO_LEAK: ConstraintSpec = {
  name: '内部批注不外泄',
  type: 'no-leak',
  tool: 'query_bill',
  field: '_internal_note',
  evals: {
    deny: [BILL_TEXT],                       // 含该字段的产出必须被改写
    allow: ['账期=2026-08 金额=30元'],        // 不含该字段的产出必须原样
  },
}

const BILL_TOOL: ToolDefinition = {
  name: 'query_bill', description: 'bill',
  parameters: { type: 'object', properties: { account: { type: 'string' } } },
  output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v as string }] },
  execute: (): Promise<string> => Promise.resolve(BILL_TEXT),
}

async function callBill(ctx: Context): Promise<{ isError: boolean; text: string; hasValue: boolean }> {
  const res = await ctx.tools.execute({
    signal: new AbortController().signal,
    callId: CallId(`c-${Math.floor(performance.now())}`),
    name: 'query_bill', arguments: { account: 'A1' }, agent,
  })
  const f = res.content[0]
  return {
    isError: res.isError,
    text: f?.type === 'text' ? f.text : '',
    hasValue: (res as { value?: unknown }).value !== undefined,
  }
}

describe('约束声明 · 内部字段不外泄', () => {
  it('论证54 字段值在产出交给调用方之前就被抹掉', async () => {
    const ctx = await boot()
    ctx.tools.register(BILL_TOOL)
    installToolGate(ctx, compileConstraints(ctx, [NO_LEAK]))
    const r = await callBill(ctx)
    expect(r.text).toContain('账期=2026-08')          // 正常业务信息保留
    expect(r.text).toContain('_internal_note=***')
    expect(r.text).not.toContain('R7-9931')
    expect(r.text).not.toContain('不予受理')
  })

  it('论证55 原始返回值 value 也被去掉——留着等于脱敏没做', async () => {
    const ctx = await boot()
    ctx.tools.register(BILL_TOOL)
    const before = await callBill(ctx)
    expect(before.hasValue).toBe(true)                // 未挂约束时 value 在
    const ctx2 = await boot()
    ctx2.tools.register(BILL_TOOL)
    installToolGate(ctx2, compileConstraints(ctx2, [NO_LEAK]))
    expect((await callBill(ctx2)).hasValue).toBe(false)
  })

  it('论证56 只动声明的那个工具，别的工具产出不碰', async () => {
    const ctx = await boot()
    ctx.tools.register(BILL_TOOL)
    ctx.tools.register({ ...BILL_TOOL, name: 'other_tool' })
    installToolGate(ctx, compileConstraints(ctx, [NO_LEAK]))
    const res = await ctx.tools.execute({
      signal: new AbortController().signal, callId: CallId('c-other'),
      name: 'other_tool', arguments: {}, agent,
    })
    const f = res.content[0]
    expect(f?.type === 'text' && f.text).toContain('R7-9931')   // 没声明就不动
  })

  it('论证57 改写失败按拒绝整次调用处理——抹不掉不能放行', async () => {
    const ctx = await boot()
    ctx.tools.register(BILL_TOOL)
    installToolGate(ctx, [{
      name: '会炸的脱敏', postTool: (): string => { throw new Error('正则崩了') },
    }])
    const r = await callBill(ctx)
    expect(r.isError).toBe(true)
    expect(r.text).toContain('改写产出失败')
    expect(r.text).not.toContain('R7-9931')          // 失败也不能把原文放出去
  })

  it('论证58 验收用例判的是产出不是说的话，通道对得上', async () => {
    const ctx = await boot()
    const rs = await checkSpecEvals(ctx, [NO_LEAK])
    expect(rs[0]?.ok).toBe(true)
    expect(rs[0]?.deny.caught).toBe(1)
    expect(rs[0]?.allow.kept).toBe(1)
  })
})

// ── B 类：认人前置 ──
// 事实从 caller.succeeded 取（gate.ts 从会话事件日志解析）；这里的用例直接构造身份，
// 不伪造事件——伪造的形状和解析可能一起写错、互相掩盖（发现 18）。
// 解析那一层由 gate.spec.ts 论证78 的真 agent 测试盯着。

const VERIFY_FIRST: ConstraintSpec = {
  name: '认人前置',
  type: 'require-before',
  requires: 'verify_identity',
  unguarded: ['greet'],
  evals: {
    deny: [{ before: [], call: 'query_bill' }],
    allow: [{ before: ['verify_identity'], call: 'query_bill' }, { before: [], call: 'greet' }],
    // SPEC 没列出、但同类的工具：白名单写法下它默认受管，这一组应当通过
    heldout: [{ before: [], call: 'export_invoice' }],
  },
}

/** 构造一次带身份的调用。 */
const callAs = (call: string, before: string[]): Parameters<NonNullable<Constraint['preTool']>>[0] => ({
  name: call, arguments: {},
  caller: { sessionId: 's', events: [], succeeded: new Set(before) },
})

describe('约束声明 · B 类认人前置', () => {
  it('论证82 没认人拒绝、认过人放行，理由带约束名', async () => {
    const ctx = await boot()
    const [c] = compileConstraints(ctx, [VERIFY_FIRST])
    const denied = await c!.preTool!(callAs('query_bill', []))
    expect(denied.kind).toBe('deny')
    expect(denied.kind === 'deny' && denied.reason).toContain('认人前置')
    expect(denied.kind === 'deny' && denied.reason).toContain('verify_identity')
    expect((await c!.preTool!(callAs('query_bill', ['verify_identity']))).kind).toBe('allow')
  })

  it('论证83 白名单：没列出的工具默认受管，不是默认放行', async () => {
    const ctx = await boot()
    const [c] = compileConstraints(ctx, [VERIFY_FIRST])
    // export_invoice 声明里一个字都没提，仍然要求先认人
    expect((await c!.preTool!(callAs('export_invoice', []))).kind).toBe('deny')
    expect((await c!.preTool!(callAs('export_invoice', ['verify_identity']))).kind).toBe('allow')
    // unguarded 里列了的才免
    expect((await c!.preTool!(callAs('greet', []))).kind).toBe('allow')
  })

  it('论证84 前置工具自己永远免管——否则它调不起来，前置条件永远满足不了', async () => {
    const ctx = await boot()
    // 故意不把 verify_identity 写进 unguarded
    const [c] = compileConstraints(ctx, [{ ...VERIFY_FIRST, unguarded: [] } as ConstraintSpec])
    expect((await c!.preTool!(callAs('verify_identity', []))).kind).toBe('allow')
  })

  it('论证85 失败的核验不算数：succeeded 只收成功的调用', async () => {
    const ctx = await boot()
    const [c] = compileConstraints(ctx, [VERIFY_FIRST])
    // 调用失败时 gate.ts 不会把它放进 succeeded，这里等价于集合里没有它
    expect((await c!.preTool!(callAs('query_bill', ['some_other_tool']))).kind).toBe('deny')
  })

  it('论证86 没有身份也不放行，且理由与「没认人」分得开', async () => {
    const ctx = await boot()
    const [c] = compileConstraints(ctx, [VERIFY_FIRST])
    const v = await c!.preTool!({ name: 'query_bill', arguments: {} })
    expect(v.kind).toBe('deny')
    expect(v.kind === 'deny' && v.reason).toContain('没有身份')
  })

  it('论证87 验收用例跑得起来：三组各归各的，留出集在白名单写法下通过', async () => {
    const ctx = await boot()
    const [r] = await checkSpecEvals(ctx, [VERIFY_FIRST])
    expect(r!.ok).toBe(true)
    expect(r!.deny).toMatchObject({ caught: 1, total: 1 })
    expect(r!.allow).toMatchObject({ kept: 2, total: 2 })
    expect(r!.heldout).toMatchObject({ caught: 1, total: 1 })
  })

  it('论证88 阳性对照：unguarded 列宽了，留出集立刻掉下来', async () => {
    const ctx = await boot()
    // 把没列出的同类工具也免管——这正是黑名单写法的等价物
    const wide: ConstraintSpec = { ...VERIFY_FIRST, unguarded: ['greet', 'export_invoice'] } as ConstraintSpec
    const [r] = await checkSpecEvals(ctx, [wide])
    expect(r!.ok).toBe(true)                       // 必拦、必放两组仍然全过
    expect(r!.heldout).toMatchObject({ caught: 0, total: 1 })  // ← 判别力只在留出集
    expect(formatSpecEvalReports([r!])).toContain('unguarded 是不是列宽了')
  })

  it('论证89 用例标签认得出是哪一条序列', async () => {
    const ctx = await boot()
    const broken: ConstraintSpec = { ...VERIFY_FIRST, unguarded: ['greet', 'query_bill'] } as ConstraintSpec
    const [r] = await checkSpecEvals(ctx, [broken])
    expect(r!.deny.missed).toEqual(['（无前置） → query_bill'])
  })
})
