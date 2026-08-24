/**
 * 冻结前的机械闸：一份声明能不能拿去冻结，先过这一道。
 *
 * 这一层的存在理由是实测出来的，不是设计出来的。一份声明交付时，人真正不可替代的
 * 只有四件事：写留出集、把混在一起的条款拆开、判定「这条表达不了」、调措辞。
 * 前三件里有相当一部分**能机械检出**，检出来就不用靠人一遍遍复核：
 *
 *   - 留出集伪装 —— 出题方（无论是人还是模型）会写出「看着像留出、实际是必拦」的题。
 *     实测：模型写的字面词表留出集，3 次里 2 次直接含着已声明的禁语（那种题必中，
 *     判别力为零）。这一类可以逐类型机械判。
 *   - 条款混写 —— 一条 SOP 条款里同时有「什么时候必须做什么」和「什么时候都不许做
 *     什么」时，写成一条声明会让无条件那半被有条件那半吃掉（实测：留出 3–4/5，
 *     拆开后 5/5）。文本里同时出现两类词就该提示拆。
 *   - 「这条表达不了」—— 模型从不主动说这句。所以把它变成必填项：声明文件带一个
 *     `uncovered` 清单，空着就警告。
 *
 * 全部不花钱、不调模型、纯静态。跑不过就不该冻结。
 *
 * @module thymus/hygiene
 */
import type { ConstraintSpec } from './spec.ts'

/** 一条填不进内置类型的条款。登记它，而不是假装填满了。 */
export interface UncoveredClause {
  /** SOP 里的哪一句。 */
  clause: string
  /** 为什么表达不了，以及现在用什么顶着。 */
  why: string
}

/** 一份可交付的声明：约束本身，加上明确登记的覆盖缺口。 */
export interface SpecBundle {
  specs: ConstraintSpec[]
  /**
   * 表达不了的条款。**允许为空但会警告**——一份真实 SOP 一条都不漏是不太可能的，
   * 空着更可能是没找，而不是没有。
   */
  uncovered: UncoveredClause[]
}

/** 一条体检结论。`error` 拦住冻结，`warn` 只提示。 */
export interface HygieneProblem {
  level: 'error' | 'warn'
  /** 出问题的声明名；整份的问题不带这个字段。 */
  spec?: string
  message: string
}

/** 体检报告。`ok` 为假就不该冻结。 */
export interface HygieneReport {
  ok: boolean
  problems: HygieneProblem[]
}

/** 表示义务的词。 */
const MUST = ['必须', '应当', '需要先', '才能', '要先']
/** 表示禁止的词。 */
const MUST_NOT = ['不得', '禁止', '不许', '不可以', '严禁']

/** 从一段策略文本里取「」或「"」括起来的例词。 */
function quotedExamples(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(/[「“"']([^」”"']{1,20})[」”"']/g)) {
    const w = m[1]?.trim()
    if (w !== undefined && w.length > 0) out.push(w)
  }
  return out
}

/** 这条声明里所有自然语言字段，拼起来做条款混写检查。 */
function proseOf(spec: ConstraintSpec): string {
  const parts: string[] = []
  if (spec.type === 'semantic-policy') parts.push(spec.policy)
  if (spec.type === 'require-fallback') parts.push(spec.outOfScope, spec.fallback)
  if (spec.type === 'require-before' && spec.reason !== undefined) parts.push(spec.reason)
  return parts.join('\n')
}

/** 三组用例各有多少条。类型不同形状不同，这里只数数量。 */
function evalCounts(spec: ConstraintSpec): { deny: number; allow: number; heldout: number } {
  const e = (spec as unknown as { evals?: Record<string, unknown[]> }).evals
  return {
    deny: e?.deny?.length ?? 0,
    allow: e?.allow?.length ?? 0,
    heldout: e?.heldout?.length ?? 0,
  }
}

/**
 * 逐类型检出**伪装的留出用例**：看着像留出，实际必中或必不中，判别力为零。
 *
 * 每种类型的检法不同，因为「字面重合」在每种类型里的含义不同：
 *   `forbidden-phrases` —— 留出题里直接含着已声明的词，必中
 *   `no-leak`           —— 留出题里直接含着已声明的字段名，必中
 *   `require-before`    —— 留出题调的工具在免检名单里，必不中（死题）
 *   `semantic-policy`   —— 留出题直接用了 policy 里引号举过的例词
 *   `require-fallback`  —— 留出题的回复与某条必拦用例逐字相同
 */
function fakeHeldout(spec: ConstraintSpec): string[] {
  const bad: string[] = []
  if (spec.type === 'forbidden-phrases') {
    const norm = (s: string): string => (spec.ignoreCase ?? true) ? s.toLowerCase() : s
    for (const t of spec.evals?.heldout ?? []) {
      const hit = spec.phrases.find(p => norm(t).includes(norm(p)))
      if (hit !== undefined) bad.push(`「${t}」直接含着已声明的词「${hit}」——这条必中`)
    }
    return bad
  }
  if (spec.type === 'no-leak') {
    for (const t of spec.evals?.heldout ?? []) {
      if (t.includes(`${spec.field}=`)) bad.push(`「${t}」直接含着已声明的字段「${spec.field}=」——这条必中`)
    }
    return bad
  }
  if (spec.type === 'require-before') {
    const exempt = new Set([...spec.unguarded ?? [], spec.requires])
    for (const c of spec.evals?.heldout ?? []) {
      if (exempt.has(c.call)) bad.push(`「${c.call}」在免检名单里——这条必不中，是死用例`)
    }
    return bad
  }
  if (spec.type === 'semantic-policy') {
    const examples = quotedExamples(spec.policy)
    for (const t of spec.evals?.heldout ?? []) {
      const hit = examples.find(w => t.includes(w))
      if (hit !== undefined) bad.push(`「${t}」直接用了 policy 里举过的例词「${hit}」——不算留出`)
    }
    return bad
  }
  const denies = new Set((spec.evals?.deny ?? []).map(c => c.reply))
  for (const c of spec.evals?.heldout ?? []) {
    if (denies.has(c.reply)) bad.push(`回复「${c.reply}」与某条必拦用例逐字相同——不算留出`)
  }
  return bad
}

/**
 * 冻结前的机械体检。全部静态，不调模型。
 *
 * @param bundle - 待冻结的声明与它登记的覆盖缺口。
 * @returns 体检报告；`ok` 为假时不应冻结。
 */
export function checkSpecHygiene(bundle: SpecBundle): HygieneReport {
  const problems: HygieneProblem[] = []
  const seen = new Set<string>()

  for (const spec of bundle.specs) {
    // 归因全靠名字，重名会让报告说不清是谁的问题。
    if (seen.has(spec.name)) problems.push({ level: 'error', spec: spec.name, message: '约束名重复' })
    seen.add(spec.name)

    const n = evalCounts(spec)
    if (n.deny === 0) problems.push({ level: 'error', spec: spec.name, message: '没有必拦用例——这条声明没法验收' })
    if (n.allow === 0) problems.push({ level: 'error', spec: spec.name, message: '没有必放用例——过度拦截只有这一组抓得住' })
    if (n.heldout === 0) {
      problems.push({
        level: 'error', spec: spec.name,
        message: '没有留出用例——判别力全在这一组，缺了这份声明等于没验收',
      })
    }

    for (const why of fakeHeldout(spec)) {
      problems.push({ level: 'error', spec: spec.name, message: `留出用例是伪装的：${why}` })
    }

    const prose = proseOf(spec)
    const must = MUST.filter(w => prose.includes(w))
    const mustNot = MUST_NOT.filter(w => prose.includes(w))
    if (must.length > 0 && mustNot.length > 0) {
      problems.push({
        level: 'warn', spec: spec.name,
        message: `条款文本里同时有义务（${must.join('、')}）和禁止（${mustNot.join('、')}）——`
          + '这两半通常要拆成两条声明，写成一条会让无条件那半被有条件那半吃掉',
      })
    }
  }

  if (bundle.specs.length === 0) problems.push({ level: 'error', message: '这份声明是空的' })
  if (bundle.uncovered.length === 0) {
    problems.push({
      level: 'warn',
      message: 'uncovered 是空的——一份真实 SOP 一条都表达不了的情况很少见，'
        + '空着更可能是没找，而不是没有',
    })
  }
  for (const u of bundle.uncovered) {
    if (u.clause.trim() === '' || u.why.trim() === '') {
      problems.push({ level: 'error', message: 'uncovered 里有条目缺 clause 或 why' })
    }
  }

  return { ok: !problems.some(p => p.level === 'error'), problems }
}

/**
 * 把体检报告排成一段可读文本。
 * @param report - {@link checkSpecHygiene} 的结果。
 * @returns 可以直接贴进交付记录的文本。
 */
export function formatHygieneReport(report: HygieneReport): string {
  if (report.problems.length === 0) return '✓ 体检通过，没有发现问题'
  const lines = report.problems.map(p =>
    `${p.level === 'error' ? '✗' : '·'} ${p.spec === undefined ? '' : `${p.spec}：`}${p.message}`)
  const errors = report.problems.filter(p => p.level === 'error').length
  const head = report.ok
    ? `✓ 体检通过（${report.problems.length} 条提示）`
    : `✗ 体检不通过：${errors} 个错误，不应冻结`
  return [head, ...lines].join('\n')
}
