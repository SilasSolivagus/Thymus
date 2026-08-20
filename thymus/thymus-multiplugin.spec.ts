/**
 * 多插件在 `llm/stream` 上互相污染：HANDOFF 记了很久的「已知未解」第一条。
 *
 * 形态：两个插件各自在 llm/stream 里再调一次模型做判定（发现 04 那种语义约束）。
 * 每个插件的防递归只认得**自己**发起的调用——所以 B 的判定调用会撞进 A 的 handler，
 * 被 A 当成「要说给用户的话」处理。判定协议和用户正文走同一条通道，这是结构性的。
 *
 * 全程假 adapter，不调模型，确定性。假 adapter 把收到的文本原样回显成
 * `[JUDGED]<原文>`，所以从产出就能读出「谁判了谁」。
 *
 * 第一版没加深度上限，整个测试挂死——两个插件互相把对方的判定调用当成用户正文，
 * 各自再发起判定，**无限递归**。所以插件里加了 MAX_DEPTH 硬顶：不是为了修问题，
 * 是为了让现象可观测。上限本身就是证据。
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import DynamicCordisRunner from '@deepseek-ai/dsh-cordis-host-runner'
import { gateSay, type Constraint } from './thymus-src/gate.ts'

const SESSION = 'multi'
const agent = { id: SESSION } as never

/** 假判定模型：把收到的文本回显成 [JUDGED]<原文>，并记下每次调用。 */
class EchoJudge extends LlmAdapter {
  readonly seen: string[] = []
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const last = options.messages[options.messages.length - 1]
    const part = last?.content.find(c => c.type === 'text')
    const input = part?.type === 'text' ? part.text : ''
    this.seen.push(input)
    const out = `[JUDGED]${input}`
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: out }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: out } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/**
 * 一个语义约束插件：对每段 text 块发起一次判定调用，用判定结果替换正文。
 * 防递归只认自己创建的 options 对象——发现 04 里人写的那版就是这个做法。
 * @param tag - 标记这个插件，便于从产出里区分是谁改的。
 */
const semanticPlugin = (tag: string): string => `
  const OWN = new Set();
  const MAX_DEPTH = 3;      // 硬顶：没有它这组插件不会自己停下来
  let depth = 0;
  return { name: 'guard-${tag}', inject: ['llm'], apply(ctx) {
    ctx.on('llm/stream', (options, next) => {
      if (OWN.has(options)) return next();
      if (depth >= MAX_DEPTH) return next();
      const up = next();
      return (async function*(){
        for await (const c of up) {
          if (c && c.type === 'text-delta') continue;
          if (c && c.type === 'block-end' && c.block && c.block.type === 'text') {
            const o = { provider:'fake', model:'fake', messages:[
              { role:'user', content:[{type:'text',text:'<${tag}>' + c.block.text}], source:{kind:'user'} }] };
            OWN.add(o); depth++;
            let out = '';
            try {
              for await (const j of ctx.llm.stream(o)) {
                if (j && j.type === 'block-end' && j.block && j.block.type === 'text') out = j.block.text;
              }
            } finally { OWN.delete(o); depth--; }
            yield { type:'text-delta', index: c.index, text: out };
            yield { ...c, block: { ...c.block, text: out } };
            continue;
          }
          yield c;
        }
      })();
    });
  } }`

async function boot(): Promise<{ ctx: Context; judge: EchoJudge }> {
  const ctx = new Context()
  await ctx.plugin(Timer)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(DynamicCordisRunner, {})
  const judge = new EchoJudge()
  ctx.llm.registerAdapter(['fake'], judge)
  return { ctx, judge }
}

async function mount(ctx: Context, src: string, prefix: string, name: string): Promise<void> {
  const { pluginId, packageId } = ctx.dynamicCordisRunner.define({
    sessionId: SESSION as never, plugin: { kind: 'new', idPrefix: prefix },
    name, purpose: name, code: { host: src },
  })
  const r = await ctx.dynamicCordisRunner.run(agent, pluginId, packageId, 'run')
  expect(r.ok, `${name} 挂载`).toBe(true)
}

describe('多插件 · llm/stream 上的互相污染', () => {
  it('论证16 单个语义插件：判定调用只发生一次，产出干净', async () => {
    const { ctx, judge } = await boot()
    await mount(ctx, semanticPlugin('A'), 'gda', 'guard-A')
    const r = await gateSay(ctx, '您好', [])
    expect(judge.seen).toEqual(['<A>您好'])          // 只判了一次，判的是用户原话
    expect(r.assembled).toBe('[JUDGED]<A>您好')      // 产出是 A 的判定结果
  })

  it('论证17 两个语义插件：B 的判定调用被 A 当成用户正文，判定协议被污染', async () => {
    const { ctx, judge } = await boot()
    await mount(ctx, semanticPlugin('A'), 'gda', 'guard-A')
    await mount(ctx, semanticPlugin('B'), 'gdb', 'guard-B')
    const r = await gateSay(ctx, '您好', [])
    // 一句用户话，触发 12 次判定调用（深度上限 3 时的确定性结果）。
    // 每次的输入里都嵌着上一次的判定输出——A 判 B 的判定调用，B 再判 A 的，层层互套。
    expect(judge.seen.length).toBe(12)
    expect(judge.seen[0]).toBe('<B>您好')                       // 只有第一次判的是用户原话
    expect(judge.seen[1]).toBe('<A>[JUDGED]<B>您好')            // 第二次判的已经是 B 的判定输出
    // 用户最终看到的是 12 层嵌套的判定协议，原话被埋在最里面
    expect(r.assembled.split('[JUDGED]').length - 1).toBe(12)
    expect(r.assembled.endsWith('您好')).toBe(true)
  })

  it('论证18 网关裁决仍拿得到用户最终会看到的文本', async () => {
    const { ctx } = await boot()
    await mount(ctx, semanticPlugin('A'), 'gda', 'guard-A')
    await mount(ctx, semanticPlugin('B'), 'gdb', 'guard-B')
    const leak: Constraint = {
      name: 'no-protocol-leak',
      say: t => t.includes('[JUDGED]')
        ? { kind: 'deny', reason: '判定协议漏进了用户正文' }
        : { kind: 'allow' },
    }
    const r = await gateSay(ctx, '您好', [leak])
    expect(r.verdict.kind).toBe('deny')             // 污染被网关拦下
  })

  it('论证19 同样两条语义约束，改放进网关：互不污染，各判一次', async () => {
    const { ctx, judge } = await boot()
    // 不挂任何 llm/stream 插件——两条约束都在网关里，各自调模型判定。
    // 它们的判定调用照样走 llm/stream waterfall，但那条链上没有别的 handler，
    // 所以谁也拦不到谁。
    const judgeVia = (tag: string): Constraint => ({
      name: `gate-${tag}`,
      say: async (text: string) => {
        let out = ''
        for await (const c of ctx.llm.stream({
          provider: 'fake', model: 'fake',
          messages: [{ role: 'user', content: [{ type: 'text', text: `<${tag}>${text}` }], source: { kind: 'user' } }],
        } as never)) {
          const ch = c as { type?: string; block?: { type?: string; text?: string } }
          if (ch.type === 'block-end' && ch.block?.type === 'text') out = ch.block.text ?? ''
        }
        return out.includes('违规') ? { kind: 'deny', reason: `${tag} 判为违规` } : { kind: 'allow' }
      },
    })
    const r = await gateSay(ctx, '您好', [judgeVia('A'), judgeVia('B')])
    expect(judge.seen.sort()).toEqual(['<A>您好', '<B>您好'])   // 各判一次，判的都是用户原话
    expect(r.assembled).toBe('您好')                            // 用户正文没被判定协议碰过
    expect(r.verdict.kind).toBe('allow')
  })
})
