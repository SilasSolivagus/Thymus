/**
 * 判决聚合层：把约束从「waterfall 上的同侪」改成「调用路径外的裁决者」。
 *
 * 发现 09 实测的问题：`tools/pre-execute` 是 waterfall，`{kind:'allow'}` 直接短路，
 * 先注册的先跑，而 `prepend` 两边都能用——所以「谁在前」是抢位竞赛，保证不住。
 * 只要被约束方能往同一条链上注册，任何约束都可被抢先架空。
 *
 * 借 Claude Code 的 PreToolUse 形态：匹配的 hook 并行跑，没有顺序，任一 deny 即拒绝，
 * allow 覆盖不了 deny。要害不是排序，是**聚合规则**——先到先得的链天然可抢位，
 * 收齐判决再裁决就不会。
 *
 * 这里的两个网关都站在链外：
 *   工具通道 —— 包住调度器的 `prepare`（拒绝）与 `finalize`（改写产出），另外仍包住
 *               `ctx.tools.execute`。真 agent 走的是调度器，`execute` 一次都不响，
 *               只服务外部调用方（发现 16）。链上的 handler 在 `prepare` 内部跑，
 *               它们再怎么抢位、返回什么，都要等这一层裁完才算数。
 *   说话通道 —— 先跑完整条 `llm/stream` waterfall 并装配，再对**装配后的文本**裁决。
 *               链内插件能改写文本，但改不掉「装配完还要过一道」这件事。
 *
 * 约束在这里是宿主侧的普通对象，不经 DynamicCordisRunner——所以也不在动态注册表里，
 * `listPlugins` 看不到、`stop` 够不着（发现 09 组二已实测）。
 *
 * @module thymus/gate
 */
import { Context } from '@deepseek-ai/cordis'
import { BlockAssembler } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { TOOL_RUNTIME_SCHEDULER } from '@deepseek-ai/dsh-tools'
import type {
  ScheduledToolPreparation, ToolExecutionInput, ToolExecutionResult, ToolRunContext,
} from '@deepseek-ai/dsh-tools'

/** 一条判决。没有 `ask`——这一层只做确定性裁决，要人介入是上层的事。 */
export type Verdict = { kind: 'allow' } | { kind: 'deny'; reason: string }

/** 一条约束多久不给判决就按 deny 计。挂住的约束不能变成放行。 */
export const DEFAULT_VERDICT_TIMEOUT_MS = 10_000

/** 判决形状校验：不是这两种形状的一律不认。 */
function isVerdict(v: unknown): v is Verdict {
  if (typeof v !== 'object' || v === null) return false
  const kind = (v as { kind?: unknown }).kind
  if (kind === 'allow') return true
  return kind === 'deny' && typeof (v as { reason?: unknown }).reason === 'string'
}

/** 一次工具调用里裁决者看得到的部分。 */
export interface ToolCall {
  name: string
  arguments: Record<string, unknown>
}

/** 一条约束。三个位置各自可选，只实现关心的那个。 */
export interface Constraint {
  name: string
  /** 派发之前裁决一次工具调用。 */
  preTool?: (call: ToolCall) => Verdict | Promise<Verdict>
  /**
   * 改写工具产出，在结果交回调用方**之前**生效——所以模型看到的就是改写后的。
   *
   * 这一手是实测逼出来的：模型复述工具产出时从不逐字，它会重组、会换说法，
   * 甚至能把内部信息完整说出去而字面一个字都对不上。所以「说话时检查有没有
   * 包含那个值」拦不住，只能让模型压根看不到。
   *
   * @returns 改写后的文本；返回 undefined 表示不改。抛错按拒绝整次调用处理——
   *   抹不掉就不能放行。
   */
  postTool?: (call: ToolCall, text: string) => string | undefined | Promise<string | undefined>
  /** 裁决一段要说给用户的话。 */
  say?: (text: string) => Verdict | Promise<Verdict>
}

/**
 * 聚合规则：任一 deny 即拒绝，与顺序无关；全 allow 才放行。
 * 判决并行求取，一条约束抛错按 deny 计——裁决者自己坏掉不能变成放行。
 * 三种「约束自己坏掉」的情形都按 deny 计，不能变成放行：抛错、超时、返回非法判决。
 * 约束并行求取，所以延迟取最慢的一条，不是累加。
 *
 * @param constraints - 参与本次裁决的约束。
 * @param ask - 向单条约束取判决；返回 undefined 表示该约束不管这个通道。
 * @param timeoutMs - 单条约束的判决超时，缺省 {@link DEFAULT_VERDICT_TIMEOUT_MS}。
 * @returns 第一条 deny（按约束声明顺序取，只影响报错文案），或 allow。
 */
export async function adjudicate(
  constraints: readonly Constraint[],
  ask: (c: Constraint) => (Verdict | Promise<Verdict>) | undefined,
  timeoutMs: number = DEFAULT_VERDICT_TIMEOUT_MS,
): Promise<Verdict> {
  const verdicts = await Promise.all(constraints.map(async (c): Promise<Verdict> => {
    // ask(c) 本身要放进 try：同步抛错的约束不能逃过裁决直接冒到调用方。
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const v = ask(c)
      if (v === undefined) return { kind: 'allow' }
      const settled = await Promise.race([
        Promise.resolve(v),
        new Promise<Verdict>(resolve => {
          timer = setTimeout(() => resolve({ kind: 'deny', reason: `约束「${c.name}」判决超时（${timeoutMs}ms）` }), timeoutMs)
        }),
      ])
      return isVerdict(settled) ? settled : { kind: 'deny', reason: `约束「${c.name}」返回了非法判决` }
    } catch (e) {
      return { kind: 'deny', reason: `约束「${c.name}」裁决失败：${e instanceof Error ? e.message : String(e)}` }
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }))
  return verdicts.find((v): v is { kind: 'deny'; reason: string } => v.kind === 'deny') ?? { kind: 'allow' }
}

/** 工具结果形状里这一层要构造或改写的部分。 */
interface ToolResult {
  content: { type: 'text'; text: string }[]
  isError: boolean
  error?: { message: string }
  value?: unknown
}

/**
 * 构造一个拒绝结果。**`error` 必须给**：调度器把 `{ isError, error, …presentation }`
 * 整体过 `snapshotJsonValue`，对象里带一个 `undefined` 属性就判为有损，抛
 * 「tool result must be losslessly JSON-serializable」。走 `execute` 不过这道校验，
 * 所以缺这个字段只会在真实链路上炸（发现 16）。
 */
function denyResult(reason: string): ToolResult {
  return { isError: true, error: { message: reason }, content: [{ type: 'text', text: reason }] }
}

/** 调度器视图上这一层要包的两个方法。dsh 把它标了 `@internal`，跨版本要重新核对。 */
interface SchedulerView {
  prepare(exec: ToolExecutionInput): Promise<ScheduledToolPreparation>
  finalize(exec: ToolRunContext, result: ToolExecutionResult): Promise<ToolExecutionResult>
}

/** 从一次执行输入里取裁决者看得到的部分。`arguments` 在 dsh 那边是 `unknown`。 */
function toolCallOf(exec: { name: string; arguments: unknown }): ToolCall {
  const args = exec.arguments
  return {
    name: exec.name,
    arguments: typeof args === 'object' && args !== null ? args as Record<string, unknown> : {},
  }
}

/**
 * 装工具通道网关：派发之前裁决，产出交回之前改写。
 *
 * 两条路径都要包，因为 agent 和外部调用方走的不是同一条（发现 16 实测：真 agent 跑一轮，
 * `execute` 命中 0 次）：
 *   调度器 `prepare` / `finalize` —— `agent-loop/tool-calls.ts` 实际走的路径。
 *   `ctx.tools.execute`          —— 外部调用方（含评测框架）走的路径。
 * 这两条在 dsh 里各自直达同一份私有实现、不互相转发，所以一次调用只被裁决一次。
 *
 * 必须在任何被约束方的代码加载之前装——和 seccomp 一样，先装过滤器再放行不受信任的代码。
 *
 * 未覆盖：`dispatch` 与 `finish` 没包。成功结果一律经 `finalize`，走 `finish` 的是
 * 出错结果和本层自己给出的拒绝，两者都没有可脱敏的产出。
 *
 * @param ctx - 宿主 context。
 * @param constraints - 参与裁决的约束。
 * @param timeoutMs - 单条约束的判决超时，缺省 {@link DEFAULT_VERDICT_TIMEOUT_MS}。
 */
export function installToolGate(
  ctx: Context, constraints: readonly Constraint[], timeoutMs?: number,
): void {
  const runtime = ctx.tools as unknown as Record<string | symbol, unknown>
  const preVerdict = async (name: string, args: Record<string, unknown>): Promise<Verdict> =>
    adjudicate(constraints, c => c.preTool?.({ name, arguments: args }), timeoutMs)

  // 路径一：`ctx.tools.execute`——外部调用方走这条。
  const innerExecute = (runtime.execute as (c: never) => Promise<ToolResult>).bind(ctx.tools)
  runtime.execute = async (call: never): Promise<ToolResult> => {
    const { name, arguments: args } = call as unknown as ToolCall
    const verdict = await preVerdict(name, args)
    if (verdict.kind === 'deny') return denyResult(verdict.reason)
    return rewriteResult(constraints, { name, arguments: args }, await innerExecute(call))
  }

  // 路径二：调度器——**agent-loop 走这条，而且不经过 execute**（实测两条完全独立）。
  // 只包 execute 的话，agent 自己发起的调用一次都不会被裁决。
  const sched = runtime[TOOL_RUNTIME_SCHEDULER] as Record<string, (...a: never[]) => unknown>
  const innerPrepare = sched.prepare!.bind(sched)
  sched.prepare = async (...a: never[]): Promise<unknown> => {
    const exec = a[0] as unknown as { name: string; arguments?: Record<string, unknown> }
    const prepared = await innerPrepare(...a) as { kind: string; exec: unknown }
    const verdict = await preVerdict(exec.name, exec.arguments ?? {})
    // 工具体在 dispatch 阶段才跑，所以这里拒绝仍然拦得住它执行。
    return verdict.kind === 'deny'
      ? { kind: 'final-result', exec: prepared.exec, result: denyResult(verdict.reason) }
      : prepared
  }
  const innerFinalize = sched.finalize!.bind(sched)
  sched.finalize = async (...a: never[]): Promise<unknown> => {
    const exec = a[0] as unknown as { name: string; arguments?: Record<string, unknown> }
    const result = await innerFinalize(...a) as ToolResult
    return rewriteResult(constraints, { name: exec.name, arguments: exec.arguments ?? {} }, result)
  }
}

/**
 * 逐条约束改写工具产出。多条按声明顺序串联，后一条看到的是前一条改完的。
 * 只有正常返回且首块是文本时才改——出错的结果没有可脱敏的产出。
 */
async function rewriteResult(
  constraints: readonly Constraint[], call: ToolCall, result: ToolResult,
): Promise<ToolResult> {
  const first = result.content[0]
  if (result.isError || first?.type !== 'text') return result
  let text = first.text
  for (const c of constraints) {
    if (c.postTool === undefined) continue
    try {
      const next = await c.postTool(call, text)
      if (typeof next === 'string') text = next
    } catch (e) {
      // 抹不掉就不能放行：脱敏失败留下的必须是拒绝，不是原文。
      return denyResult(`约束「${c.name}」改写产出失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }
  if (text === first.text) return result
  // value 是工具的原始返回值，改写后必须一并去掉——留着等于脱敏没做。
  const { value: _dropped, ...rest } = result as ToolResult & { value?: unknown }
  return { ...rest, content: [{ type: 'text', text }] }
}

/**
 * 安全地调一次模型并取回文本：**失败以抛错的形式暴露出来**。
 *
 * 直接用 `ctx.llm.stream` 有个坑：调用失败时它**不抛错**，而是发一个
 * `{ type:'finish', reason:{ kind:'error', … } }` 然后正常结束。只写 try/catch 的
 * 调用方拿到的是空文本并把它当成成功——于是 fail-open。实测：插件侧的词表兜底
 * 不会执行，网关侧的约束会返回 allow。
 *
 * 判定用的模型调用必须走这个函数，不要直接 for-await `ctx.llm.stream`。
 *
 * @param ctx - 宿主 context。
 * @param options - 传给 `ctx.llm.stream` 的请求。
 * @returns 装配后的文本。
 * @throws 调用未以 `stop` 结束时抛错——交给 {@link adjudicate} 按 deny 处理。
 */
export async function judgeText(ctx: Context, options: GenerateOptions): Promise<string> {
  let text = ''
  let finished = false
  for await (const chunk of ctx.llm.stream(options)) {
    const c = chunk as { type?: string; text?: string; block?: { type?: string; text?: string }; reason?: { kind?: string; failure?: { message?: string } } }
    if (c.type === 'text-delta' && typeof c.text === 'string') text += c.text
    else if (c.type === 'block-end' && c.block?.type === 'text' && typeof c.block.text === 'string') text = c.block.text
    else if (c.type === 'finish') {
      finished = true
      if (c.reason?.kind !== 'stop') {
        throw new Error(`判定调用未正常结束：${c.reason?.kind ?? '未知'}`
          + `${c.reason?.failure?.message === undefined ? '' : `（${c.reason.failure.message}）`}`)
      }
    }
  }
  if (!finished) throw new Error('判定调用没有给出结束原因')
  return text
}

/** 说话通道的假上游：一段文本按 dsh 的 chunk 协议发出。 */
function sayUpstream(text: string): AsyncIterable<StreamChunk> {
  return (async function* (): AsyncGenerator<StreamChunk> {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })()
}

/**
 * 说话通道网关：跑完整条 waterfall 并装配，再对装配后的文本裁决。
 * 装配算法与 agent loop 落进 assistant 消息的是同一份，所以裁决者看到的
 * 就是用户会看到的。
 * @param ctx - 宿主 context。
 * @param text - 模型欲说出的原文。
 * @param constraints - 参与裁决的约束。
 * @param timeoutMs - 单条约束的判决超时，缺省 {@link DEFAULT_VERDICT_TIMEOUT_MS}。
 * @returns 裁决结果与装配后的文本（deny 时文本仍返回，供归因用）。
 */
export async function gateSay(
  ctx: Context, text: string, constraints: readonly Constraint[], timeoutMs?: number,
): Promise<{ verdict: Verdict; assembled: string }> {
  const options: GenerateOptions = { provider: 'gate', model: 'gate', messages: [] }
  const stream = ctx.waterfall(ctx as never, 'llm/stream', options, () => sayUpstream(text))
  const assembler = new BlockAssembler()
  for await (const chunk of stream) assembler.push(chunk)
  const assembled = assembler.blocks().filter(b => b.type === 'text').map(b => b.text).join('')
  return { verdict: await adjudicate(constraints, c => c.say?.(assembled), timeoutMs), assembled }
}
