/**
 * 通用评测框架：把一份 spec 的评测用例，在独立 context 里对候选插件重放。
 *
 * 两条通道，对应约束的两个挂载点：
 *   工具通道 —— 步骤走 `ctx.tools.execute`，插件挂 `tools/pre-execute` / `tools/post-execute`
 *   说话通道 —— 步骤走 `llm/stream` waterfall，插件挂 `llm/stream` 改写模型要说出的话
 *
 * 用同一套结构表达四档约束：
 *   无状态   —— 单次调用，看参数决定放行/拒绝（assert: allowed / denied）
 *   有状态   —— 决策依赖历史，用调用序列表达（steps 多步，assert 判最后一步）
 *   看产出   —— 不是放行/拒绝，而是工具产出须满足谓词（assert: output-includes / output-excludes）
 *   看说话   —— agent 对用户说出的文本须满足谓词（assert: said-includes / said-excludes）
 *
 * 判定器是固定代码，不含任何模型；每条用例在全新 context 独立重放，
 * 状态不跨用例泄漏。只返回可观测差异。
 *
 * @module thymus/eval-framework
 */
import { Context } from '@deepseek-ai/cordis'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import LlmRuntime, { BlockAssembler, CallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import DynamicCordisRunner from '@deepseek-ai/dsh-cordis-host-runner'

/** 一步工具调用。缺省 kind 即为工具步，保持既有用例不用改。 */
export interface EvalToolStep {
  kind?: 'tool'
  tool: string
  args: Record<string, unknown>
  /**
   * 可选桩返回值：本步该工具应返回的文本。用于「看产出」类评测——
   * 让出题方掌控工具返回的内容，而不是依赖环境写死的固定值。
   * 声明后，判定器用它覆盖该工具本次的产出（在插件的 post-execute 之前）。
   */
  stubReturn?: string
}

/** 一次说话：模型欲对用户说出 text，这段文本要过 `llm/stream`。 */
export interface EvalSayStep {
  kind: 'say'
  text: string
}

/** 一步：工具调用，或一次说话。 */
export type EvalStep = EvalToolStep | EvalSayStep

/** 对最后一步可观测结果的断言。 */
export interface EvalAssert {
  /**
   * allowed         —— 调用被放行（正常返回）
   * denied          —— 调用被拒绝（返回错误）
   * output-includes —— 调用正常返回，且产出文本包含 value
   * output-excludes —— 调用正常返回，且产出文本不包含 value
   * said-includes   —— 最后一个 say 步改写后的文本包含 value
   * said-excludes   —— 最后一个 say 步改写后的文本不包含 value
   * said-equals     —— 最后一个 say 步改写后的文本与 value 逐字相等
   *
   * 回归集要用 `said-equals` 而不是 `said-includes`：后者判的是「原文还在里面」，
   * 一个给文本加前缀的插件（`【已优化】原文`）照样通过——抓得住删改，抓不住添加。
   * 这是拿合成的过度改写插件做阳性对照时暴露出来的。
   */
  kind: 'allowed' | 'denied' | 'output-includes' | 'output-excludes'
    | 'said-includes' | 'said-excludes' | 'said-equals'
  value?: string
}

/** 一条评测用例：一段步骤序列 + 对最后一步的断言。 */
export interface EvalCase {
  description: string
  steps: EvalStep[]
  assert: EvalAssert
}

/** 判定器的可选装配。 */
export interface JudgeOptions {
  /**
   * opt-in：给判定用的 context 装上 `LlmRuntime`，让「自己要调模型」的插件
   * （`inject: ['llm']`，在 `llm/stream` 里再发起一次模型调用）能挂得起来。
   * 缺省不装——既有 spec 保持确定性、不花钱；不装时这类插件拿不到 llm 服务，
   * `apply` 不会执行，插件静默失效。
   *
   * 回调在 `LlmRuntime` 之后、候选插件挂载之前调用，由调用方决定接哪个
   * provider：真 provider 插件（要 API key、要花钱），或测试用的假 adapter
   * （`ctx.llm.registerAdapter(['fake'], adapter)`）。判定器不认识任何 provider。
   */
  llm?: (ctx: Context) => void | Promise<void>
}

/** 判定结果。 */
export interface JudgeResult {
  passed: boolean
  diffs: string[]
}

interface CaseOutcome {
  error?: string
  lastText: string
  lastIsError: boolean
  /** 最后一个 say 步经 `llm/stream` 改写后的文本；本用例无 say 步时为 undefined。 */
  saidText?: string
  /** 最后一步走的通道；空用例为 undefined。 */
  lastChannel?: 'tool' | 'say'
}

/** 说话通道的假上游：一段文本按 dsh 的 chunk 协议发出（block-start → text-delta → block-end → finish）。 */
function sayUpstream(text: string): AsyncIterable<StreamChunk> {
  return (async function* (): AsyncGenerator<StreamChunk> {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })()
}

/**
 * 重放一次说话：直接 dispatch `llm/stream` waterfall（waterfall 是 ctx 上的事件
 * 分发，不依赖 LlmRuntime 那个服务实例，所以缺省不装它也能重放），把假上游喂
 * 进去，用 dsh 自己的 BlockAssembler 归集下游产出。归集算法与 agent loop 落进
 * assistant 消息用的是同一份，所以判定器看到的文本就是用户会看到的文本。
 *
 * provider/model 固定为 `judge`：这段不经过任何 provider（上游是假的），但插件
 * 若要防递归，可用它区分「用户看的话」与「自己发起的判定调用」。
 */
async function runSay(ctx: Context, text: string): Promise<string> {
  const options: GenerateOptions = { provider: 'judge', model: 'judge', messages: [] }
  const stream = ctx.waterfall(ctx as never, 'llm/stream', options, () => sayUpstream(text))
  const assembler = new BlockAssembler()
  for await (const chunk of stream) assembler.push(chunk)
  return assembler.blocks().filter(b => b.type === 'text').map(b => b.text).join('')
}

/** 在全新 context 挂载一组候选插件，按序执行一条用例的所有步骤，返回最后一步的可观测结果。 */
async function runCase(
  sources: readonly string[],
  c: EvalCase,
  makeTools: () => ToolDefinition[],
  options: JudgeOptions,
): Promise<CaseOutcome> {
  const ctx = new Context()
  await ctx.plugin(Timer)
  if (options.llm !== undefined) {
    await ctx.plugin(LlmRuntime)
    await options.llm(ctx)
  }
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(DynamicCordisRunner, {})
  const agent = { id: 'judge' } as never
  // 收集本用例各工具步声明的桩返回值：工具名 → 返回文本。
  const stubs = new Map<string, string>()
  for (const step of c.steps) {
    if (step.kind !== 'say' && step.stubReturn !== undefined) stubs.set(step.tool, step.stubReturn)
  }
  for (const tool of makeTools()) {
    if (stubs.has(tool.name)) {
      const ret = stubs.get(tool.name)!
      ctx.tools.register({ ...tool, execute: (): Promise<string> => Promise.resolve(ret) })
    } else {
      ctx.tools.register(tool)
    }
  }

  // 组内每个插件独立 define + run，全部挂进同一运行时——真实部署的形态。
  for (let i = 0; i < sources.length; i++) {
    try {
      const { pluginId, packageId } = ctx.dynamicCordisRunner.define({
        sessionId: 'judge' as never,
        plugin: { kind: 'new', idPrefix: 'cand' },
        name: `candidate-${i}`, purpose: 'eval candidate',
        code: { host: sources[i]! },
      })
      const receipt = await ctx.dynamicCordisRunner.run(agent, pluginId, packageId, 'run')
      if (!receipt.ok) return { error: `插件[${i}]无法挂载：${receipt.message}`, lastText: '', lastIsError: true }
    } catch (e) {
      return { error: `插件[${i}]无法挂载：${e instanceof Error ? e.message.split('\n')[0] : String(e)}`, lastText: '', lastIsError: true }
    }
  }

  let lastText = ''
  let lastIsError = false
  let saidText: string | undefined
  let lastChannel: 'tool' | 'say' | undefined
  let n = 0
  for (const step of c.steps) {
    if (step.kind === 'say') {
      saidText = await runSay(ctx, step.text)
      lastChannel = 'say'
      continue
    }
    const res = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId(`judge-${++n}`),
      name: step.tool,
      arguments: step.args,
      agent,
    })
    const first = res.content[0]
    lastText = first?.type === 'text' ? first.text : ''
    lastIsError = res.isError
    lastChannel = 'tool'
  }
  return { lastText, lastIsError, saidText, lastChannel }
}

/** 检查一条用例的断言，返回可观测差异（通过则返回 undefined）。 */
function checkAssert(c: EvalCase, o: CaseOutcome): string | undefined {
  const { kind, value } = c.assert
  switch (kind) {
    case 'said-includes':
    case 'said-excludes':
    case 'said-equals': {
      if (o.saidText === undefined) return `断言 ${kind} 判说话通道，但本用例没有 say 步`
      if (kind === 'said-equals') {
        return o.saidText === (value ?? '')
          ? undefined
          : `说的话应与原文逐字相同，实际说出「${o.saidText}」`
      }
      const hit = o.saidText.includes(value ?? '')
      if (kind === 'said-includes') return hit ? undefined : `说的话应包含「${value}」，实际说出「${o.saidText}」`
      return hit ? `说的话不应包含「${value}」，实际说出「${o.saidText}」` : undefined
    }
    case 'allowed':
    case 'denied':
    case 'output-includes':
    case 'output-excludes': {
      if (o.lastChannel === 'say') {
        return `断言 ${kind} 判工具通道，但本用例最后一步是 say 步（应改用 said-includes / said-excludes）`
      }
      break
    }
  }
  switch (kind) {
    case 'allowed':
      return o.lastIsError ? '期望放行，实际被拒绝' : undefined
    case 'denied':
      return o.lastIsError ? undefined : '期望拒绝，实际放行了'
    case 'output-includes':
      if (o.lastIsError) return '期望正常返回，实际被拒绝'
      return o.lastText.includes(value ?? '') ? undefined : `产出应包含「${value}」，实际未包含`
    case 'output-excludes':
      if (o.lastIsError) return '期望正常返回，实际被拒绝'
      return o.lastText.includes(value ?? '') ? `产出不应包含「${value}」，实际包含了` : undefined
    default:
      return undefined
  }
}

/** 一条负向断言：不挂任何插件时它就该垮。 */
const NEGATIVE = new Set(['denied', 'output-excludes', 'said-excludes'])

/** 评测集的梯度体检结果。 */
export interface GradientReport {
  /** 通过体检：整组有梯度，且没有死掉的负向用例。 */
  ok: boolean
  total: number
  /** 空插件组下垮掉的条数。为 0 说明这组评测奖励「什么都不拦」。 */
  brokenByEmpty: number
  /** 负向断言却在空插件组下也通过的用例——它们没有判别力，是死用例。 */
  deadNegatives: string[]
  /** 空插件组下通过的正向用例数。过度改写对照本就该在这里，属正常。 */
  passingPositives: number
}

/**
 * 评测集的梯度体检：把整组用例对**空插件组**重放一遍。
 *
 * 冻结一组评测之前该跑这个。发现 03 里自造评测的断言方向整个反了，
 * 空插件组 24/24 全过，而三方独立闭环里没有任何位置能发现题错了——
 * 这类错是机械挡得住的，就不该留给人。
 *
 * 判据分正负向，不能简单要求「空组必须全垮」：
 *   负向断言（denied / output-excludes / said-excludes）—— 空组下**每一条都该垮**。
 *     垮不掉说明这条没有判别力（断言的词根本不会出现），是死用例。
 *   正向断言（allowed / output-includes / said-includes）—— 空组下通过是正常的，
 *     过度改写对照就该长这样。这里只计数，不判错。
 *
 * @param cases - 待冻结的评测用例。
 * @param makeTools - 该 spec 的环境工具集。
 * @param options - 见 {@link JudgeOptions}；缺省不装 LlmRuntime。
 * @returns 体检结果；`ok` 为 false 时不应冻结这组评测。
 */
export async function checkEvalGradient(
  cases: readonly EvalCase[],
  makeTools: () => ToolDefinition[],
  options: JudgeOptions = {},
): Promise<GradientReport> {
  let brokenByEmpty = 0
  let passingPositives = 0
  const deadNegatives: string[] = []
  for (const c of cases) {
    const r = await judgeCases([], [c], makeTools, options)
    if (!r.passed) { brokenByEmpty++; continue }
    if (NEGATIVE.has(c.assert.kind)) deadNegatives.push(c.description)
    else passingPositives++
  }
  return {
    ok: brokenByEmpty > 0 && deadNegatives.length === 0,
    total: cases.length, brokenByEmpty, deadNegatives, passingPositives,
  }
}

/**
 * 对候选插件重放整组评测用例。
 * @param source - 开发方提交的宿主半插件源码，单个或一组（一组则全部挂进同一运行时）。
 * @param cases - 冻结的评测用例。
 * @param makeTools - 该 spec 的环境工具集（每条用例重新构造，避免状态跨例泄漏）。
 * @param options - 可选装配，见 {@link JudgeOptions}；缺省不装 LlmRuntime。
 * @returns 判定结果，diffs 仅含可观测差异。
 */
export async function judgeCases(
  source: string | readonly string[],
  cases: readonly EvalCase[],
  makeTools: () => ToolDefinition[],
  options: JudgeOptions = {},
): Promise<JudgeResult> {
  const sources = typeof source === 'string' ? [source] : source
  const diffs: string[] = []
  for (const c of cases) {
    const outcome = await runCase(sources, c, makeTools, options)
    if (outcome.error !== undefined) { diffs.push(`用例「${c.description}」：${outcome.error}`); continue }
    const diff = checkAssert(c, outcome)
    if (diff !== undefined) diffs.push(`用例「${c.description}」：${diff}`)
  }
  return { passed: diffs.length === 0, diffs }
}
