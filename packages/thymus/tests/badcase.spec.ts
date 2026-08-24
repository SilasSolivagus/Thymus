/**
 * 线上回流的三条纪律。全部静态，不调模型。
 *
 * 这三条不是设计出来的，是实测逼出来的：留出用例一旦进了写规矩那方的视野，
 * 之后测的就是照差异改，不是泛化；措辞是未受控变量，为新样本改一句话很容易把旧的
 * 弄坏。所以分流要确定性、留出侧不给看内容、每次改完与上一版比。
 */
import { describe, expect, it } from 'vitest'
import {
  applyBadCases, compareReports, formatRegression, redactHeldout, sampleIdentity, splitBadCases,
  type BadCase,
} from './thymus-src/badcase.ts'
import type { ConstraintSpec, SpecEvalReport } from './thymus-src/spec.ts'

const mk = (sample: BadCase['sample'], verdict: BadCase['verdict'] = 'deny', spec = '服务禁语'): BadCase => ({
  spec, sample, verdict,
  source: { sessionId: 's-1', seq: 7 },
  by: '标注员甲', at: '2026-08-24',
})

/** 说话类样本的简写。 */
const say = (t: string, verdict: BadCase['verdict'] = 'deny', spec = '服务禁语'): BadCase =>
  mk({ kind: 'say', say: t }, verdict, spec)

const CASES: BadCase[] = [
  say('这事我管不了。'),
  say('您自己再试试吧。'),
  say('我又不是修网络的。'),
  say('别问了，我没法弄。'),
  say('已为您核实，账期是8月。', 'allow'),
  say('这边帮您登记一下。', 'allow'),
]

const SPEC: ConstraintSpec = {
  name: '服务禁语', type: 'semantic-policy',
  policy: '不得出现态度消极、甩锅推诿的表达。',
  provider: 'p', model: 'm',
  evals: { deny: ['这个不可能。'], allow: ['您好。'], heldout: ['我帮不了您。'] },
}

const report = (name: string, deny: number, allow: number, heldout: number): SpecEvalReport => ({
  name, type: 'semantic-policy', missingEvals: false,
  deny: { caught: deny, total: 4, missed: [] },
  allow: { kept: allow, total: 4, overreached: [] },
  heldout: { caught: heldout, total: 4, missed: ['甲', '乙'] },
  ok: true,
})

describe('线上回流 · 分流、遮挡、回归', () => {
  it('论证133 分流是确定性的：同一批样本反复分，结果一模一样', () => {
    const a = splitBadCases(CASES)
    const b = splitBadCases(CASES)
    expect(a.open.map(c => sampleIdentity(c.sample))).toEqual(b.open.map(c => sampleIdentity(c.sample)))
    expect(a.heldout.map(c => sampleIdentity(c.sample))).toEqual(b.heldout.map(c => sampleIdentity(c.sample)))
  })

  it('论证134 分流只看内容：换顺序、换标注人都不改变落在哪一侧', () => {
    const base = splitBadCases(CASES)
    const shuffled = splitBadCases([...CASES].reverse().map(c => ({ ...c, by: '标注员乙' })))
    expect(new Set(shuffled.heldout.map(c => sampleIdentity(c.sample))))
      .toEqual(new Set(base.heldout.map(c => sampleIdentity(c.sample))))
  })

  it('论证135 换 salt 等于重新洗牌——所以换之前要想清楚', () => {
    const a = splitBadCases(CASES, { salt: '2026Q3' })
    const b = splitBadCases(CASES, { salt: '2026Q4' })
    expect(a.heldout.map(c => sampleIdentity(c.sample))).not.toEqual(b.heldout.map(c => sampleIdentity(c.sample)))
  })

  it('论证136 留出占比大致守得住', () => {
    const many = Array.from({ length: 400 }, (_v, i) => say(`第${i}条不同的说法。`))
    const { heldout } = splitBadCases(many, { holdoutRatio: 0.25 })
    expect(heldout.length).toBeGreaterThan(60)
    expect(heldout.length).toBeLessThan(140)
  })

  it('论证137 并入：公开侧按判定归组，留出侧的 deny 进留出集', () => {
    const split = splitBadCases(CASES)
    const merged = applyBadCases([SPEC], split).specs[0] as ConstraintSpec & { evals: Record<string, string[]> }
    const text = (c: BadCase): string => (c.sample as { say: string }).say
    for (const c of split.open.filter(x => x.verdict === 'deny')) {
      expect(merged.evals.deny).toContain(text(c))
    }
    for (const c of split.heldout.filter(x => x.verdict === 'deny')) {
      expect(merged.evals.heldout).toContain(text(c))
      expect(merged.evals.deny).not.toContain(text(c))      // 留出侧的不能同时出现在公开侧
    }
  })

  it('论证138 留出侧的 allow 照样进 allow——放行类样本藏起来没有意义', () => {
    const split = splitBadCases(CASES)
    const merged = applyBadCases([SPEC], split).specs[0] as ConstraintSpec & { evals: Record<string, string[]> }
    for (const c of CASES.filter(x => x.verdict === 'allow')) {
      const t = (c.sample as { say: string }).say
      expect(merged.evals.allow).toContain(t)
      expect(merged.evals.heldout).not.toContain(t)
    }
  })

  it('论证139 并入不重复、不改原对象', () => {
    const split = splitBadCases(CASES)
    const once = applyBadCases([SPEC], split).specs
    const twice = applyBadCases(once, split).specs
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once))
    expect(SPEC.evals?.deny).toEqual(['这个不可能。'])    // 原对象没被动过
  })

  it('论证140 形状对不上的样本不硬并，而且会被报出来', () => {
    const seq: ConstraintSpec = {
      name: '认人前置', type: 'require-before', requires: 'lookup_account',
      evals: { deny: [{ before: [], call: 'query_bill' }] },
    }
    const wrong = say('这事我管不了。', 'deny', '认人前置')      // 说话类样本错归到工具侧约束
    const { specs, skipped } = applyBadCases([seq], splitBadCases([wrong]))
    expect(specs[0]).toBe(seq)                                  // 声明没被动过
    expect(skipped).toHaveLength(1)
    expect(skipped[0]!.why).toContain('tool-call')              // 说清它认的是哪种
  })

  it('论证141a 归到不存在的约束上也要报，不能静默丢', () => {
    const { skipped } = applyBadCases([SPEC], splitBadCases([say('随便一句', 'deny', '不存在的约束')]))
    expect(skipped).toHaveLength(1)
    expect(skipped[0]!.why).toContain('没有叫')
  })

  it('论证141b 工具侧样本并得进去：no-leak 收产出原文，require-before 收调用序列', () => {
    const noleak: ConstraintSpec = {
      name: '内部字段', type: 'no-leak', tool: 'query_bill', field: '_internal_note',
      evals: { deny: ['金额=30 _internal_note=风控'] },
    }
    const seq: ConstraintSpec = {
      name: '认人前置', type: 'require-before', requires: 'lookup_account',
      evals: { deny: [{ before: [], call: 'query_bill' }] },
    }
    const cases: BadCase[] = [
      mk({ kind: 'tool-output', text: '金额=45 _internal_note=已升级投诉' }, 'deny', '内部字段'),
      mk({ kind: 'tool-call', before: [], call: 'export_invoice' }, 'deny', '认人前置'),
      mk({ kind: 'tool-call', before: ['lookup_account'], call: 'query_bill' }, 'allow', '认人前置'),
    ]
    // 全塞进公开侧，好逐条核对归组
    const { specs, skipped } = applyBadCases([noleak, seq], { open: cases, heldout: [] })
    expect(skipped).toEqual([])
    const a = specs[0] as ConstraintSpec & { evals: Record<string, unknown[]> }
    const b = specs[1] as ConstraintSpec & { evals: Record<string, unknown[]> }
    expect(a.evals.deny).toContain('金额=45 _internal_note=已升级投诉')
    expect(b.evals.deny).toContainEqual({ before: [], call: 'export_invoice' })
    expect(b.evals.allow).toContainEqual({ before: ['lookup_account'], call: 'query_bill' })
  })

  it('论证141c 事实是集合：记录顺序不同的同一条样本落在同一侧', () => {
    const a = mk({ kind: 'tool-call', before: ['x', 'y'], call: 'query_bill' }, 'deny', '认人前置')
    const b = mk({ kind: 'tool-call', before: ['y', 'x'], call: 'query_bill' }, 'deny', '认人前置')
    expect(sampleIdentity(a.sample)).toBe(sampleIdentity(b.sample))
    expect(splitBadCases([a]).heldout.length).toBe(splitBadCases([b]).heldout.length)
  })

  it('论证141d 五种形状的身份互不相同——不同通道的样本不会混成一条', () => {
    const ids = [
      sampleIdentity({ kind: 'say', say: 'x' }),
      sampleIdentity({ kind: 'fact-say', before: [], say: 'x' }),
      sampleIdentity({ kind: 'dialogue', ask: 'x', reply: 'x' }),
      sampleIdentity({ kind: 'tool-output', text: 'x' }),
      sampleIdentity({ kind: 'tool-call', before: [], call: 'x' }),
    ]
    expect(new Set(ids).size).toBe(5)
  })

  it('论证141 遮挡：留出集只报数量，原文不出现在报告里', () => {
    const [r] = redactHeldout([report('服务禁语', 3, 4, 2)])
    expect(r!.heldout.caught).toBe(2)
    expect(r!.heldout.missed.join()).not.toContain('甲')
    expect(r!.heldout.missed[0]).toContain('内容不显示')
  })

  it('论证142 回归：任一组掉了都算，包括留出集', () => {
    const before = [report('A', 4, 4, 4), report('B', 3, 4, 2)]
    expect(compareReports(before, [report('A', 4, 4, 4), report('B', 3, 4, 2)]).ok).toBe(true)
    expect(compareReports(before, [report('A', 4, 4, 3), report('B', 3, 4, 2)]).ok).toBe(false)
    expect(compareReports(before, [report('A', 4, 3, 4), report('B', 3, 4, 2)]).ok).toBe(false)
    expect(compareReports(before, [report('A', 3, 4, 4), report('B', 3, 4, 2)]).ok).toBe(false)
  })

  it('论证143 涨了不算回归，但会报出来', () => {
    const r = compareReports([report('A', 3, 4, 2)], [report('A', 4, 4, 3)])
    expect(r.ok).toBe(true)
    expect(formatRegression(r)).toContain('必拦 +1')
    expect(formatRegression(r)).toContain('留出 +1')
  })

  it('论证144 上一版有、这一版没有的约束算回归——悄悄删掉一条不能算通过', () => {
    const r = compareReports([report('A', 4, 4, 4), report('B', 4, 4, 4)], [report('A', 4, 4, 4)])
    expect(r.ok).toBe(false)
    expect(r.missing).toEqual(['B'])
    expect(formatRegression(r)).toContain('上一版有、这一版没有')
  })
})
