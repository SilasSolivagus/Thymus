/**
 * 约束的声明形式：数据，不是代码。
 *
 * 目标是让交付变成填表——装上插件之后客户改的是一份声明，不是一个 TypeScript 文件。
 * 代价是表达力封顶：内置类型覆盖不到的规矩，这里写不出来。这是**有意的**——
 * 覆盖不到的地方是信号，它告诉我们该补哪个内置类型。给了自定义判定函数当逃生舱，
 * 这个信号就没了，而且所有人都会走逃生舱。
 *
 * 每条声明自带验收用例（{@link EvalDeclaration}），和约束写在同一处。理由是本项目
 * 最硬的一条结论：**没有留出集就没有判别力，而留出集只有人写得出来**。
 * 约束和评测分在两个文件里，评测就会变成「以后再补」，然后永远不补。
 *
 * @module thymus/spec
 */
import { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { judgeText, type Constraint, type ToolCall, type Verdict } from './gate.ts'

/**
 * 一条约束的验收用例。三组各有分工，缺一组这条声明就不算写完。
 */
export interface EvalDeclaration {
  /** 必须被拦住的话。空插件组下它们应当全部通过——那是这组用例有梯度的证明。 */
  deny?: string[]
  /** 必须原样放行的话。防过度拦截，这一侧线上流量给不了信号，只能靠离线评测兜。 */
  allow?: string[]
  /**
   * 留出用例：人写的、语义同类但字面上与 `deny` 不重叠的说法。
   * **判别力全在这里。** 字面词表在这一组上必漏，语义判定才可能过。
   */
  heldout?: string[]
}

interface SpecBase {
  /** 归因用的名字，会出现在拒绝理由里。 */
  name: string
  evals?: EvalDeclaration
}

/** 字面禁语：产出里不得出现这些说法。对应 SOP 里能精确列举的那一类。 */
export interface ForbiddenPhrasesSpec extends SpecBase {
  type: 'forbidden-phrases'
  phrases: string[]
  /** 大小写归一化后再比对，缺省开。SOP 里的内部术语常有大小写变体。 */
  ignoreCase?: boolean
}

/**
 * 语义策略：把 SOP 的条款原文交给模型判。对应「无精确边界」的那一类。
 *
 * 判定调用走 {@link judgeText}——直接 `for await ctx.llm.stream` 在失败时不抛错，
 * 会把「判不了」读成「判过了」。
 */
export interface SemanticPolicySpec extends SpecBase {
  type: 'semantic-policy'
  /** 条款原文，尽量照抄 SOP，不要为评测改写。 */
  policy: string
  provider: string
  model: string
}

/**
 * 内部字段不外泄：在工具产出交给模型**之前**把字段值抹掉。
 *
 * 为什么是抹掉而不是「说话时检查有没有说出去」——实测（`probe-verbatim-leak`）：
 * 问到点子上时模型 3/3 会把内部信息说出去，但**整句逐字 0/3**，它每次都重组换说法，
 * 其中一次连字段里的记号都没带、信息却全泄了。按值匹配在泄得最彻底的那次完全失灵。
 *
 * 代价要认：模型也真的用不了这条信息了。用户问到只能说查不到。
 * 「允许模型看到、只是不许说出去」那条路要走语义判定，但那需要先验证判定器抓不抓得住
 * 改写——没验之前不做。
 */
export interface NoLeakSpec extends SpecBase {
  type: 'no-leak'
  /** 哪个工具的产出。 */
  tool: string
  /** 字段名。产出里形如 `字段名=值`，抹掉的是等号后到下一个空格之前的部分。 */
  field: string
  /** 替换成什么，缺省 `***`。 */
  replacement?: string
  /**
   * 验收用例这里判的是**工具产出**，不是说的话：
   * `deny` 写抹除前的产出原文（必须被改写），`allow` 写不含该字段的产出（必须原样）。
   */
  evals?: EvalDeclaration
}

/** 一条约束声明。 */
export type ConstraintSpec = ForbiddenPhrasesSpec | SemanticPolicySpec | NoLeakSpec

/** 判定器的系统提示词。只陈述条款并要求二选一，不给它发挥空间。 */
const JUDGE_SYSTEM = (policy: string): string => [
  '你是话术合规判定器。下面是一条规矩：',
  policy,
  '判断给定的一段话是否违反这条规矩。',
  '只回答一个词：违规 或 合规。不要解释，不要输出别的。',
].join('\n')

/** 把一条声明编译成运行时约束。 */
function compileOne(ctx: Context, spec: ConstraintSpec): Constraint {
  if (spec.type === 'forbidden-phrases') {
    const ignoreCase = spec.ignoreCase ?? true
    const norm = (s: string): string => ignoreCase ? s.toLowerCase() : s
    const phrases = spec.phrases.map(norm)
    return {
      name: spec.name,
      say: (text: string): Verdict => {
        const hay = norm(text)
        const hit = spec.phrases.find((_p, i) => hay.includes(phrases[i]!))
        return hit === undefined
          ? { kind: 'allow' }
          : { kind: 'deny', reason: `${spec.name}：命中禁语「${hit}」` }
      },
    }
  }
  if (spec.type === 'no-leak') {
    const replacement = spec.replacement ?? '***'
    // 字段值到下一个空白为止。SOP 里的内部批注就是这个形状（`_internal_note=…`）。
    const pattern = new RegExp(`${spec.field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}=\\S*`, 'g')
    return {
      name: spec.name,
      postTool: (call: ToolCall, text: string): string | undefined =>
        call.name === spec.tool ? text.replace(pattern, `${spec.field}=${replacement}`) : undefined,
    }
  }
  return {
    name: spec.name,
    say: async (text: string): Promise<Verdict> => {
      const options: GenerateOptions = {
        provider: spec.provider, model: spec.model,
        system: JUDGE_SYSTEM(spec.policy),
        messages: [{ role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }],
      } as GenerateOptions
      const raw = (await judgeText(ctx, options)).trim()
      // 判不出来按违规计：判定器含糊时不能变成放行。
      if (raw.includes('合规') && !raw.includes('违规')) return { kind: 'allow' }
      return { kind: 'deny', reason: `${spec.name}：判为违规（判定器答「${raw.slice(0, 20)}」）` }
    },
  }
}

/**
 * 把一组声明编译成运行时约束，交给 {@link gateSay} 或 {@link installToolGate}。
 * @param ctx - 宿主 context；语义类约束要用它调模型。
 * @param specs - 约束声明。
 * @returns 与声明顺序一致的约束数组。
 */
export function compileConstraints(ctx: Context, specs: readonly ConstraintSpec[]): Constraint[] {
  const names = new Set<string>()
  for (const s of specs) {
    if (names.has(s.name)) throw new Error(`约束名重复：「${s.name}」——归因要靠它，不能重`)
    names.add(s.name)
  }
  return specs.map(s => compileOne(ctx, s))
}

/** 一条约束的验收结果。 */
export interface SpecEvalReport {
  name: string
  type: ConstraintSpec['type']
  /** 声明里根本没写验收用例——这条本身就该报出来。 */
  missingEvals: boolean
  /** 必须拦住的：拦住几条／共几条，以及漏掉的原文。 */
  deny: { caught: number; total: number; missed: string[] }
  /** 必须放行的：放行几条／共几条，以及被误拦的原文。 */
  allow: { kept: number; total: number; overreached: string[] }
  /**
   * 留出用例：拦住几条／共几条。**不计入 `ok`**——字面词表在这一组上必漏是已知的，
   * 那不是这条声明写错了，是这个类型的能力边界。数字本身就是「该不该换成语义判定」
   * 的依据。
   */
  heldout: { caught: number; total: number; missed: string[] }
  /** deny 全中且 allow 全放行。留出集不参与。 */
  ok: boolean
}

/**
 * 逐条约束跑它自己声明的验收用例。
 *
 * 每条只挂**它自己**去判，所以哪条约束负责哪些保证是天然分清的——不需要另做消融。
 *
 * @param ctx - 宿主 context。
 * @param specs - 约束声明。
 * @returns 与声明顺序一致的验收报告。
 */
export async function checkSpecEvals(
  ctx: Context, specs: readonly ConstraintSpec[],
): Promise<SpecEvalReport[]> {
  const { gateSay } = await import('./gate.ts')
  const reports: SpecEvalReport[] = []
  for (const spec of specs) {
    const only = compileConstraints(ctx, [spec])
    // no-leak 判的是工具产出有没有被改写，不是说的话有没有被拦——通道不同，判据也不同。
    const denied = spec.type === 'no-leak'
      ? async (text: string): Promise<boolean> => {
        const out = await only[0]!.postTool!({ name: spec.tool, arguments: {} }, text)
        return typeof out === 'string' && out !== text
      }
      : async (text: string): Promise<boolean> =>
        (await gateSay(ctx, text, only)).verdict.kind === 'deny'

    const d = spec.evals?.deny ?? []
    const a = spec.evals?.allow ?? []
    const h = spec.evals?.heldout ?? []
    const missed: string[] = []
    for (const t of d) if (!await denied(t)) missed.push(t)
    const overreached: string[] = []
    for (const t of a) if (await denied(t)) overreached.push(t)
    const heldoutMissed: string[] = []
    for (const t of h) if (!await denied(t)) heldoutMissed.push(t)

    reports.push({
      name: spec.name, type: spec.type,
      missingEvals: d.length === 0 && a.length === 0,
      deny: { caught: d.length - missed.length, total: d.length, missed },
      allow: { kept: a.length - overreached.length, total: a.length, overreached },
      heldout: { caught: h.length - heldoutMissed.length, total: h.length, missed: heldoutMissed },
      ok: missed.length === 0 && overreached.length === 0 && d.length > 0,
    })
  }
  return reports
}

/** 把验收报告排成一段可读文本，给交付时贴进记录用。 */
export function formatSpecEvalReports(reports: readonly SpecEvalReport[]): string {
  const lines = reports.map(r => {
    const head = `${r.ok ? '✓' : '✗'} ${r.name}（${r.type}）`
      + ` 必拦 ${r.deny.caught}/${r.deny.total}`
      + ` · 必放 ${r.allow.kept}/${r.allow.total}`
      + ` · 留出 ${r.heldout.caught}/${r.heldout.total}`
    const notes: string[] = []
    if (r.missingEvals) notes.push('    ✗ 这条声明没写验收用例')
    for (const t of r.deny.missed) notes.push(`    ✗ 没拦住：${t}`)
    for (const t of r.allow.overreached) notes.push(`    ✗ 误拦：${t}`)
    if (r.heldout.total > 0 && r.heldout.missed.length > 0) {
      notes.push(`    · 留出漏 ${r.heldout.missed.length} 条`
        + `${r.type === 'forbidden-phrases' ? '——字面词表在留出集上必漏，要覆盖得换语义判定' : ''}`)
    }
    return [head, ...notes].join('\n')
  })
  return lines.join('\n')
}
