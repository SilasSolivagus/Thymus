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
 *   说话通道 —— 包住 `ctx.llm.prepareCall`：整条流收完、装配，再对**装配后的文本**裁决。
 *               `llm/stream` 的 waterfall 在这一层里面跑完，链内插件能改写文本，
 *               但改不掉「装配完还要过一道」这件事。agent 走的是
 *               `preparedCall.stream()`，`ctx.llm.stream` 一次都不响（发现 17）。
 *
 * 约束在这里是宿主侧的普通对象，不经 DynamicCordisRunner——所以也不在动态注册表里，
 * `listPlugins` 看不到、`stop` 够不着（发现 09 组二已实测）。
 *
 * @module thymus/gate
 */
import { Context } from '@deepseek-ai/cordis'
import { BlockAssembler } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmCallConfig, Message, PreparedLlmCall, StreamChunk } from '@deepseek-ai/dsh-llm'
import { TOOL_RUNTIME_SCHEDULER } from '@deepseek-ai/dsh-tools'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

/**
 * 一条判决。没有 `ask`——这一层只做确定性裁决，要人介入是上层的事。
 *
 * `deny` 可以自带 `replacement`：「必须走兜底」这类约束知道该改说什么，
 * 而网关的通用替代话术不知道。给了就用它，没给才用网关那句。
 */
export type Verdict =
  | { kind: 'allow' }
  | { kind: 'deny'; reason: string; replacement?: string }

/** 说话通道分两条：说给用户看的正文，和模型的思考块。 */
export type SayChannel = 'text' | 'reasoning'

/**
 * 裁决一段话时的会话上下文。
 *
 * 有的规矩光看这一句判不了：「越界必须转出」要先知道用户问的是什么。
 * 运行时网关这一层拿得到——它包的是 `stream(options)`，`options.messages`
 * 就是这次发给模型的完整对话。**拿不到上下文时是 `undefined`**
 * （`gateSay` 那条单句判定的路径就没有），要上下文的约束应当据此拒绝，
 * 而不是当成「没有上下文＝没有越界」。
 */
export interface SayContext {
  /** 这次请求发给模型的完整对话。注意工具结果的 `role` 也是 `user`，靠 `source.kind` 区分。 */
  messages: readonly Message[]
}

/** 一条约束多久不给判决就按 deny 计。挂住的约束不能变成放行。 */
export const DEFAULT_VERDICT_TIMEOUT_MS = 10_000

/** 复用的放行判决。 */
const ALLOW: Verdict = { kind: 'allow' }

/** 判决形状校验：不是这两种形状的一律不认。 */
function isVerdict(v: unknown): v is Verdict {
  if (typeof v !== 'object' || v === null) return false
  const kind = (v as { kind?: unknown }).kind
  if (kind === 'allow') return true
  if (kind !== 'deny' || typeof (v as { reason?: unknown }).reason !== 'string') return false
  const replacement = (v as { replacement?: unknown }).replacement
  return replacement === undefined || typeof replacement === 'string'
}

/**
 * 发起这次调用的一方。
 *
 * 跨调用记事的约束（「没认人之前不许查账单」这一类）靠它取事实：**从事件日志读，
 * 不要从当前 surface 读**——压缩只动 surface，工具结果剪枝是追加一条盖上去，
 * 日志两边都只增不减，换宿主 resume 之后事实照样在（发现 19）。
 */
export interface Caller {
  /** 会话身份，与 `agent.id` 同值。 */
  sessionId: string
  /** 这个会话到此刻为止的事件日志。手写约束要问日志里别的事实时用它。 */
  events: readonly SessionEvent[]
  /**
   * 本会话里**成功调用过**的工具名。声明式约束只看这个，不自己解析事件——
   * 解析写两遍就会有两处一起写错、互相掩盖的机会（发现 18 栽过一次）。
   * 首次读取时才解析。
   */
  readonly succeeded: ReadonlySet<string>
}

/** 一次工具调用里裁决者看得到的部分。 */
export interface ToolCall {
  name: string
  arguments: Record<string, unknown>
  /**
   * 发起方。**可能没有**：外部调用方不带 agent 时就没有身份可给
   * （评测框架自己发起的调用即是）。要按会话记事的约束在这种情况下应当拒绝，
   * 而不是当成「没记录＝没违规」。
   */
  caller?: Caller
}

/** 一条约束。三个位置各自可选，只实现关心的那个。 */
export interface Constraint {
  name: string
  /**
   * 派发之前裁决一次工具调用。
   * 要按会话记事就读 `call.caller`——它可能没有，那种情况下应当拒绝。
   */
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
  /**
   * 裁决一段要说给用户的话。
   *
   * `channel` 区分正文与思考块，两条**分开送来、各判一次**：拼成一段判，判定器拿到的是
   * 两段性质不同的文本粘在一起（发现 17 第五节）。只判正文则禁语会从思考块原样漏出。
   */
  say?: (text: string, channel: SayChannel, context?: SayContext) => Verdict | Promise<Verdict>
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

/** dsh 那边一次执行里这一层读得到的字段。 */
interface ExecutionView {
  name: string
  arguments?: unknown
  agent?: { id?: string; session?: { events?: readonly SessionEvent[] } }
}

/**
 * 从事件日志里解析出「本会话成功调用过哪些工具」。
 *
 * 名字只在 `tool/call` 上，成败只在 `tool/result` 的结果块上，两者按 callId 对上。
 * 这个形状是从真会话 dump 出来的，不是按印象写的（发现 18）。
 * 读日志而不是读当前 surface：压缩只替换 surface、工具结果剪枝是追加一条盖上去，
 * 日志两边都只增不减（发现 19）。剪枝后同一个 callId 会有两条结果，Set 自然去重。
 */
function succeededTools(events: readonly SessionEvent[]): ReadonlySet<string> {
  const names = new Map<string, string>()
  const done = new Set<string>()
  for (const ev of events) {
    const e = ev as { type?: string; data?: Record<string, unknown> }
    if (e.type === 'tool/call') {
      const { name, callId } = e.data ?? {}
      if (typeof name === 'string' && callId !== undefined) names.set(String(callId), name)
      continue
    }
    if (e.type !== 'tool/result') continue
    const blocks = (e.data?.message as { content?: { type?: string; toolCallId?: string; isError?: boolean }[] } | undefined)?.content ?? []
    for (const b of blocks) {
      if (b.type !== 'tool-result' || b.toolCallId === undefined || b.isError === true) continue
      const name = names.get(String(b.toolCallId))
      if (name !== undefined) done.add(name)
    }
  }
  return done
}

/** 造一个 {@link Caller}；`succeeded` 到用的时候才解析。 */
function callerOf(id: string, events: readonly SessionEvent[]): Caller {
  let cached: ReadonlySet<string> | undefined
  return {
    sessionId: id,
    events,
    get succeeded(): ReadonlySet<string> {
      cached ??= succeededTools(events)
      return cached
    },
  }
}

/**
 * 从一次执行里取裁决者看得到的部分。
 *
 * 身份来自 `exec.agent`：调度器路径上 agent-loop 会填好它，`agent.id` 就是 sessionId，
 * 顺着 `agent.session.events` 拿得到整条会话日志（发现 18）。外部调用方不带 agent 时
 * `caller` 留空，而不是编一个空会话——「没有身份」和「有身份但没记录」必须能分开。
 */
function toolCallOf(exec: ExecutionView): ToolCall {
  const args = exec.arguments
  const call: ToolCall = {
    name: exec.name,
    arguments: typeof args === 'object' && args !== null ? args as Record<string, unknown> : {},
  }
  const id = exec.agent?.id
  const events = exec.agent?.session?.events
  if (id === undefined || events === undefined) return call
  return { ...call, caller: callerOf(id, events) }
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
  const preVerdict = async (call: ToolCall): Promise<Verdict> =>
    adjudicate(constraints, c => c.preTool?.(call), timeoutMs)

  // 路径一：`ctx.tools.execute`——外部调用方走这条。
  const innerExecute = (runtime.execute as (c: never) => Promise<ToolResult>).bind(ctx.tools)
  runtime.execute = async (call: never): Promise<ToolResult> => {
    const toolCall = toolCallOf(call as unknown as ExecutionView)
    const verdict = await preVerdict(toolCall)
    if (verdict.kind === 'deny') return denyResult(verdict.reason)
    return rewriteResult(constraints, toolCall, await innerExecute(call))
  }

  // 路径二：调度器——**agent-loop 走这条，而且不经过 execute**（实测两条完全独立）。
  // 只包 execute 的话，agent 自己发起的调用一次都不会被裁决。
  const sched = runtime[TOOL_RUNTIME_SCHEDULER] as Record<string, (...a: never[]) => unknown>
  const innerPrepare = sched.prepare!.bind(sched)
  sched.prepare = async (...a: never[]): Promise<unknown> => {
    const exec = a[0] as unknown as ExecutionView
    const prepared = await innerPrepare(...a) as { kind: string; exec: unknown }
    const verdict = await preVerdict(toolCallOf(exec))
    // 工具体在 dispatch 阶段才跑，所以这里拒绝仍然拦得住它执行。
    return verdict.kind === 'deny'
      ? { kind: 'final-result', exec: prepared.exec, result: denyResult(verdict.reason) }
      : prepared
  }
  const innerFinalize = sched.finalize!.bind(sched)
  sched.finalize = async (...a: never[]): Promise<unknown> => {
    const exec = a[0] as unknown as ExecutionView
    const result = await innerFinalize(...a) as ToolResult
    return rewriteResult(constraints, toolCallOf(exec), result)
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
  // 这条路径没有会话上下文：假上游是我们自己起的，`messages` 是空的。
  // 不传 `context` 而不是传一个空对话——要上下文的约束得能分清「没有」和「空」。
  return { verdict: await adjudicate(constraints, c => c.say?.(assembled, 'text'), timeoutMs), assembled }
}

/** 一个 chunk 属于哪种块。`usage` / `finish` 不属于任何块。 */
function channelOf(chunk: StreamChunk): string | undefined {
  switch (chunk.type) {
    case 'block-start': return chunk.blockType
    case 'text-delta': return 'text'
    case 'reasoning-delta': return 'reasoning'
    case 'tool-call-delta': return 'tool-call'
    case 'block-end': return chunk.block.type
    default: return undefined
  }
}

/** 把装配后的块里某一类的文本拼起来。 */
function joinBlocks(blocks: readonly { type: string }[], type: SayChannel): string {
  return blocks.filter(b => b.type === type).map(b => (b as { text?: string }).text ?? '').join('')
}

/**
 * 按判决重发缓冲下来的流。
 *
 * 正文被拒：整段换成 `replacement`，落在第一个正文块的位置上，其余正文块丢掉。
 * 思考块被拒：整块丢掉——思考不是话，塞一句替代话术进去等于造出模型没想过的思考。
 * 其余 chunk（工具调用、usage、finish）原样透传：**拒绝只换话，不停这一轮**。
 */
function* rewriteSay(
  buffered: readonly StreamChunk[],
  denied: { text: boolean; reasoning: boolean },
  replacement: string,
): Generator<StreamChunk> {
  let replaced = false
  for (const chunk of buffered) {
    const channel = channelOf(chunk)
    if (channel === 'reasoning' && denied.reasoning) continue
    if (channel === 'text' && denied.text) {
      if (replaced || chunk.type !== 'block-start') continue
      replaced = true
      yield { type: 'block-start', index: chunk.index, blockType: 'text' }
      yield { type: 'text-delta', index: chunk.index, text: replacement }
      yield { type: 'block-end', index: chunk.index, block: { type: 'text', text: replacement } }
      continue
    }
    yield chunk
  }
}

/** `ctx.llm` 上这一层要包的入口。 */
interface LlmEntry {
  prepareCall(config: LlmCallConfig, signal?: AbortSignal): Promise<PreparedLlmCall>
}

/**
 * 装说话通道网关：包住 `ctx.llm.prepareCall`，整条流收完、装配后裁决，再按 chunk 协议重发。
 *
 * 为什么是这个位置（发现 17 实测）：
 *   - `ctx.llm.stream` **命中 0 次**。`agent.ts` 走 `preparedCall.stream()`，公开的
 *     `stream` 只在没注册 adapter 时才是退路——和工具侧 `execute` 同一个坑。
 *   - `llm/stream` 是包装链，最外层说了算而 `prepend` 两边都能用，挂在那里是抢位竞赛。
 *     包住 `prepareCall` 则整条 waterfall 在这一层里面跑完，链内谁抢赢都不影响裁决依据。
 *   - **必须整条流收完再决定**：agent loop 每收一个 chunk 就落一条 `assistant/chunk`，
 *     先放行再改就晚了——事件已落库、流式 UI 已经渲染过。
 *
 * 拒绝的语义：正文换成替代话术，思考块整块丢掉，**这一轮不停**——同一条消息里的
 * 工具调用照常发出、照常执行。要连带停轮是上层的事，这一层不做。
 * 替代话术优先用判决自带的（`Verdict.replacement`），没有才用这里的 `replacement`。
 *
 * 裁决时把这次请求的完整对话作为 {@link SayContext} 交给约束——有的规矩光看这一句判不了。
 *
 * 限制，用之前先认：`prepareCall` 这个入口沙箱里的动态插件也够得到，后包的在外面。
 * 所以这道网关拦得住话，拦不住一个能挂动态插件的业务 agent（发现 17 臂 C）。
 * 它要成立，前提是不给业务 agent cordis 动态插件工具。
 *
 * @param ctx - 宿主 context。
 * @param constraints - 参与裁决的约束。
 * @param replacement - 正文被拒时改说的那句话。
 * @param timeoutMs - 单条约束的判决超时，缺省 {@link DEFAULT_VERDICT_TIMEOUT_MS}。
 */
export function installSayGate(
  ctx: Context, constraints: readonly Constraint[], replacement: string, timeoutMs?: number,
): void {
  const llm = ctx.llm as unknown as LlmEntry
  const inner = llm.prepareCall.bind(llm)
  llm.prepareCall = async (config: LlmCallConfig, signal?: AbortSignal): Promise<PreparedLlmCall> => {
    const prepared = await inner(config, signal)
    const dispatch = prepared.stream.bind(prepared)
    // 原句柄是 Object.freeze 的，改不动它的 stream，只能整个换一个（发现 17）。
    return {
      ...prepared,
      stream: (options: GenerateOptions): AsyncIterable<StreamChunk> => (async function* (): AsyncGenerator<StreamChunk> {
        const buffered: StreamChunk[] = []
        const assembler = new BlockAssembler()
        for await (const chunk of dispatch(options)) {
          buffered.push(chunk)
          assembler.push(chunk)
        }
        const blocks = assembler.blocks()
        const text = joinBlocks(blocks, 'text')
        const reasoning = joinBlocks(blocks, 'reasoning')
        // 两条通道分开判，并行取判决——延迟取慢的那条，不累加。空的那条不判：
        // 没说话就没有可裁决的对象，也省掉一次语义判定的模型调用。
        const context: SayContext = { messages: options.messages }
        const [textVerdict, reasoningVerdict] = await Promise.all([
          text === '' ? ALLOW : adjudicate(constraints, c => c.say?.(text, 'text', context), timeoutMs),
          reasoning === '' ? ALLOW : adjudicate(constraints, c => c.say?.(reasoning, 'reasoning', context), timeoutMs),
        ])
        const denied = { text: textVerdict.kind === 'deny', reasoning: reasoningVerdict.kind === 'deny' }
        if (!denied.text && !denied.reasoning) { yield * buffered; return }
        // 约束自带的替代话术优先：它知道该改说什么，网关那句是兜底的兜底。
        const say = textVerdict.kind === 'deny' ? textVerdict.replacement ?? replacement : replacement
        yield * rewriteSay(buffered, denied, say)
      })(),
    }
  }
}
