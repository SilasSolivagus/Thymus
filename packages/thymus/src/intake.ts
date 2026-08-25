/**
 * 现场前置登记：把人在客户现场问出来的前提，变成收窄系统行为的事实。
 *
 * 有一类工作永远是人的——安全评审、权限申请、干系人梳理、材料清点。它们不该进系统，
 * **但它们的产出是结构化事实，事实要进系统，并反过来约束系统允许做的事**。
 * 这与把 SOP 条款编译成约束声明是同一个动作，只是对象换成了现场前提。
 *
 * 最要紧的一条是数据能否出境。语义类约束每句都要把内容发给模型判定；客户若不允许，
 * 那几类约束**不是"效果差一点"，是根本不可用**。这是范围前提，必须在写第一条声明之前
 * 就问清楚，而不是等验收时才发现。
 *
 * 全部静态，不调模型。
 *
 * @module thymus/intake
 */
import type { ConstraintSpec } from './spec.ts'

/** 业务内容能否发往外部模型。 */
export type DataEgress = '允许' | '禁止' | '仅私有模型'

/** 已获批的权限档。按 只读聚合 → 只读明细 → 可写 逐档申请。 */
export type AccessLevel = '只读聚合' | '只读明细' | '可写'

/** 干系人角色。缺业务责任人则无法指定复验对象。 */
export type StakeholderRole = '决策人' | '业务责任人' | '数据责任人' | '安全对接人'

/** 一个已获批接入的系统。 */
export interface IntakeSystem {
  name: string
  /** 系统型号。登记表按型号归档，同型号在下一个客户处可直接套用。 */
  systemType: string
  accountType: '个人账号' | '服务账号'
  accessLevel: AccessLevel
  approvedBy?: string
  approvedAt?: string
}

export interface Stakeholder { role: StakeholderRole; name: string }

/** 一份材料的来源。缺版本或提供人则条款不可追溯。 */
export interface Material { title: string; version?: string; providedBy?: string; receivedAt?: string }

/** 一个实例的现场前提。每个实例有且只有一份。 */
export interface Intake {
  instance: string
  dataEgress: DataEgress
  /** 允许用于判定的模型。与既有验收所用模型不一致时，已有判定数字作废。 */
  allowedModels: string[]
  logRetention?: string
  systems: IntakeSystem[]
  stakeholders: Stakeholder[]
  materials: Material[]
  /** 对话入口渠道。本期不做接入，仅登记。 */
  channel?: string
}

/** 前提未登记或不合规之处。`阻断` 使声明不得冻结。 */
export interface ScopeGap { level: '阻断' | '提示'; message: string }

/** 前提收窄出来的可做范围。 */
export interface Scope {
  allowedTypes: ConstraintSpec['type'][]
  /** 因前提而不可用的类型。用了它们的约束不该冻结，也不该假装能上线。 */
  blockedTypes: ConstraintSpec['type'][]
  /** 技能生成的上界；没有接入任何系统时为 undefined。 */
  maxAccessLevel?: AccessLevel
  gaps: ScopeGap[]
}

/** 六种内置类型。 */
const ALL_TYPES: ConstraintSpec['type'][] = [
  'forbidden-phrases', 'semantic-policy', 'no-leak',
  'require-before', 'require-fallback', 'require-before-say',
]

/**
 * 判定要调模型的三类。数据不可出境时它们整类不可用——
 * 不是降级，是没有。
 */
const MODEL_DEPENDENT: ConstraintSpec['type'][] = [
  'semantic-policy', 'require-fallback', 'require-before-say',
]

const RANK: Record<AccessLevel, number> = { '只读聚合': 1, '只读明细': 2, '可写': 3 }

/**
 * 由前提算出可做范围。纯函数。
 *
 * @param intake - 现场前置登记。
 * @returns 可用类型、被禁类型、技能生成上界，以及前提本身的缺口。
 */
export function scopeFromIntake(intake: Intake): Scope {
  const blocked = intake.dataEgress === '禁止' ? [...MODEL_DEPENDENT] : []
  const gaps: ScopeGap[] = []

  if (intake.dataEgress !== '禁止' && intake.allowedModels.length === 0) {
    gaps.push({ level: '提示', message: '未登记可用模型——换模型会使已有的判定数字作废，应当写明' })
  }
  if (!intake.stakeholders.some(s => s.role === '业务责任人')) {
    gaps.push({ level: '阻断', message: '未登记业务责任人——无法指定复验对象，声明不得冻结' })
  }
  if (intake.materials.length === 0) {
    gaps.push({ level: '提示', message: '未登记材料来源——条款无法追溯到出处' })
  }
  for (const m of intake.materials) {
    if (m.version === undefined || m.providedBy === undefined) {
      gaps.push({ level: '提示', message: `材料「${m.title}」缺版本或提供人——引用它的条款无法追溯` })
    }
  }
  for (const sys of intake.systems) {
    if (sys.accountType === '个人账号') {
      gaps.push({
        level: '提示',
        message: `${sys.name} 登记为个人账号——客户现场应当使用服务账号，个人账号会因离职、改密、网络策略失效且责任不清`,
      })
    }
  }

  const levels = intake.systems.map(s => s.accessLevel)
  const maxAccessLevel = levels.length === 0
    ? undefined
    : levels.reduce((a, b) => RANK[a] >= RANK[b] ? a : b)

  return {
    allowedTypes: ALL_TYPES.filter(t => !blocked.includes(t)),
    blockedTypes: blocked,
    ...maxAccessLevel === undefined ? {} : { maxAccessLevel },
    gaps,
  }
}

/** 类型的中文说法，写进给客户看的说明里。 */
const TYPE_LABEL: Record<ConstraintSpec['type'], string> = {
  'forbidden-phrases': '字面禁语（精确列举的说法）',
  'semantic-policy': '语义策略（无精确边界的条款，需模型判定）',
  'no-leak': '内部字段抹除（产出交给模型之前）',
  'require-before': '调用前置（未满足前提则拒绝调用）',
  'require-fallback': '越界兜底（超出范围须说明并转出，需模型判定）',
  'require-before-say': '说话前置（前提未成立不得答复某类内容，需模型判定）',
}

/**
 * 生成能力边界说明——交付给客户安全与法务的那一份。
 *
 * 现场被问「你们这个能做到什么程度」时，回答通常是口头的、事后无据。这份说明把它写死：
 * 能做什么、不能做什么、还有哪些前提没确认。
 *
 * @param intake - 现场前置登记。
 * @param scope - {@link scopeFromIntake} 的结果。
 * @returns 可直接交付的 markdown。
 */
export function formatCapabilityStatement(intake: Intake, scope: Scope): string {
  const lines: string[] = []
  lines.push(`# 能力边界说明 · ${intake.instance}`)
  lines.push('依据现场确认的前提生成。前提变更时，已冻结的声明须重新验收。', '')

  lines.push('## 前提')
  lines.push(`- 业务内容发往外部模型：${intake.dataEgress}`)
  lines.push(`- 可用于判定的模型：${intake.allowedModels.join('、') || '未登记'}`)
  if (intake.logRetention !== undefined) lines.push(`- 日志留存：${intake.logRetention}`)
  lines.push(intake.systems.length === 0
    ? '- 接入系统：无'
    : `- 接入系统：${intake.systems.map(s => `${s.name}（${s.accountType}，${s.accessLevel}）`).join('；')}`)
  lines.push(intake.materials.length === 0
    ? '- 材料：未登记'
    : `- 材料：${intake.materials.map(m => `${m.title}${m.version === undefined ? '' : ` ${m.version}`}`).join('；')}`)
  lines.push('')

  lines.push('## 这套系统能做什么')
  for (const t of scope.allowedTypes) lines.push(`- ${TYPE_LABEL[t]}`)
  if (scope.maxAccessLevel !== undefined) {
    lines.push(`- 数据查询上界：${scope.maxAccessLevel}（更高权限须另行申请）`)
  }
  lines.push('')

  lines.push('## 不能做什么')
  if (scope.blockedTypes.length > 0) {
    lines.push('受前提限制，以下能力不可用——这是范围，不是缺陷：')
    for (const t of scope.blockedTypes) lines.push(`- ${TYPE_LABEL[t]}`)
    lines.push('要覆盖这些条款，需要客户提供可用于判定的私有模型。')
  } else {
    lines.push('- 未列进声明的同义说法，字面类约束拦不住；覆盖它们依赖语义判定。')
    lines.push('- 语义判定依赖模型，存在概率性漏判：冻结前多轮判定并要求结果一致。')
  }
  lines.push('')

  lines.push('## 尚未确认的前提')
  if (scope.gaps.length === 0) lines.push('- 无')
  for (const g of scope.gaps) lines.push(`- 【${g.level}】${g.message}`)
  return lines.join('\n')
}
