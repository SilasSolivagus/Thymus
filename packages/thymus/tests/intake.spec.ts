/**
 * 现场前置登记的测试：把人在客户现场问出来的前提，变成收窄系统行为的事实。
 *
 * 全部静态，不调模型——这一层本来就该是零成本的。
 */
import { describe, expect, it } from 'vitest'
import {
  formatCapabilityStatement, scopeFromIntake, type Intake,
} from './thymus-src/intake.ts'
import { checkSpecHygiene, type SpecBundle } from './thymus-src/hygiene.ts'
import type { ConstraintSpec } from './thymus-src/spec.ts'

/** 一份填得比较全的登记，各用例在它上面改一处。 */
const FULL: Intake = {
  instance: '校园网客服',
  dataEgress: '允许',
  allowedModels: ['deepseek-chat'],
  systems: [],
  stakeholders: [
    { role: '决策人', name: '客服部主管' },
    { role: '业务责任人', name: '一线班组长' },
  ],
  materials: [{ title: '客户服务部作业指导书', version: '2026-06', providedBy: '客服部' }],
}

const SEMANTIC: ConstraintSpec = {
  name: 'A2 服务禁语', type: 'semantic-policy',
  policy: '不得消极推诿。', provider: 'deepseek-official', model: 'deepseek-chat',
  evals: { deny: ['这事我管不了。'], allow: ['已为您核实。'], heldout: ['您自己想办法。'] },
}
const LITERAL: ConstraintSpec = {
  name: 'A1 内部术语不外泄', type: 'forbidden-phrases', phrases: ['portal'],
  evals: { deny: ['请登录 portal 查看'], allow: ['已为您核实'], heldout: ['请登录后台管理系统'] },
}
const bundle = (specs: ConstraintSpec[]): SpecBundle => ({ specs, uncovered: [{ clause: 'x', why: 'y' }] })

describe('现场前置登记 · 收窄', () => {
  it('论证141 数据禁止出境：三种语义类型被禁用，确定性类型仍可用', () => {
    const scope = scopeFromIntake({ ...FULL, dataEgress: '禁止' })
    expect(scope.blockedTypes.sort()).toEqual(
      ['require-before-say', 'require-fallback', 'semantic-policy'])
    expect(scope.allowedTypes.sort()).toEqual(
      ['forbidden-phrases', 'no-leak', 'require-before'])
  })

  it('论证142 数据允许出境：五种类型全部可用', () => {
    const scope = scopeFromIntake(FULL)
    expect(scope.blockedTypes).toEqual([])
    expect(scope.allowedTypes).toHaveLength(6)
  })

  it('论证143 仅私有模型：类型不禁用，但没登记可用模型要提示', () => {
    const scope = scopeFromIntake({ ...FULL, dataEgress: '仅私有模型', allowedModels: [] })
    expect(scope.blockedTypes).toEqual([])
    expect(scope.gaps.some(g => g.message.includes('可用模型'))).toBe(true)
  })

  it('论证144 缺业务责任人：阻断——没有复验对象就不该冻结', () => {
    const scope = scopeFromIntake({
      ...FULL, stakeholders: [{ role: '决策人', name: '客服部主管' }],
    })
    expect(scope.gaps.some(g => g.level === '阻断' && g.message.includes('业务责任人'))).toBe(true)
  })

  it('论证145 材料缺版本或提供人：提示，不阻断——影响的是可追溯性', () => {
    const scope = scopeFromIntake({
      ...FULL, materials: [{ title: '客户服务部作业指导书' }],
    })
    const g = scope.gaps.find(x => x.message.includes('客户服务部作业指导书'))
    expect(g?.level).toBe('提示')
  })

  it('论证146 个人账号：提示——客户现场应当用服务账号', () => {
    const scope = scopeFromIntake({
      ...FULL,
      systems: [{
        name: '123 云盘后台', systemType: '自研管理后台',
        accountType: '个人账号', accessLevel: '只读明细',
      }],
    })
    expect(scope.gaps.some(g => g.message.includes('服务账号'))).toBe(true)
  })

  it('论证147 权限档决定技能生成上界', () => {
    const scope = scopeFromIntake({
      ...FULL,
      systems: [{
        name: '123 云盘后台', systemType: '自研管理后台',
        accountType: '服务账号', accessLevel: '只读聚合', approvedBy: '数据组',
      }],
    })
    expect(scope.maxAccessLevel).toBe('只读聚合')
  })
})

describe('现场前置登记 · 接进机械闸', () => {
  it('论证148 用了被禁用类型的约束，冻结前直接拦住', () => {
    const scope = scopeFromIntake({ ...FULL, dataEgress: '禁止' })
    const r = checkSpecHygiene(bundle([LITERAL, SEMANTIC]), scope)
    expect(r.ok).toBe(false)
    expect(r.problems.some(p => p.spec === 'A2 服务禁语' && p.message.includes('前提'))).toBe(true)
    // 确定性那条不受影响
    expect(r.problems.some(p => p.spec === 'A1 内部术语不外泄' && p.level === 'error')).toBe(false)
  })

  it('论证149 不传收窄结果时，机械闸行为与从前一致', () => {
    expect(checkSpecHygiene(bundle([LITERAL, SEMANTIC])).ok).toBe(true)
  })
})

describe('现场前置登记 · 能力边界说明', () => {
  it('论证150 说明里同时有「不能做什么」与「尚未确认的前提」', () => {
    const intake: Intake = { ...FULL, materials: [{ title: '作业指导书' }], dataEgress: '禁止' }
    const text = formatCapabilityStatement(intake, scopeFromIntake(intake))
    expect(text).toContain('不能做什么')
    expect(text).toContain('尚未确认的前提')
    expect(text).toContain('语义')          // 被禁用的能力要写出来
  })
})
