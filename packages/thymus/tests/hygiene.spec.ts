/**
 * 冻结前机械闸的测试。全部静态，不调模型。
 *
 * 每条检查都配一个「本来该过」的对照——检查得能分清好坏，不是一律报警。
 * 用的反例是真的：模型自己写声明那一轮里，字面词表的留出集 3 次有 2 次直接含着
 * 已声明的禁语（见 campus/FINDINGS-22）。
 */
import { describe, expect, it } from 'vitest'
import { checkSpecHygiene, formatHygieneReport, type SpecBundle } from './thymus-src/hygiene.ts'
import type { ConstraintSpec } from './thymus-src/spec.ts'

const GOOD_LITERAL: ConstraintSpec = {
  name: '内部术语不外泄',
  type: 'forbidden-phrases',
  phrases: ['portal', 'BOSS'],
  evals: {
    deny: ['请登录 portal 查看'],
    allow: ['已为您核实，账期是8月。'],
    heldout: ['请登录后台管理系统查看'],
  },
}

const GOOD_SEQ: ConstraintSpec = {
  name: '认人前置',
  type: 'require-before',
  requires: 'lookup_account',
  unguarded: ['query_network'],
  evals: {
    deny: [{ before: [], call: 'query_bill' }],
    allow: [{ before: ['lookup_account'], call: 'query_bill' }],
    heldout: [{ before: [], call: 'export_invoice' }],
  },
}

/** 只留必要字段的最小 bundle。 */
const bundle = (specs: ConstraintSpec[], uncovered: SpecBundle['uncovered'] = [{ clause: 'x', why: 'y' }]): SpecBundle =>
  ({ specs, uncovered })

describe('冻结前机械闸', () => {
  it('论证103 一份写好的声明能过，且不误报', () => {
    const r = checkSpecHygiene(bundle([GOOD_LITERAL, GOOD_SEQ]))
    expect(r.ok).toBe(true)
    expect(r.problems).toEqual([])
  })

  it('论证104 字面词表：留出题里含着已声明的词就是伪装的', () => {
    // 这条是真的——模型第 2 版写的四条留出题全是这样（发现 22）
    const faked: ConstraintSpec = {
      ...GOOD_LITERAL,
      evals: { ...GOOD_LITERAL.evals, heldout: ['BOSS里查不到这个记录。'] },
    } as ConstraintSpec
    const r = checkSpecHygiene(bundle([faked]))
    expect(r.ok).toBe(false)
    expect(r.problems.some(p => p.message.includes('必中'))).toBe(true)
  })

  it('论证105 认人前置：留出题调的是免检工具，那是死用例', () => {
    const dead: ConstraintSpec = {
      ...GOOD_SEQ,
      evals: { ...GOOD_SEQ.evals, heldout: [{ before: [], call: 'query_network' }] },
    } as ConstraintSpec
    const r = checkSpecHygiene(bundle([dead]))
    expect(r.ok).toBe(false)
    expect(r.problems.some(p => p.message.includes('死用例'))).toBe(true)
  })

  it('论证106 语义类：留出题直接用了 policy 里举过的例词', () => {
    const spec: ConstraintSpec = {
      name: '服务禁语', type: 'semantic-policy',
      policy: '不得出现「不可能」「做不到」等消极表达。',
      provider: 'p', model: 'm',
      evals: {
        deny: ['这个不可能。'], allow: ['已为您核实。'],
        heldout: ['这个不可能办到。'],          // ← 直接用了例词
      },
    }
    const r = checkSpecHygiene(bundle([spec]))
    expect(r.ok).toBe(false)
    expect(r.problems.some(p => p.message.includes('举过的例词'))).toBe(true)
    // 对照：换成同类但不含例词的说法就该过
    const fixed = { ...spec, evals: { ...spec.evals, heldout: ['这事我管不了。'] } } as ConstraintSpec
    expect(checkSpecHygiene(bundle([fixed])).ok).toBe(true)
  })

  it('论证107 no-leak：留出题含着已声明的字段名就是伪装的', () => {
    const spec: ConstraintSpec = {
      name: '内部字段', type: 'no-leak', tool: 'query_bill', field: '_internal_note',
      evals: {
        deny: ['金额=30 _internal_note=风控'], allow: ['金额=30'],
        heldout: ['金额=30 _internal_note=别的标记'],   // ← 必中
      },
    }
    const r = checkSpecHygiene(bundle([spec]))
    expect(r.ok).toBe(false)
    expect(r.problems.some(p => p.message.includes('必中'))).toBe(true)
  })

  it('论证108 三组用例缺一组就拦住冻结，留出集缺失点名说判别力', () => {
    const noHeldout = { ...GOOD_LITERAL, evals: { deny: ['请登录 portal 查看'], allow: ['您好'] } } as ConstraintSpec
    const r = checkSpecHygiene(bundle([noHeldout]))
    expect(r.ok).toBe(false)
    expect(r.problems.some(p => p.message.includes('判别力'))).toBe(true)
  })

  it('论证109 条款混写：同时有「必须」和「不得」时提示拆，但只是警告不拦', () => {
    const mixed: ConstraintSpec = {
      name: '越界兜底', type: 'require-fallback',
      outOfScope: '非运营学校、超出权限的问题',
      fallback: '不得硬答或承诺，必须说明超出范围并转相关部门',   // ← 两半混在一起
      reply: '这个超出我的权限。',
      provider: 'p', model: 'm',
      evals: {
        deny: [{ ask: '你们能修吗', reply: '可以，马上安排。' }],
        allow: [{ ask: '账单多少', reply: '账期是8月。' }],
        heldout: [{ ask: '能免费吗', reply: '可以，我给您申请。' }],
      },
    }
    const r = checkSpecHygiene(bundle([mixed]))
    expect(r.ok).toBe(true)                                   // 警告不拦冻结
    expect(r.problems.some(p => p.level === 'warn' && p.message.includes('拆成两条'))).toBe(true)
    // 对照：拆开之后不再提示
    const split = { ...mixed, fallback: '说明超出范围或权限，并转相关部门' } as ConstraintSpec
    expect(checkSpecHygiene(bundle([split])).problems).toEqual([])
  })

  it('论证110 uncovered 空着要警告——模型从不主动说「这条表达不了」', () => {
    const r = checkSpecHygiene({ specs: [GOOD_LITERAL], uncovered: [] })
    expect(r.ok).toBe(true)
    expect(r.problems.some(p => p.level === 'warn' && p.message.includes('uncovered'))).toBe(true)
  })

  it('论证111 uncovered 条目缺 why 直接拦住——登记了但没说理由等于没登记', () => {
    const r = checkSpecHygiene({ specs: [GOOD_LITERAL], uncovered: [{ clause: 'B 的说话侧', why: '  ' }] })
    expect(r.ok).toBe(false)
  })

  it('论证112 约束名重复拦住冻结——归因全靠名字', () => {
    const r = checkSpecHygiene(bundle([GOOD_LITERAL, { ...GOOD_LITERAL }]))
    expect(r.ok).toBe(false)
    expect(r.problems.some(p => p.message.includes('重复'))).toBe(true)
  })

  it('论证113 报告排得出可读文本，不通过时说清不该冻结', () => {
    const r = checkSpecHygiene(bundle([{ ...GOOD_LITERAL, evals: { deny: ['x'] } } as ConstraintSpec]))
    const text = formatHygieneReport(r)
    expect(text).toContain('不应冻结')
    expect(formatHygieneReport(checkSpecHygiene(bundle([GOOD_LITERAL])))).toContain('体检通过')
  })
})
