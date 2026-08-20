/**
 * 热替换：运行中把正在生效的插件换掉。
 *
 * 「自生长」拆成写得出／能热替换／能卸载重写三件，前两件一直只验了一部分——
 * 我们所有的替换都是「重新写一版，在全新 context 里重挂再评测」，从没测过
 * **运行中的 agent 把自己身上正在生效的插件换掉**。这里补。
 *
 * dsh 的替换 API：`run(agent, pluginId, packageId, 'update')`，同一个 pluginId 下
 * 追加一个新 package 再切过去。旧版由 `retract()` 卸载——它 splice 掉全部
 * handlerDisposers 并 dispose fiber。
 *
 * 四个问题：换得成吗、旧版有没有残留、中间态是什么、调用正在飞的时候换会怎样。
 * 不调模型，确定性。
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import DynamicCordisRunner from '@deepseek-ai/dsh-cordis-host-runner'
import { gateSay } from './thymus-src/gate.ts'

const SESSION = 'swap'
const agent = { id: SESSION } as never

/** 拦 delete_file 的约束，理由带版本号，便于分辨是哪一版在生效。 */
const denyPlugin = (tag: string): string => `
  return { name:'deny-${tag}', apply(ctx){
    ctx.on('tools/pre-execute',(e,next)=>
      e.name==='delete_file' ? Promise.resolve({kind:'deny',reason:'${tag} 拒绝'}) : next());
  } }`

/** 改写说话内容的约束，产出带版本号。 */
const sayPlugin = (tag: string): string => `
  return { name:'say-${tag}', apply(ctx){
    ctx.on('llm/stream',(o,next)=>{
      const up = next();
      return (async function*(){
        for await (const c of up) {
          if (c && c.type === 'text-delta') { yield { ...c, text: '[${tag}]' + c.text }; continue; }
          if (c && c.type === 'block-end' && c.block && c.block.type === 'text') {
            yield { ...c, block: { ...c.block, text: '[${tag}]' + c.block.text } }; continue;
          }
          yield c;
        }
      })();
    });
  } }`

/** 什么都不拦的插件，用来验「换成宽松版之后旧版真的不生效了」。 */
const PASS_PLUGIN = `return { name:'pass', apply(ctx){ ctx.on('tools/pre-execute',(e,next)=>next()); } }`

const SLOW_TOOL: ToolDefinition = {
  name: 'slow_tool', description: 'slow',
  parameters: { type: 'object', properties: {} },
  output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v as string }] },
  execute: async (): Promise<string> => { await new Promise(r => setTimeout(r, 250)); return 'done' },
}
const DELETE_TOOL: ToolDefinition = {
  name: 'delete_file', description: 'del',
  parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v as string }] },
  execute: (): Promise<string> => Promise.resolve('deleted'),
}

async function boot(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(Timer)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(DynamicCordisRunner, {})
  ctx.tools.register(DELETE_TOOL)
  ctx.tools.register(SLOW_TOOL)
  return ctx
}

/** 首次挂载，返回 pluginId。 */
async function mountFirst(ctx: Context, src: string, prefix: string): Promise<string> {
  const { pluginId, packageId } = ctx.dynamicCordisRunner.define({
    sessionId: SESSION as never, plugin: { kind: 'new', idPrefix: prefix },
    name: 'v1', purpose: 'v1', code: { host: src },
  })
  const r = await ctx.dynamicCordisRunner.run(agent, pluginId, packageId, 'run')
  expect(r.ok, '首版挂载').toBe(true)
  return pluginId
}

/** 同一个 pluginId 下追加新 package 并切过去。 */
async function swap(ctx: Context, pluginId: string, src: string, name: string): Promise<boolean> {
  const { packageId } = ctx.dynamicCordisRunner.define({
    sessionId: SESSION as never, plugin: { kind: 'existing', pluginId: pluginId as never },
    name, purpose: name, code: { host: src },
  })
  const r = await ctx.dynamicCordisRunner.run(agent, pluginId as never, packageId, 'update')
  return r.ok
}

async function callDelete(ctx: Context): Promise<{ isError: boolean; text: string }> {
  const res = await ctx.tools.execute({
    signal: new AbortController().signal,
    callId: CallId(`swap-${Math.floor(performance.now())}`),
    name: 'delete_file', arguments: { path: 'x.txt' }, agent,
  })
  const first = res.content[0]
  return { isError: res.isError, text: first?.type === 'text' ? first.text : '' }
}

describe('热替换 · 运行中换掉正在生效的插件', () => {
  it('论证23 换得成：新版立即生效，理由来自新版', async () => {
    const ctx = await boot()
    const id = await mountFirst(ctx, denyPlugin('v1'), 'swa')
    expect((await callDelete(ctx)).text).toContain('v1 拒绝')
    expect(await swap(ctx, id, denyPlugin('v2'), 'v2')).toBe(true)
    const after = await callDelete(ctx)
    expect(after.isError).toBe(true)
    expect(after.text).toContain('v2 拒绝')
    expect(after.text).not.toContain('v1')     // 旧版的判决没有残留
  })

  it('论证24 换成宽松版后旧约束真的不生效——旧 handler 被卸干净', async () => {
    const ctx = await boot()
    const id = await mountFirst(ctx, denyPlugin('v1'), 'swb')
    expect((await callDelete(ctx)).isError).toBe(true)
    expect(await swap(ctx, id, PASS_PLUGIN, 'pass')).toBe(true)
    expect((await callDelete(ctx)).isError).toBe(false)   // 旧 handler 没有残留
  })

  it('论证25 说话通道同样换得动，且不会两版叠加', async () => {
    const ctx = await boot()
    const id = await mountFirst(ctx, sayPlugin('v1'), 'swc')
    expect((await gateSay(ctx, '您好', [])).assembled).toBe('[v1]您好')
    expect(await swap(ctx, id, sayPlugin('v2'), 'v2')).toBe(true)
    const after = await gateSay(ctx, '您好', [])
    expect(after.assembled).toBe('[v2]您好')              // 不是 [v2][v1]您好
  })

  it('论证26 换版不打断飞行中的工具执行（注意：约束已在派发前判完，这条不测决策途中换版）', async () => {
    const ctx = await boot()
    const id = await mountFirst(ctx, denyPlugin('v1'), 'swd')
    // 起一个慢工具调用（它会被放行，因为约束只拦 delete_file），换版发生在它飞行途中
    const inflight = ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('swap-inflight'), name: 'slow_tool', arguments: {}, agent,
    })
    await new Promise(r => setTimeout(r, 50))
    expect(await swap(ctx, id, denyPlugin('v2'), 'v2')).toBe(true)
    const res = await inflight
    // 飞行中的调用不因换版而失败或悬挂
    expect(res.isError).toBe(false)
    expect(res.content[0]?.type === 'text' && res.content[0].text).toContain('done')
  })

  it('论证27 换版落在约束决策途中：这次调用按哪一版走', async () => {
    const ctx = await boot()
    // v1 的 handler 故意慢：拿到调用后等 200ms 才给判决，换版就发生在这段窗口里
    // 沙箱禁用 Node 定时器，必须走 cordis 的 timer 服务（inject: ['timer'] + ctx.timeout(ms)）
    const slowDeny = `
      return { name:'slow-deny', inject:['timer'], apply(ctx){
        ctx.on('tools/pre-execute',(e,next)=>{
          if(e.name!=='delete_file') return next();
          return ctx.timeout(200).then(() => ({kind:'deny',reason:'v1 拒绝'}));
        });
      } }`
    const id = await mountFirst(ctx, slowDeny, 'swe')
    const inflight = callDelete(ctx)
    await new Promise(r => setTimeout(r, 50))          // 让 handler 已经进入决策
    expect(await swap(ctx, id, denyPlugin('v2'), 'v2')).toBe(true)
    const res = await inflight
    // 实际行为：这次调用既不按 v1 也不按 v2，直接失败——换版 dispose 了旧插件的
    // fiber，而这次决策挂在那个 fiber 的 timer 效果上。
    // 原先猜的是「由发起时那一版给出判决」，不对。
    expect(res.isError).toBe(true)
    expect(res.text).toContain('Context has been disposed')
    expect(res.text).not.toContain('deleted')      // 关键：失败方向是不放行，不是放行
    // 换版之后的新调用正常走新版
    expect((await callDelete(ctx)).text).toContain('v2 拒绝')
  })
})
