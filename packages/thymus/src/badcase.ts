/**
 * 线上回流：把人工标注过的 bad case 并进评测集，而**不把评测集磨钝**。
 *
 * 这一层解决的是留出集的来源问题。判别力全在留出集，而留出集要求「语义同类、
 * 字面不重叠」——凭空想很难，线上真实说法是天然的来源：用户真的那么说了，
 * 而 SOP 原文没列过。
 *
 * 但直接并进去会毁掉评测集，理由是实测过的：**留出用例一旦进了写规矩那方的视野，
 * 之后测的就是照差异改，不是泛化**。每天捞、每天照着改，几轮之后「改过的都能过」，
 * 判别力归零。所以这里有三条机械纪律：
 *
 *   1. **分流是确定性的**（按内容哈希），同一条样本永远落在同一侧。
 *      不能反复重抽直到自己满意——那等于自己给自己发考卷。
 *   2. **留出侧只报数字与出处，不报原文**（{@link redactHeldout}）。改规矩的人
 *      看得到「留出掉了 2 条」，看不到那两条是什么，只能改规矩本身。
 *   3. **每次改完与上一版比**（{@link compareReports}），掉了就报——措辞是未受控变量，
 *      为新样本改一句话很容易把旧的弄坏。
 *
 * 有一件这一层不做也做不了：**「这条算不算违规」必须人判**。线上流量没有标准答案，
 * 让模型标就回到「自己出题自己打分」。所以 {@link BadCase.verdict} 是必填的人工字段。
 *
 * @module thymus/badcase
 */
import type { ConstraintSpec, SpecEvalReport } from './spec.ts'

/**
 * 一条线上样本的内容。**形状跟着声明类型走**——工具侧和说话侧的用例本来就不是一回事，
 * 硬塞进一个字段会让并入时无从归组。
 *
 *   `say`         —— 一句说给用户的话（`forbidden-phrases` / `semantic-policy`）
 *   `fact-say`    —— 会话事实加一句话（`require-before-say`）
 *   `dialogue`    —— 用户问的那句加 agent 回的那句（`require-fallback`）
 *   `tool-output` —— 工具产出的原文（`no-leak`）
 *   `tool-call`   —— 已成立的事实加这一次调用（`require-before`）
 */
export type BadCaseSample =
  | { kind: 'say'; say: string }
  | { kind: 'fact-say'; before: string[]; say: string }
  | { kind: 'dialogue'; ask: string; reply: string }
  | { kind: 'tool-output'; text: string }
  | { kind: 'tool-call'; before: string[]; call: string }

/** 一条人工标注过的线上样本。 */
export interface BadCase {
  /** 归到哪条约束——用约束名，与声明里的 `name` 对上。 */
  spec: string
  /** 样本内容，形状随声明类型而定。 */
  sample: BadCaseSample
  /**
   * **人的判定**：这条该拦（`deny`）还是该原样放行（`allow`）。
   * 这一栏没有自动化的余地——线上流量没有标准答案，模型标就回到自己给自己打分。
   */
  verdict: 'deny' | 'allow'
  /** 出处，用来回到现场。 */
  source: { sessionId: string; seq?: number }
  /** 谁标的、什么时候标的。留出侧只报这个，不报原文。 */
  by: string
  at: string
}

/**
 * 一条样本的身份：分流按它算，去重也按它算。
 *
 * `tool-call` 的 `before` 先排序再拼——事实是个集合，顺序不该改变身份，
 * 否则同一条样本换个记录顺序就会落到另一侧。
 */
export function sampleIdentity(sample: BadCaseSample): string {
  switch (sample.kind) {
    case 'say': return `say:${sample.say}`
    case 'fact-say': return `fact-say:${[...sample.before].sort().join('+')}|${sample.say}`
    case 'dialogue': return `dialogue:${sample.ask}|${sample.reply}`
    case 'tool-output': return `tool-output:${sample.text}`
    case 'tool-call': return `tool-call:${[...sample.before].sort().join('+')}|${sample.call}`
  }
}

/** 声明类型认得哪种样本。形状对不上的样本不会被硬并进去。 */
const ACCEPTS: Record<ConstraintSpec['type'], BadCaseSample['kind']> = {
  'forbidden-phrases': 'say',
  'semantic-policy': 'say',
  'require-before-say': 'fact-say',
  'require-fallback': 'dialogue',
  'no-leak': 'tool-output',
  'require-before': 'tool-call',
}

/** 没能并进去的样本，以及原因。 */
export interface SkippedCase {
  case: BadCase
  why: string
}

/** 并入结果。 */
export interface ApplyResult {
  specs: ConstraintSpec[]
  /** **没并进去的样本**。静默丢弃等于样本没了而评测集看着照样绿，所以一律报出来。 */
  skipped: SkippedCase[]
}

/** 分流结果。 */
export interface BadCaseSplit {
  /** 公开侧：写规矩的人可以看，用来改。 */
  open: BadCase[]
  /** 留出侧：不给写规矩那方看内容，只看数字。 */
  heldout: BadCase[]
}

/** FNV-1a：够用的确定性哈希。不要求密码学强度，只要求同一条样本每次落在同一侧。 */
function hash(text: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h
}

/**
 * 按内容确定性分流。
 *
 * 用哈希而不是随机：**同一条样本永远落在同一侧**，重跑不会换组，也就没法反复重抽
 * 直到留出侧只剩容易的。`salt` 只在开新一批评测集时换，换了等于重新洗牌，
 * 换之前想清楚。
 *
 * @param cases - 已经人工标注过的样本。
 * @param options - `holdoutRatio` 留出侧占比（0-1，缺省 0.5）；`salt` 分流盐。
 * @returns 两侧样本。
 */
export function splitBadCases(
  cases: readonly BadCase[],
  options: { holdoutRatio?: number; salt?: string } = {},
): BadCaseSplit {
  const ratio = options.holdoutRatio ?? 0.5
  const salt = options.salt ?? ''
  const open: BadCase[] = []
  const heldout: BadCase[] = []
  for (const c of cases) {
    // 只按内容和盐算，不掺时间、顺序或标注人——否则同一条样本重跑会换组。
    const toHeldout = (hash(`${salt} ${sampleIdentity(c.sample)}`) % 1000) / 1000 < ratio
    if (toHeldout) heldout.push(c)
    else open.push(c)
  }
  return { open, heldout }
}

/**
 * 把分流后的样本并进声明的验收用例。**五种声明类型都支持**，形状由 `sample.kind` 决定。
 *
 * 归组规则：
 *   - 公开侧 `deny` 进 `evals.deny`，公开侧 `allow` 进 `evals.allow`
 *   - 留出侧 `deny` 进 `evals.heldout`
 *   - **留出侧 `allow` 仍然进 `evals.allow`**——留出集在这个项目里的定义始终是
 *     「应当被拦、但字面与 deny 不重叠」；放行类样本藏起来没有意义，
 *     它防的是过度拦截，越早看见越好。
 *
 * 已有的用例不会被重复并入。形状与声明类型对不上的样本**不并、但会报**
 * （{@link ApplyResult.skipped}）——静默丢弃会让样本消失而评测集看着照样是绿的。
 *
 * @param specs - 现有声明。
 * @param split - {@link splitBadCases} 的结果。
 * @returns 并入之后的新声明与没并进去的样本；原对象不改。
 */
export function applyBadCases(
  specs: readonly ConstraintSpec[], split: BadCaseSplit,
): ApplyResult {
  const used = new Set<BadCase>()
  const byName = new Map(specs.map(sp => [sp.name, sp]))

  /** 取归给这条声明、且形状对得上的样本载荷。 */
  const take = (side: readonly BadCase[], spec: ConstraintSpec, v: BadCase['verdict']): unknown[] => {
    const out: unknown[] = []
    for (const c of side) {
      if (c.spec !== spec.name || c.verdict !== v) continue
      if (c.sample.kind !== ACCEPTS[spec.type]) continue
      used.add(c)
      const s2 = c.sample
      if (s2.kind === 'say') out.push(s2.say)
      else if (s2.kind === 'tool-output') out.push(s2.text)
      else if (s2.kind === 'fact-say') out.push({ before: s2.before, say: s2.say })
      else if (s2.kind === 'dialogue') out.push({ ask: s2.ask, reply: s2.reply })
      else out.push({ before: s2.before, call: s2.call })
    }
    return out
  }

  /** 按现有用例去重后追加。用例形状不一，一律按序列化后的字面量比。 */
  const add = (target: readonly unknown[] | undefined, extra: readonly unknown[]): unknown[] => {
    const out = [...target ?? []]
    const seen = new Set(out.map(x => JSON.stringify(x)))
    for (const e of extra) {
      const k = JSON.stringify(e)
      if (seen.has(k)) continue
      seen.add(k)
      out.push(e)
    }
    return out
  }

  const next = specs.map(spec => {
    const evals = (spec as unknown as { evals?: Record<string, unknown[]> }).evals ?? {}
    const deny = add(evals.deny, take(split.open, spec, 'deny'))
    const allow = add(evals.allow, [
      ...take(split.open, spec, 'allow'),
      // 留出侧的放行类样本照样进 allow：留出集在这个项目里的定义始终是
      // 「应当被拦、但字面与 deny 不重叠」，放行类样本防的是过度拦截，越早看见越好。
      ...take(split.heldout, spec, 'allow'),
    ])
    const heldout = add(evals.heldout, take(split.heldout, spec, 'deny'))
    const changed = deny.length !== (evals.deny?.length ?? 0)
      || allow.length !== (evals.allow?.length ?? 0)
      || heldout.length !== (evals.heldout?.length ?? 0)
    if (!changed) return spec
    return { ...spec, evals: { ...evals, deny, allow, heldout } } as ConstraintSpec
  })

  // 没并进去的必须报出来：归错约束、形状对不上、约束名写错，都会落到这里。
  // 静默丢弃是这一层最不该做的事——样本丢了，评测集看起来照样是绿的。
  const skipped: SkippedCase[] = []
  for (const c of [...split.open, ...split.heldout]) {
    if (used.has(c)) continue
    const spec = byName.get(c.spec)
    skipped.push({
      case: c,
      why: spec === undefined
        ? `没有叫「${c.spec}」的约束`
        : `约束「${c.spec}」是 ${spec.type}，它认的是 ${ACCEPTS[spec.type]} 样本，这条是 ${c.sample.kind}`,
    })
  }
  return { specs: next, skipped }
}

/**
 * 抹掉报告里留出用例的原文，只留数量。
 *
 * 改规矩的人应该看得到「留出掉了几条」，但看不到是哪几条——看得到就会照着改，
 * 那测的是照差异改，不是泛化（实测过）。必拦与必放两组不抹：它们本来就是公开的。
 *
 * @param reports - `checkSpecEvals` 的结果。
 * @returns 留出原文已抹去的报告副本。
 */
export function redactHeldout(reports: readonly SpecEvalReport[]): SpecEvalReport[] {
  return reports.map(r => ({
    ...r,
    heldout: {
      ...r.heldout,
      missed: r.heldout.missed.map((_m, i) => `（留出用例 #${i + 1}，内容不显示）`),
    },
  }))
}

/** 一条约束在两次评测之间的变化。 */
export interface ReportDelta {
  name: string
  /** 三组各自的增减，负数是掉了。 */
  deny: number
  allow: number
  heldout: number
  /** 任一组掉了。 */
  regressed: boolean
}

/** 回归比对结果。 */
export interface RegressionReport {
  ok: boolean
  deltas: ReportDelta[]
  /** 上一版有、这一版没有的约束（删掉或改名了）。 */
  missing: string[]
}

/**
 * 与上一版比。
 *
 * 为新样本改一句措辞很容易把旧的弄坏——措辞是未受控变量，实测过：同一条规矩改半句话，
 * 必拦从 3/3 变成 6 轮漏 3 次。所以每次并入新样本、改完声明，都要与上一版全量比，
 * **任一组掉了就是回归**，包括留出集（那一组不计入单次的 `ok`，但掉了必须知道）。
 *
 * @param before - 上一版的报告。
 * @param after - 这一版的报告。
 * @returns 逐条约束的增减；`ok` 为假表示有回归。
 */
export function compareReports(
  before: readonly SpecEvalReport[], after: readonly SpecEvalReport[],
): RegressionReport {
  const prev = new Map(before.map(r => [r.name, r]))
  const deltas: ReportDelta[] = []
  for (const cur of after) {
    const old = prev.get(cur.name)
    if (old === undefined) continue
    prev.delete(cur.name)
    const d: ReportDelta = {
      name: cur.name,
      deny: cur.deny.caught - old.deny.caught,
      allow: cur.allow.kept - old.allow.kept,
      heldout: cur.heldout.caught - old.heldout.caught,
      regressed: false,
    }
    d.regressed = d.deny < 0 || d.allow < 0 || d.heldout < 0
    deltas.push(d)
  }
  const missing = [...prev.keys()]
  return { ok: !deltas.some(d => d.regressed) && missing.length === 0, deltas, missing }
}

/**
 * 把回归比对排成一段可读文本。
 * @param report - {@link compareReports} 的结果。
 * @returns 可以贴进交付记录的文本。
 */
export function formatRegression(report: RegressionReport): string {
  const sign = (n: number): string => n > 0 ? `+${n}` : String(n)
  const lines = report.deltas
    .filter(d => d.deny !== 0 || d.allow !== 0 || d.heldout !== 0)
    .map(d => `${d.regressed ? '✗' : '·'} ${d.name}`
      + ` 必拦 ${sign(d.deny)} · 必放 ${sign(d.allow)} · 留出 ${sign(d.heldout)}`)
  const head = report.ok ? '✓ 没有回归' : '✗ 有回归，不该冻结'
  const gone = report.missing.map(n => `✗ 上一版有、这一版没有的约束：${n}`)
  return [head, ...gone, ...lines].join('\n')
}
