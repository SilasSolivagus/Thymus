/**
 * 线上回流的三条纪律。全部静态，不调模型。
 *
 * 这三条不是设计出来的，是实测逼出来的：留出用例一旦进了写规矩那方的视野，
 * 之后测的就是照差异改，不是泛化；措辞是未受控变量，为新样本改一句话很容易把旧的
 * 弄坏。所以分流要确定性、留出侧不给看内容、每次改完与上一版比。
 */
import { describe, expect, it } from 'vitest'
import {
  applyBadCases, compareReports, formatRegression, redactHeldout, splitBadCases,
  type BadCase,
} from './thymus-src/badcase.ts'
import type { ConstraintSpec, SpecEvalReport } from './thymus-src/spec.ts'

const mk = (say: string, verdict: BadCase['verdict'] = 'deny', spec = '服务禁语'): BadCase => ({
  spec, say, verdict,
  source: { sessionId: 's-1', seq: 7 },
  by: '标注员甲', at: '2026-08-24',
})

const CASES: BadCase[] = [
  mk('这事我管不了。'),
  mk('您自己再试试吧。'),
  mk('我又不是修网络的。'),
  mk('别问了，我没法弄。'),
  mk('已为您核实，账期是8月。', 'allow'),
  mk('这边帮您登记一下。', 'allow'),
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
    expect(a.open.map(c => c.say)).toEqual(b.open.map(c => c.say))
    expect(a.heldout.map(c => c.say)).toEqual(b.heldout.map(c => c.say))
  })

  it('论证134 分流只看内容：换顺序、换标注人都不改变落在哪一侧', () => {
    const base = splitBadCases(CASES)
    const shuffled = splitBadCases([...CASES].reverse().map(c => ({ ...c, by: '标注员乙' })))
    expect(new Set(shuffled.heldout.map(c => c.say))).toEqual(new Set(base.heldout.map(c => c.say)))
  })

  it('论证135 换 salt 等于重新洗牌——所以换之前要想清楚', () => {
    const a = splitBadCases(CASES, { salt: '2026Q3' })
    const b = splitBadCases(CASES, { salt: '2026Q4' })
    expect(a.heldout.map(c => c.say)).not.toEqual(b.heldout.map(c => c.say))
  })

  it('论证136 留出占比大致守得住', () => {
    const many = Array.from({ length: 400 }, (_v, i) => mk(`第${i}条不同的说法。`))
    const { heldout } = splitBadCases(many, { holdoutRatio: 0.25 })
    expect(heldout.length).toBeGreaterThan(60)
    expect(heldout.length).toBeLessThan(140)
  })

  it('论证137 并入：公开侧按判定归组，留出侧的 deny 进留出集', () => {
    const split = splitBadCases(CASES)
    const [merged] = applyBadCases([SPEC], split) as [ConstraintSpec & { evals: Record<string, string[]> }]
    for (const c of split.open.filter(x => x.verdict === 'deny')) {
      expect(merged.evals.deny).toContain(c.say)
    }
    for (const c of split.heldout.filter(x => x.verdict === 'deny')) {
      expect(merged.evals.heldout).toContain(c.say)
      expect(merged.evals.deny).not.toContain(c.say)      // 留出侧的不能同时出现在公开侧
    }
  })

  it('论证138 留出侧的 allow 照样进 allow——放行类样本藏起来没有意义', () => {
    const split = splitBadCases(CASES)
    const [merged] = applyBadCases([SPEC], split) as [ConstraintSpec & { evals: Record<string, string[]> }]
    for (const c of CASES.filter(x => x.verdict === 'allow')) {
      expect(merged.evals.allow).toContain(c.say)
      expect(merged.evals.heldout).not.toContain(c.say)
    }
  })

  it('论证139 并入不重复、不改原对象', () => {
    const split = splitBadCases(CASES)
    const once = applyBadCases([SPEC], split)
    const twice = applyBadCases(once, split)
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once))
    expect(SPEC.evals?.deny).toEqual(['这个不可能。'])    // 原对象没被动过
  })

  it('论证140 别的类型原样返回——用例形状不同，不硬并', () => {
    const seq: ConstraintSpec = {
      name: '认人前置', type: 'require-before', requires: 'lookup_account',
      evals: { deny: [{ before: [], call: 'query_bill' }] },
    }
    const [out] = applyBadCases([seq], splitBadCases(CASES))
    expect(out).toBe(seq)
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
