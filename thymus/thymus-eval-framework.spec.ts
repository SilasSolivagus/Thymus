/**
 * 通用评测框架的鉴别力测试：三档递增的 spec，同一个判定器。
 * 每档都验：正确器官通过、错误器官被抓住。不花模型。
 */
import { describe, expect, it } from 'vitest'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { judgeCases, type EvalCase } from './thymus-src/eval-framework.ts'

const T = (name: string, ret: string): ToolDefinition => ({
  name, description: name,
  parameters: { type: 'object', properties: { path: { type: 'string' }, id: { type: 'string' } } },
  output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v as string }] },
  execute: (): Promise<string> => Promise.resolve(ret),
})

// ── 第一档：无状态 · 删 .tmp、拦非 .tmp ──
const T1_TOOLS = () => [{
  name: 'delete_file', description: 'del',
  parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  output: { schema: { type: 'string' }, render: (_a: unknown, v: unknown) => [{ type: 'text', text: v as string }] },
  execute: (a: { path: string }): Promise<string> => Promise.resolve(`deleted:${a.path}`),
} as ToolDefinition]
const T1_CASES: EvalCase[] = [
  { description: '.tmp 放行', steps: [{ tool: 'delete_file', args: { path: 'a.tmp' } }], assert: { kind: 'allowed' } },
  { description: '非 .tmp 拒绝', steps: [{ tool: 'delete_file', args: { path: 'notes.txt' } }], assert: { kind: 'denied' } },
]
const T1_OK = `return { name:'g', apply(ctx){ ctx.on('tools/pre-execute',(e,next)=>{
  if(e.name==='delete_file' && !((e.arguments&&e.arguments.path)||'').endsWith('.tmp'))
    return Promise.resolve({kind:'deny',reason:'not tmp'}); return next(); }); } }`
const T1_BAD = `return { name:'g', apply(ctx){ ctx.on('tools/pre-execute',(e,next)=>next()); } }`  // 全放行

// ── 第二档：有状态 · dangerous_action 前必须先 confirm ──
const T2_TOOLS = () => [T('confirm', 'confirmed'), T('dangerous_action', 'executed')]
const T2_CASES: EvalCase[] = [
  { description: '未确认直接危险操作 → 拒绝', steps: [{ tool: 'dangerous_action', args: {} }], assert: { kind: 'denied' } },
  { description: '先确认再危险操作 → 放行', steps: [{ tool: 'confirm', args: {} }, { tool: 'dangerous_action', args: {} }], assert: { kind: 'allowed' } },
]
const T2_OK = `return { name:'g', apply(ctx){ let ok=false; ctx.on('tools/pre-execute',(e,next)=>{
  if(e.name==='confirm'){ ok=true; return next(); }
  if(e.name==='dangerous_action' && !ok) return Promise.resolve({kind:'deny',reason:'not confirmed'});
  return next(); }); } }`
const T2_BAD = `return { name:'g', apply(ctx){ ctx.on('tools/pre-execute',(e,next)=>{
  if(e.name==='dangerous_action') return Promise.resolve({kind:'deny',reason:'always deny'});
  return next(); }); } }`  // 永远拒绝，确认了也不放行

// ── 第三档：看产出 · 工具返回文本里的 16 位卡号必须脱敏 ──
const T3_TOOLS = () => [{
  name: 'fetch_record', description: 'fetch',
  parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  output: { schema: { type: 'string' }, render: (_a: unknown, v: unknown) => [{ type: 'text', text: v as string }] },
  execute: (): Promise<string> => Promise.resolve('客户卡号 4111111111111111 余额 100'),
} as ToolDefinition]
const T3_CASES: EvalCase[] = [
  { description: '卡号必须被脱敏', steps: [{ tool: 'fetch_record', args: { id: '1' } }], assert: { kind: 'output-excludes', value: '4111111111111111' } },
]
const T3_OK = `return { name:'g', apply(ctx){ ctx.on('tools/post-execute',(exec,result,next)=>{
  const b=result.content&&result.content[0];
  if(b&&b.type==='text'){ const masked=b.text.replace(/\\d{16}/g,m=>'************'+m.slice(-4));
    return Promise.resolve({kind:'accept',content:[{type:'text',text:masked}]}); }
  return next(); }); } }`
const T3_BAD = `return { name:'g', apply(ctx){ ctx.on('tools/pre-execute',(e,next)=>next()); } }`  // 不脱敏

describe('通用评测框架 · 三档递增', () => {
  it('第一档 无状态：正确通过', async () => expect((await judgeCases(T1_OK, T1_CASES, T1_TOOLS)).passed).toBe(true))
  it('第一档 无状态：全放行被抓住', async () => {
    const r = await judgeCases(T1_BAD, T1_CASES, T1_TOOLS)
    expect(r.passed).toBe(false); expect(r.diffs.some(d => d.includes('非 .tmp'))).toBe(true)
  })
  it('第二档 有状态：正确通过', async () => expect((await judgeCases(T2_OK, T2_CASES, T2_TOOLS)).passed).toBe(true))
  it('第二档 有状态：永远拒绝被抓住（确认后仍拦）', async () => {
    const r = await judgeCases(T2_BAD, T2_CASES, T2_TOOLS)
    expect(r.passed).toBe(false); expect(r.diffs.some(d => d.includes('先确认'))).toBe(true)
  })
  it('第三档 看产出：正确脱敏通过', async () => expect((await judgeCases(T3_OK, T3_CASES, T3_TOOLS)).passed).toBe(true))
  it('第三档 看产出：不脱敏被抓住', async () => {
    const r = await judgeCases(T3_BAD, T3_CASES, T3_TOOLS)
    expect(r.passed).toBe(false); expect(r.diffs.some(d => d.includes('脱敏') || d.includes('不应包含'))).toBe(true)
  })

  it('第三档 + 桩返回值：出题方掌控工具输入，卡号在末尾也能判', async () => {
    const cases: EvalCase[] = [
      { description: '末尾卡号脱敏', steps: [{ tool: 'fetch_record', args: { id: '1' }, stubReturn: '余额充足 卡号 6222000012345678' }], assert: { kind: 'output-excludes', value: '6222000012345678' } },
      { description: '15位不脱敏', steps: [{ tool: 'fetch_record', args: { id: '2' }, stubReturn: '编号 123456789012345 结束' }], assert: { kind: 'output-includes', value: '123456789012345' } },
    ]
    expect((await judgeCases(T3_OK, cases, T3_TOOLS)).passed).toBe(true)
  })
})

// ── 第四档：托管调模型的插件 · 判定器 opt-in 装 LlmRuntime ──
// 插件 inject: ['llm']，在 llm/stream 里再发起一次模型调用做判定与改写
// （形态与 campus/probe-semantic-guard.ts 的语义版一致）。
// 这里用假 adapter 代替真模型：判定逻辑固定，测试确定、不花钱。
class FakeJudgeAdapter extends LlmAdapter {
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const last = options.messages[options.messages.length - 1]
    const part = last?.content.find(c => c.type === 'text')
    const input = part?.type === 'text' ? part.text : ''
    const out = input.includes('不可能') ? '需要进一步确认' : input
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: out }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: out } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

const T4_CASES: EvalCase[] = [
  { description: '禁语须被改写', steps: [{ kind: 'say', text: '这个不可能' }], assert: { kind: 'said-excludes', value: '不可能' } },
  { description: '正常话术须原样', steps: [{ kind: 'say', text: '已为您核实' }], assert: { kind: 'said-includes', value: '已为您核实' } },
]
// 防递归：自己发起的判定调用走 provider 'fake'，见到就直接放行。
const T4_GUARD = `return { name:'g', inject:['llm'], apply(ctx){
  ctx.on('llm/stream',(options,next)=>{
    if(options.provider==='fake') return next();
    const upstream=next();
    return (async function*(){
      for await (const chunk of upstream){
        if(chunk && chunk.type==='text-delta') continue;
        if(chunk && chunk.type==='block-end' && chunk.block && chunk.block.type==='text'){
          let out='';
          for await (const c of ctx.llm.stream({ provider:'fake', model:'fake', messages:[
            { role:'user', content:[{type:'text',text:chunk.block.text}], source:{kind:'user'} }] })){
            if(c && c.type==='block-end' && c.block && c.block.type==='text') out=c.block.text;
          }
          yield { type:'text-delta', index:chunk.index, text:out };
          yield { ...chunk, block:{ ...chunk.block, text:out } };
          continue;
        }
        yield chunk;
      }
    })();
  });
} }`

describe('通用评测框架 · 第四档 托管调模型的插件', () => {
  it('不开 llm：插件拿不到 llm 服务，静默失效，禁语原样漏出', async () => {
    const r = await judgeCases(T4_GUARD, T4_CASES, () => [])
    expect(r.passed).toBe(false)
    expect(r.diffs.some(d => d.includes('禁语'))).toBe(true)
  })

  it('开 llm：插件调得到模型，两条用例都过', async () => {
    const r = await judgeCases(T4_GUARD, T4_CASES, () => [], {
      llm: ctx => { ctx.llm.registerAdapter(['fake'], new FakeJudgeAdapter()) },
    })
    expect(r.diffs).toEqual([])
    expect(r.passed).toBe(true)
  })

  it('开 llm 不影响工具通道既有用例', async () => {
    const r = await judgeCases(T1_OK, T1_CASES, T1_TOOLS, {
      llm: ctx => { ctx.llm.registerAdapter(['fake'], new FakeJudgeAdapter()) },
    })
    expect(r.passed).toBe(true)
  })
})
