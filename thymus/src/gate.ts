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
 *   工具通道 —— 包住 `ctx.tools.execute`。链上的 handler 再怎么抢位、返回什么，
 *               都在这一层之后才有机会跑。
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

/** 一条判决。没有 `ask`——这一层只做确定性裁决，要人介入是上层的事。 */
export type Verdict = { kind: 'allow' } | { kind: 'deny'; reason: string }

/** 一次工具调用里裁决者看得到的部分。 */
export interface ToolCall {
  name: string
  arguments: Record<string, unknown>
}

/** 一条约束。两个通道各自可选，只实现关心的那个。 */
export interface Constraint {
  name: string
  preTool?: (call: ToolCall) => Verdict | Promise<Verdict>
  say?: (text: string) => Verdict | Promise<Verdict>
}

/**
 * 聚合规则：任一 deny 即拒绝，与顺序无关；全 allow 才放行。
 * 判决并行求取，一条约束抛错按 deny 计——裁决者自己坏掉不能变成放行。
 * @param constraints - 参与本次裁决的约束。
 * @param ask - 向单条约束取判决；返回 undefined 表示该约束不管这个通道。
 * @returns 第一条 deny（按约束声明顺序取，只影响报错文案），或 allow。
 */
export async function adjudicate<T>(
  constraints: readonly Constraint[],
  ask: (c: Constraint) => (Verdict | Promise<Verdict>) | undefined,
  _subject?: T,
): Promise<Verdict> {
  const verdicts = await Promise.all(constraints.map(async (c): Promise<Verdict> => {
    // ask(c) 本身要放进 try：同步抛错的约束不能逃过裁决直接冒到调用方。
    try {
      const v = ask(c)
      return v === undefined ? { kind: 'allow' } : await v
    } catch (e) {
      return { kind: 'deny', reason: `约束「${c.name}」裁决失败：${e instanceof Error ? e.message : String(e)}` }
    }
  }))
  return verdicts.find((v): v is { kind: 'deny'; reason: string } => v.kind === 'deny') ?? { kind: 'allow' }
}

/** `ctx.tools.execute` 的返回形状里这一层要构造的部分。 */
interface ToolResult {
  content: { type: 'text'; text: string }[]
  isError: boolean
}

/**
 * 装工具通道网关：包住 `ctx.tools.execute`，在派发之前裁决。
 * 必须在任何被约束方的代码加载之前装——和 seccomp 一样，先装过滤器再放行不受信任的代码。
 * @param ctx - 宿主 context。
 * @param constraints - 参与裁决的约束。
 */
export function installToolGate(ctx: Context, constraints: readonly Constraint[]): void {
  const runtime = ctx.tools as unknown as { execute: (call: never) => Promise<ToolResult> }
  const inner = runtime.execute.bind(runtime)
  runtime.execute = async (call: never): Promise<ToolResult> => {
    const { name, arguments: args } = call as unknown as ToolCall
    const verdict = await adjudicate(constraints, c => c.preTool?.({ name, arguments: args }))
    if (verdict.kind === 'deny') return { content: [{ type: 'text', text: verdict.reason }], isError: true }
    return inner(call)
  }
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
 * @returns 裁决结果与装配后的文本（deny 时文本仍返回，供归因用）。
 */
export async function gateSay(
  ctx: Context, text: string, constraints: readonly Constraint[],
): Promise<{ verdict: Verdict; assembled: string }> {
  const options: GenerateOptions = { provider: 'gate', model: 'gate', messages: [] }
  const stream = ctx.waterfall(ctx as never, 'llm/stream', options, () => sayUpstream(text))
  const assembler = new BlockAssembler()
  for await (const chunk of stream) assembler.push(chunk)
  const assembled = assembler.blocks().filter(b => b.type === 'text').map(b => b.text).join('')
  return { verdict: await adjudicate(constraints, c => c.say?.(assembled)), assembled }
}
