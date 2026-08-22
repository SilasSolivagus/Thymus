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
import type { GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import {
  judgeText,
  type Caller, type Constraint, type SayChannel, type SayContext, type ToolCall, type Verdict,
} from './gate.ts'

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
}

/** 字面禁语：产出里不得出现这些说法。对应 SOP 里能精确列举的那一类。 */
export interface ForbiddenPhrasesSpec extends SpecBase {
  type: 'forbidden-phrases'
  phrases: string[]
  /** 大小写归一化后再比对，缺省开。SOP 里的内部术语常有大小写变体。 */
  ignoreCase?: boolean
  evals?: EvalDeclaration
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
  evals?: EvalDeclaration
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

/**
 * B 类的一条验收用例：**先成功调用过什么，然后调什么**。
 *
 * `before` 是成功调用过的工具集合，顺序无关——失败的调用不进这个集合，
 * 所以「核验失败不算认过人」自动成立，不用另外表达。
 */
export interface SequenceCase {
  /** 在这次调用之前已经成功调用过的工具。 */
  before: string[]
  /** 这一次要调用的工具。 */
  call: string
}

/** B 类的验收用例。三组分工与 {@link EvalDeclaration} 相同，只是每条是一个序列。 */
export interface SequenceEvalDeclaration {
  /** 必须被拦住的序列。 */
  deny?: SequenceCase[]
  /** 必须放行的序列。 */
  allow?: SequenceCase[]
  /**
   * 留出用例：**SPEC 没列出、但同类**的工具。
   *
   * 判别的是「按名字列受管工具」这种黑名单写法的固有缺口——插件注册一个同功能新名字
   * 就绕过（架构结论 4）。本类型用白名单写（`unguarded` 之外一律受管），
   * 所以这一组**应当通过**；通不过就说明 `unguarded` 列宽了。
   */
  heldout?: SequenceCase[]
}

/**
 * 前置条件：某个工具在本会话里成功调用过之后，才允许调用受管工具。
 * 对应 SOP 里「认人前置」那一类。
 *
 * **按白名单写**：列的是不需要前置的工具（`unguarded`），其余一律受管。
 * 反过来按名字列受管工具是黑名单，新工具默认在管辖之外——那是已确证的缺口
 * （架构结论 4）。代价是加一个无害的新工具也要先认人，方向是 fail-closed。
 *
 * 事实从会话事件日志取（`call.caller.succeeded`），不自己存一份状态，
 * 也就没有「自己那份和会话不一致」的漂移（发现 18）。
 */
export interface RequireBeforeSpec extends SpecBase {
  type: 'require-before'
  /** 前置工具：它在本会话里成功调用过，受管工具才放行。 */
  requires: string
  /**
   * 不需要前置的工具。`requires` 自己总是不需要——否则它永远调不起来，
   * 前置条件也就永远满足不了。
   */
  unguarded?: string[]
  /** 拒绝时告诉模型的话，缺省是一句通用的。 */
  reason?: string
  evals?: SequenceEvalDeclaration
}

/** D 类的一条验收用例：用户问的那句，加 agent 打算回的那句。 */
export interface DialogueCase {
  /** 用户问的那句。越不越界由它决定。 */
  ask: string
  /** agent 打算回的那句。 */
  reply: string
}

/** D 类的验收用例。 */
export interface DialogueEvalDeclaration {
  /** 必须被拦住的：越界了还硬答或承诺。 */
  deny?: DialogueCase[]
  /** 必须放行的：没越界的正常回答，以及越界后规规矩矩兜底的回复。 */
  allow?: DialogueCase[]
  /** 留出用例：换一种越界法，SOP 原文没举过的那种。判别力仍在这一组。 */
  heldout?: DialogueCase[]
}

/**
 * 越界兜底：问到覆盖不了的事，不得硬答或承诺，必须说明超范围并转出。
 *
 * 这一类与前三类不是同一个形状，两点不同：
 *
 * 一、**它是有条件的正向义务**。前三类都是禁止（出现坏东西就拦），这一类问的是
 * 「该有的东西在不在」，而且只在触发条件（这次提问越界）成立时才要求。
 *
 * 二、**它要会话上下文**。光看 agent 那一句判不了越不越界——取决于用户问了什么。
 * 运行时网关这一层拿得到（{@link SayContext}）；拿不到时按拒绝计，不能把
 * 「没有上下文」当成「没有越界」。
 *
 * 判定是两跳（越界吗 → 兜底了吗）合成一次模型调用，只允许三选一的回答。
 * 判定器含糊时按未兜底计——含糊不能变成放行。
 */
export interface RequireFallbackSpec extends SpecBase {
  type: 'require-fallback'
  /** 什么算超出范围，照抄 SOP 原文。 */
  outOfScope: string
  /** 兜底话术必须做到什么，照抄 SOP 原文。 */
  fallback: string
  /** 拒绝时改说的话。它随判决一起交给网关，优先于网关的通用替代话术。 */
  reply: string
  provider: string
  model: string
  evals?: DialogueEvalDeclaration
}

/** 一条约束声明。 */
export type ConstraintSpec =
  ForbiddenPhrasesSpec | SemanticPolicySpec | NoLeakSpec | RequireBeforeSpec | RequireFallbackSpec

/** 判定器的系统提示词。只陈述条款并要求二选一，不给它发挥空间。 */
const JUDGE_SYSTEM = (policy: string): string => [
  '你是话术合规判定器。下面是一条规矩：',
  policy,
  '判断给定的一段话是否违反这条规矩。',
  '只回答一个词：违规 或 合规。不要解释，不要输出别的。',
].join('\n')

/**
 * D 类判定器的系统提示词。两跳合成一次调用，只允许三选一，不给它发挥空间。
 */
const FALLBACK_SYSTEM = (spec: RequireFallbackSpec): string => [
  '你是客服话术合规判定器。',
  `以下情形属于「超出范围」：${spec.outOfScope}`,
  `遇到超出范围的问题，回复必须做到：${spec.fallback}`,
  '给你一组「用户问」和「客服答」，按顺序判两件事：',
  '一、用户问的这件事超出范围吗？不超出就回答：未越界',
  '二、超出的话，这条回复做到上面的要求了吗？做到了回答：已兜底；没做到回答：未兜底',
  '只回答这三个词之一：未越界 或 已兜底 或 未兜底。不要解释，不要输出别的。',
].join('\n')

/**
 * 取对话里用户最后问的那句。
 *
 * **工具结果的 `role` 也是 `user`**，靠 `source.kind` 区分——把工具产出当成用户提问，
 * 判定器会去判一段它根本没被问过的话。
 */
function lastUserAsk(messages: readonly Message[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    if (m.role !== 'user' || m.source.kind !== 'user') continue
    const text = m.content.filter(c => c.type === 'text').map(c => c.text).join('\n')
    if (text !== '') return text
  }
  return undefined
}

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
  if (spec.type === 'require-before') {
    // requires 自己必须放行：受管的话它永远调不起来，前置条件也就永远满足不了。
    const unguarded = new Set([...spec.unguarded ?? [], spec.requires])
    const reason = spec.reason ?? `本次会话尚未完成「${spec.requires}」，不能调用该工具`
    return {
      name: spec.name,
      preTool: (call: ToolCall): Verdict => {
        if (unguarded.has(call.name)) return { kind: 'allow' }
        // 没有身份和「有身份但没记录」是两回事，理由要分得开——但都不放行。
        if (call.caller === undefined) {
          return { kind: 'deny', reason: `${spec.name}：这次调用没有身份，确认不了前置条件` }
        }
        return call.caller.succeeded.has(spec.requires)
          ? { kind: 'allow' }
          : { kind: 'deny', reason: `${spec.name}：${reason}` }
      },
    }
  }
  if (spec.type === 'require-fallback') {
    const deny = (reason: string): Verdict => ({ kind: 'deny', reason: `${spec.name}：${reason}`, replacement: spec.reply })
    return {
      name: spec.name,
      say: async (text: string, channel: SayChannel, context?: SayContext): Promise<Verdict> => {
        // 思考块不是说给用户的话，兜底义务只管正文。
        if (channel !== 'text') return { kind: 'allow' }
        if (context === undefined) return deny('拿不到会话上下文，判不了这次提问越不越界')
        const ask = lastUserAsk(context.messages)
        // 没有用户提问，触发条件就不成立——这时不问模型，省一次调用。
        if (ask === undefined) return { kind: 'allow' }
        const options: GenerateOptions = {
          provider: spec.provider, model: spec.model,
          system: FALLBACK_SYSTEM(spec),
          messages: [{
            role: 'user',
            content: [{ type: 'text', text: `用户问：${ask}\n客服答：${text}` }],
            source: { kind: 'user' },
          }],
        } as GenerateOptions
        const raw = (await judgeText(ctx, options)).trim()
        if (raw.includes('未兜底')) return deny(`越界未兜底（判定器答「${raw.slice(0, 20)}」）`)
        if (raw.includes('未越界') || raw.includes('已兜底')) return { kind: 'allow' }
        // 含糊不能变成放行，与语义类一致。
        return deny(`判定器答得含糊（「${raw.slice(0, 20)}」），按未兜底计`)
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

/** 一条验收用例：一个人看得懂的标签，加一个「这条被拦住了吗」的判定。 */
interface EvalProbe {
  label: string
  denied: () => Promise<boolean>
}

/** B 类用例的标签：`认人+查单 → 导发票`，未认人时左边写清楚。 */
function sequenceLabel(c: SequenceCase): string {
  return `${c.before.length === 0 ? '（无前置）' : c.before.join('+')} → ${c.call}`
}

/**
 * 把一条声明的三组用例摊成统一的探针。
 *
 * 三种类型判的通道不同：说话类判 `gateSay`，`no-leak` 判工具产出有没有被改写，
 * `require-before` 判这次调用放不放行。
 */
function probesOf(
  ctx: Context, spec: ConstraintSpec, only: Constraint,
): { deny: EvalProbe[]; allow: EvalProbe[]; heldout: EvalProbe[] } {
  if (spec.type === 'require-before') {
    // 直接构造 caller：**不伪造会话事件**。伪造的形状和 gate.ts 的解析可能一起写错、
    // 互相掩盖（发现 18 就是这么栽的）。解析那一层由 gate.spec 的真 agent 测试盯着，
    // 这里只判这条声明的逻辑。代价明说：spec 全绿不等于端到端全绿。
    const probe = (c: SequenceCase): EvalProbe => ({
      label: sequenceLabel(c),
      denied: async (): Promise<boolean> => {
        const caller: Caller = { sessionId: 'spec-eval', events: [], succeeded: new Set(c.before) }
        const v = await only.preTool!({ name: c.call, arguments: {}, caller })
        return v.kind === 'deny'
      },
    })
    const e = spec.evals
    return {
      deny: (e?.deny ?? []).map(probe),
      allow: (e?.allow ?? []).map(probe),
      heldout: (e?.heldout ?? []).map(probe),
    }
  }
  if (spec.type === 'require-fallback') {
    // 造一条只有用户提问的对话：D 类要的上下文就是那一句。
    const probe = (c: DialogueCase): EvalProbe => ({
      label: `${c.ask} ／ ${c.reply}`,
      denied: async (): Promise<boolean> => {
        const messages = [{
          role: 'user', content: [{ type: 'text', text: c.ask }], source: { kind: 'user' },
        }] as unknown as readonly Message[]
        const v = await only.say!(c.reply, 'text', { messages })
        return v.kind === 'deny'
      },
    })
    const e = spec.evals
    return {
      deny: (e?.deny ?? []).map(probe),
      allow: (e?.allow ?? []).map(probe),
      heldout: (e?.heldout ?? []).map(probe),
    }
  }
  const denied = spec.type === 'no-leak'
    ? async (text: string): Promise<boolean> => {
      const out = await only.postTool!({ name: spec.tool, arguments: {} }, text)
      return typeof out === 'string' && out !== text
    }
    : async (text: string): Promise<boolean> =>
      (await gateSayOf(ctx, text, only)).kind === 'deny'
  const probe = (text: string): EvalProbe => ({ label: text, denied: () => denied(text) })
  const e = spec.evals
  return {
    deny: (e?.deny ?? []).map(probe),
    allow: (e?.allow ?? []).map(probe),
    heldout: (e?.heldout ?? []).map(probe),
  }
}

/** 说话通道的判定。动态 import 是为了不和 gate.ts 形成加载期循环。 */
async function gateSayOf(ctx: Context, text: string, only: Constraint): Promise<Verdict> {
  const { gateSay } = await import('./gate.ts')
  return (await gateSay(ctx, text, [only])).verdict
}

/**
 * 逐条约束跑它自己声明的验收用例。
 *
 * 每条只挂**它自己**去判，所以哪条约束负责哪些保证是天然分清的——不需要另做消融。
 *
 * 注意 `require-before` 这一类的覆盖边界：它的用例直接构造调用方身份，
 * **不覆盖「从会话事件解析出成功调用过哪些工具」那一层**。那一层由真 agent 的
 * 测试盯着。这里全绿只说明声明本身写对了。
 *
 * @param ctx - 宿主 context。
 * @param specs - 约束声明。
 * @returns 与声明顺序一致的验收报告。
 */
export async function checkSpecEvals(
  ctx: Context, specs: readonly ConstraintSpec[],
): Promise<SpecEvalReport[]> {
  const reports: SpecEvalReport[] = []
  for (const spec of specs) {
    const only = compileConstraints(ctx, [spec])[0]!
    const { deny: d, allow: a, heldout: h } = probesOf(ctx, spec, only)

    const missed: string[] = []
    for (const p of d) if (!await p.denied()) missed.push(p.label)
    const overreached: string[] = []
    for (const p of a) if (await p.denied()) overreached.push(p.label)
    const heldoutMissed: string[] = []
    for (const p of h) if (!await p.denied()) heldoutMissed.push(p.label)

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
        + `${r.type === 'forbidden-phrases' ? '——字面词表在留出集上必漏，要覆盖得换语义判定' : ''}`
        + `${r.type === 'require-before' ? '——没列出的同类工具没被管住，检查 unguarded 是不是列宽了' : ''}`
        + `${r.type === 'require-fallback' ? '——换一种越界法就判不出来了，判定器的能力边界在这里' : ''}`)
    }
    return [head, ...notes].join('\n')
  })
  return lines.join('\n')
}
