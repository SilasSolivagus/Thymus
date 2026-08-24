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

/** 一条人工标注过的线上样本。 */
export interface BadCase {
  /** 归到哪条约束——用约束名，与声明里的 `name` 对上。 */
  spec: string
  /** agent 说的那句话。目前只支持说话通道；工具侧样本形状不同，没做。 */
  say: string
  /**
   * **人的判定**：这句该拦（`deny`）还是该原样放行（`allow`）。
   * 这一栏没有自动化的余地——线上流量没有标准答案，模型标就回到自己给自己打分。
   */
  verdict: 'deny' | 'allow'
  /** 出处，用来回到现场。 */
  source: { sessionId: string; seq?: number }
  /** 谁标的、什么时候标的。留出侧只报这个，不报原文。 */
  by: string
  at: string
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
    // 只按内容和盐算，不掺时间或顺序——否则同一条样本重跑会换组。
    const toHeldout = (hash(`${salt} ${c.say}`) % 1000) / 1000 < ratio
    if (toHeldout) heldout.push(c)
    else open.push(c)
  }
  return { open, heldout }
}

/**
 * 把分流后的样本并进声明的验收用例。
 *
 * 归组规则：
 *   - 公开侧 `deny` 进 `evals.deny`，公开侧 `allow` 进 `evals.allow`
 *   - 留出侧 `deny` 进 `evals.heldout`
 *   - **留出侧 `allow` 仍然进 `evals.allow`**——留出集在这个项目里的定义始终是
 *     「应当被拦、但字面与 deny 不重叠」；放行类样本藏起来没有意义，
 *     它防的是过度拦截，越早看见越好。
 *
 * 重复的原文不会重复并入。只处理说话类声明（`forbidden-phrases` / `semantic-policy`），
 * 别的类型用例形状不同，原样返回。
 *
 * @param specs - 现有声明。
 * @param split - {@link splitBadCases} 的结果。
 * @returns 并入之后的新声明；原对象不改。
 */
export function applyBadCases(
  specs: readonly ConstraintSpec[], split: BadCaseSplit,
): ConstraintSpec[] {
  const add = (target: string[] | undefined, texts: string[]): string[] => {
    const out = [...target ?? []]
    for (const t of texts) if (!out.includes(t)) out.push(t)
    return out
  }
  return specs.map(spec => {
    if (spec.type !== 'forbidden-phrases' && spec.type !== 'semantic-policy') return spec
    const mine = (side: readonly BadCase[], v: BadCase['verdict']): string[] =>
      side.filter(c => c.spec === spec.name && c.verdict === v).map(c => c.say)
    const evals = spec.evals ?? {}
    return {
      ...spec,
      evals: {
        ...evals,
        deny: add(evals.deny, mine(split.open, 'deny')),
        allow: add(evals.allow, [...mine(split.open, 'allow'), ...mine(split.heldout, 'allow')]),
        heldout: add(evals.heldout, mine(split.heldout, 'deny')),
      },
    }
  })
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
