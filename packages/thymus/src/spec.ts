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
 *
 * **`fallback` 里不要写「不得承诺」这类无条件禁止**（真模型实测，发现 20）。
 * 一条 SOP 条款常常同时包含「什么时候必须做什么」和「什么时候都不许做什么」；
 * 写成一条之后，无条件那半会变成有条件那半的从属条件——判定器先判越界，
 * 不越界就整条放行，于是「范围内但过度承诺」系统性漏掉（11 轮全漏那一条就是这么来的）。
 * 拆成一条 `require-fallback` 加一条 {@link SemanticPolicySpec}，留出集从 3–4/5 变成 5/5。
 * 拆完记得看 `allow` 那一组：无条件禁止写宽了会把正常业务话术也拦掉，
 * 而必拦和留出两组对此完全无感。
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

/**
 * B 类说话侧的一条验收用例：**本会话已成立哪些事实，然后说了什么**。
 */
export interface FactSayCase {
  /** 这句话之前已经成功调用过的工具。 */
  before: string[]
  /** agent 打算说的那句。 */
  say: string
}

/** B 类说话侧的验收用例。 */
export interface FactSayEvalDeclaration {
  /** 必须被拦住的：事实不成立却说了受限内容。 */
  deny?: FactSayCase[]
  /** 必须放行的：事实成立后正常回答，以及不涉及受限内容的话。 */
  allow?: FactSayCase[]
  /** 留出用例：**换一种说法讲同一类内容**，条款原文没举过的那种。 */
  heldout?: FactSayCase[]
}

/**
 * 说到某类内容之前必须先有某个事实。对应 SOP 里「认人之后才能答账号问题」那一类。
 *
 * 这是 {@link RequireBeforeSpec} 的说话侧对应物，两条一起用才覆盖得全：
 * 那一条拦的是「未认人不许**去查**」，这一条拦的是「未认人不许**说出来**」。
 * 只有前者时，模型仍可能凭对话里已有的信息作答——实测过一份真实 SOP，
 * 这一侧原先表达不了，只能登记进 `uncovered`。
 *
 * 判定顺序是省钱的关键：**事实成立就直接放行，不问模型**。只有事实不成立时才花一次
 * 调用去判「这句话是不是在讲受限内容」。正常会话里认过人之后的每一句都不花钱。
 *
 * 拿不到调用方身份时按拒绝计——「没有身份」不能当成「没有违规」。
 */
export interface RequireBeforeSaySpec extends SpecBase {
  type: 'require-before-say'
  /** 前置事实：这个工具在本会话里成功调用过。 */
  requires: string
  /** 什么内容算受限，照抄条款原文。 */
  topic: string
  /** 拦下时改说的话，随判决交给网关。 */
  reply: string
  provider: string
  model: string
  evals?: FactSayEvalDeclaration
}

/** 一条约束声明。 */
export type ConstraintSpec =
  ForbiddenPhrasesSpec | SemanticPolicySpec | NoLeakSpec | RequireBeforeSpec
  | RequireFallbackSpec | RequireBeforeSaySpec

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

/** B 类说话侧判定器的系统提示词。只判「这句话在不在讲那类内容」，不判别的。 */
const TOPIC_SYSTEM = (topic: string): string => [
  '你是客服话术判定器。以下内容属于「受限内容」：',
  topic,
  '判断给定的一句客服话术有没有讲到受限内容。',
  '只回答一个词：涉及 或 不涉及。不要解释，不要输出别的。',
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
  if (spec.type === 'require-before-say') {
    const deny = (reason: string): Verdict => ({ kind: 'deny', reason: `${spec.name}：${reason}`, replacement: spec.reply })
    return {
      name: spec.name,
      say: async (text: string, channel: SayChannel, context?: SayContext): Promise<Verdict> => {
        if (channel !== 'text') return { kind: 'allow' }
        if (context?.caller === undefined) return deny('拿不到调用方身份，确认不了前置事实')
        // 事实成立就放行，不问模型——正常会话里认过人之后的每一句都不花钱。
        if (context.caller.succeeded.has(spec.requires)) return { kind: 'allow' }
        const options: GenerateOptions = {
          provider: spec.provider, model: spec.model,
          system: TOPIC_SYSTEM(spec.topic),
          messages: [{ role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }],
        } as GenerateOptions
        const raw = (await judgeText(ctx, options)).trim()
        if (raw.includes('不涉及')) return { kind: 'allow' }
        if (raw.includes('涉及')) return deny(`本次会话尚未完成「${spec.requires}」，不能说受限内容`)
        // 含糊按涉及计，与其它语义判定一致。
        return deny(`判定器答得含糊（「${raw.slice(0, 20)}」），按涉及计`)
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
  if (spec.type === 'require-before-say') {
    // 直接构造调用方身份，不伪造会话事件——与 require-before 同一个理由（发现 18）。
    const probe = (c: FactSayCase): EvalProbe => ({
      label: `${c.before.join('+') || '（无前置）'} → ${c.say}`,
      denied: async (): Promise<boolean> => {
        const caller: Caller = { sessionId: 'spec-eval', events: [], succeeded: new Set(c.before) }
        const v = await only.say!(c.say, 'text', { messages: [], caller })
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

/** 一条替代话术撞上的约束。 */
export interface ReplacementHit {
  /** 哪条约束判它违规。 */
  constraint: string
  reason: string
  /** 判定时用的触发语境，给人看的一句话。 */
  trigger: string
}

/** 一条替代话术的交叉验收结果。 */
export interface ReplacementReport {
  /** 这句话是谁的替代话术。 */
  from: string
  text: string
  hits: ReplacementHit[]
  /** 没撞上任何约束才为真。 */
  ok: boolean
  /**
   * 是不是**终点串**——退无可退、吐出去就是用户看到的最后一句。
   *
   * 这一位决定严重级别，而级别的依据是运行时的真实后果（发现 31）：网关会让替代话术
   * 再过一遍闸，非终点的那些撞了就被换成终点串，所以后果是「话术从贴合场景降级成通用
   * 兜底」——质量损失，不是合规事故。终点串撞了才是没人接得住，那一条必须拦住冻结。
   *
   * 注意别把它读成「非终点的可以不管」：运行时那次再裁决**只判一次**，语义判定有方差
   * （发现 29 六：单次命中率低的到 0.55），实测仍有约 1/20 漏网。
   */
  terminal: boolean
}

/**
 * 把每条约束的触发条件构造出来：要判「这句话在那个语境下站不站得住」，
 * 得先把那个语境摆出来。
 *
 * `require-fallback` 用它自己声明的必拦提问当越界语境——没有声明必拦用例就构造不出
 * 触发条件，这条约束这一轮就判不了（机械闸本来就不让这种声明冻结）。
 */
function triggerContexts(spec: ConstraintSpec): { context: SayContext; trigger: string }[] {
  if (spec.type === 'require-fallback') {
    return (spec.evals?.deny ?? []).map(c => ({
      context: {
        messages: [{
          role: 'user', content: [{ type: 'text', text: c.ask }], source: { kind: 'user' },
        }] as unknown as readonly Message[],
      },
      trigger: `用户问「${c.ask}」`,
    }))
  }
  if (spec.type === 'require-before-say') {
    return [{
      context: {
        messages: [],
        caller: { sessionId: 'replacement-check', events: [], succeeded: new Set<string>() },
      },
      trigger: '前置事实未成立',
    }]
  }
  return [{ context: { messages: [] }, trigger: '无语境' }]
}

/**
 * 替代话术的交叉验收：拒绝换来的那句话，自己合不合别的规矩。
 *
 * 为什么必须单独验（发现 29）：替代话术是固定串，网关拿到 deny 之后把它直接塞进正文块，
 * **发出之前不再经过裁决**——它违反什么都不会有任何位置发现。而它是为某一条规矩的
 * 触发条件写的，换个语境就不一定站得住：实测里为 A2／B2 写的话术在越界语境下
 * 每条都不满足 D 的兜底义务。
 *
 * 每条替代话术拿**所有**约束判一遍，包括它自己那条——发现 27 里 B2 的替代话术被 B2
 * 自己判成「涉及账号」，那条手写规矩（把替代话术放进 allow 用例）这一步顺带机械化了。
 *
 * 要调模型，所以属于花钱那一轮，不进 `checkSpecHygiene`。
 *
 * @param ctx - 宿主 context。
 * @param specs - 约束声明。
 * @param extra - 声明之外的替代话术，比如 `installSayGate` 那个网关兜底串——
 *   它不在任何一条声明里，不送进来就查不到。网关兜底串要带 `terminal: true`：
 *   它是退无可退的那一句，级别与其余的不同（见 {@link ReplacementReport.terminal}）。
 *   声明自带的 `reply` 一律不是终点——运行时够得着它们。
 * @param options - `repeats` 是每个语境判几次，缺省 1。**语义判定有方差**，判一次会漏。
 *   实测（两轮各 20 次，共 40 次；对照两侧干净：明确违规 40/40、干净话术 0/40）：
 *   网关兜底串对 D 单次命中 35/40，B2 的替代话术对 D 只有 **22/40**，对 B2 自己 29/40。
 *   按最难的那条 p̂=0.55 算，判 n 次抓得住的概率是 1-(1-p)^n：n=1 是 55%、n=3 是 91%、
 *   n=5 是 98%；把 p̂ 的 95% 置信下界 0.40 也算进去，n=5 仍有 92%、要 95% 得 n≥6。
 *   **拿它当冻结闸建议 5**，代价是每加一次就多一轮全部判定调用。任一次判违规即记一次撞上。
 * @returns 每条替代话术一份报告；任一 `ok` 为假就不应冻结。
 */
export async function checkReplacements(
  ctx: Context,
  specs: readonly ConstraintSpec[],
  extra: readonly { from: string; text: string; terminal?: boolean }[] = [],
  options: { repeats?: number } = {},
): Promise<ReplacementReport[]> {
  const repeats = Math.max(1, options.repeats ?? 1)
  const compiled = compileConstraints(ctx, specs)
  const targets: { from: string; text: string; terminal: boolean }[] = [
    ...specs.flatMap(s => {
      const reply = (s as { reply?: unknown }).reply
      return typeof reply === 'string' ? [{ from: s.name, text: reply, terminal: false }] : []
    }),
    ...extra.map(e => ({ ...e, terminal: e.terminal ?? false })),
  ]
  const reports: ReplacementReport[] = []
  for (const t of targets) {
    const hits: ReplacementHit[] = []
    for (let i = 0; i < specs.length; i++) {
      const spec = specs[i]!
      const c = compiled[i]!
      if (c.say === undefined) continue                 // 工具侧的约束管不到说的话
      let hit: ReplacementHit | undefined
      for (const { context, trigger } of triggerContexts(spec)) {
        for (let n = 0; n < repeats && hit === undefined; n++) {
          const v = await c.say(t.text, 'text', context)
          if (v.kind === 'deny') hit = { constraint: spec.name, reason: v.reason, trigger }
        }
        // 一条约束只记第一个撞上的语境，够定位了，不刷屏。
        if (hit !== undefined) break
      }
      if (hit !== undefined) hits.push(hit)
    }
    reports.push({ ...t, hits, ok: hits.length === 0 })
  }
  return reports
}

/**
 * 把替代话术的交叉验收排成一段可读文本。两级分开说——级别的依据见
 * {@link ReplacementReport.terminal}。
 */
export function formatReplacementReports(reports: readonly ReplacementReport[]): string {
  const blocking = reports.filter(r => !r.ok && r.terminal)
  const degraded = reports.filter(r => !r.ok && !r.terminal)
  const mark = (r: ReplacementReport): string => r.ok ? '✓' : r.terminal ? '✗' : '·'
  const lines = reports.map(r => [
    `${mark(r)} [${r.from}]${r.terminal ? '（终点串）' : ''}「${r.text}」`,
    ...r.hits.map(h => `    撞上 ${h.constraint}（${h.trigger}）：${h.reason}`),
    ...r.ok || r.terminal ? [] : ['    → 运行时会退到终点串（只判一次，有方差漏网）'],
  ].join('\n'))
  const head: string[] = []
  if (blocking.length > 0) head.push(`✗ ${blocking.length} 条终点串自己违规，不应冻结`)
  if (degraded.length > 0) {
    head.push(`· ${degraded.length}/${reports.length} 条替代话术撞上别的规矩，`
      + '运行时会退到终点串——话术降级，不拦冻结')
  }
  if (head.length === 0) head.push(`✓ ${reports.length} 条替代话术都没撞上别的规矩`)
  return [...head, ...lines].join('\n')
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
