/**
 * 多插件组合评测 + 消融归因。
 *
 * 一个目标（三条关注点）→ 三个插件。验证：
 *   1. 三个插件挂进同一运行时，组合评测全部通过（它们能共存、不互相拆台）；
 *   2. 消融——拿掉任一插件，只有该关注点的评测垮掉，不牵连其他。
 *      「拿掉 X 只垮 X 的评测」就是职责真正分离的判据（DESIGN.md 5.3 贡献度分配）。
 *
 * 用手写的正确插件，确定性证明框架能力，不依赖模型手气。
 */
import { describe, expect, it } from 'vitest'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { judgeCases, type EvalCase } from './thymus-src/eval-framework.ts'

const T = (name: string, ret: string): ToolDefinition => ({
  name, description: name, parameters: { type: 'object', properties: {} },
  output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v as string }] },
  execute: (): Promise<string> => Promise.resolve(ret),
})
const makeTools = (): ToolDefinition[] => [
  {
    name: 'delete_file', description: 'del',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v as string }] },
    execute: (a: { path: string }): Promise<string> => Promise.resolve(`deleted:${a.path}`),
  },
  T('confirm', 'confirmed'), T('purge_all', 'purged'),
  {
    name: 'fetch_record', description: 'rec',
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v as string }] },
    execute: (): Promise<string> => Promise.resolve('无桩默认'),
  },
]

// 三个各司其职的正确插件
const P_DELETE = `return { name:'del', apply(ctx){ ctx.on('tools/pre-execute',(e,next)=>{
  if(e.name==='delete_file' && !((e.arguments&&e.arguments.path)||'').endsWith('.tmp'))
    return Promise.resolve({kind:'deny',reason:'not tmp'}); return next(); }); } }`
const P_CONFIRM = `return { name:'cfm', apply(ctx){ let ok=false; ctx.on('tools/pre-execute',(e,next)=>{
  if(e.name==='confirm'){ ok=true; return next(); }
  if(e.name==='purge_all' && !ok) return Promise.resolve({kind:'deny',reason:'not confirmed'});
  return next(); }); } }`
const P_MASK = `return { name:'msk', apply(ctx){ ctx.on('tools/post-execute',(exec,result,next)=>{
  const b=result.content&&result.content[0];
  if(b&&b.type==='text'){ const m=b.text.replace(/\\d{16}/g,x=>'************'+x.slice(-4));
    return Promise.resolve({kind:'accept',content:[{type:'text',text:m}]}); }
  return next(); }); } }`

// 三条关注点各自的评测（用 concern 标记，便于消融归因）
interface TaggedCase extends EvalCase { concern: 'a' | 'b' | 'c' }
const CASES: TaggedCase[] = [
  { concern: 'a', description: 'a正: .tmp 放行', steps: [{ tool: 'delete_file', args: { path: 'x.tmp' } }], assert: { kind: 'allowed' } },
  { concern: 'a', description: 'a反: 非 .tmp 拒绝', steps: [{ tool: 'delete_file', args: { path: 'x.txt' } }], assert: { kind: 'denied' } },
  { concern: 'b', description: 'b正: 先确认再清空', steps: [{ tool: 'confirm', args: {} }, { tool: 'purge_all', args: {} }], assert: { kind: 'allowed' } },
  { concern: 'b', description: 'b反: 未确认清空拒绝', steps: [{ tool: 'purge_all', args: {} }], assert: { kind: 'denied' } },
  { concern: 'c', description: 'c正: 卡号脱敏', steps: [{ tool: 'fetch_record', args: { id: '1' }, stubReturn: '卡号 1234567890123456 结束' }], assert: { kind: 'output-excludes', value: '1234567890123456' } },
]

const strip = (cs: TaggedCase[]): EvalCase[] => cs.map(({ concern, ...c }) => c)

describe('多插件组合评测 + 消融归因', () => {
  it('三个插件组合评测全部通过（共存不拆台）', async () => {
    const r = await judgeCases([P_DELETE, P_CONFIRM, P_MASK], strip(CASES), makeTools)
    expect(r.passed).toBe(true)
  })

  it('消融：拿掉删除守卫，只有 a 的评测垮掉', async () => {
    const r = await judgeCases([P_CONFIRM, P_MASK], strip(CASES), makeTools)
    expect(r.passed).toBe(false)
    // 垮掉的必须只在 concern a
    expect(r.diffs.every(d => d.includes('a反') || d.includes('a正'))).toBe(true)
    expect(r.diffs.some(d => d.includes('a反'))).toBe(true)
  })

  it('消融：拿掉确认守卫，只有 b 的评测垮掉', async () => {
    const r = await judgeCases([P_DELETE, P_MASK], strip(CASES), makeTools)
    expect(r.passed).toBe(false)
    expect(r.diffs.every(d => d.includes('b'))).toBe(true)
    expect(r.diffs.some(d => d.includes('b反'))).toBe(true)
  })

  it('消融：拿掉脱敏，只有 c 的评测垮掉', async () => {
    const r = await judgeCases([P_DELETE, P_CONFIRM], strip(CASES), makeTools)
    expect(r.passed).toBe(false)
    expect(r.diffs.every(d => d.includes('c'))).toBe(true)
  })

  it('职责分离判据：三个插件的消融影响集互不相交', async () => {
    const abl = async (subset: string[]): Promise<string[]> =>
      (await judgeCases(subset, strip(CASES), makeTools)).diffs
    const noDel = await abl([P_CONFIRM, P_MASK])   // 缺 a
    const noCfm = await abl([P_DELETE, P_MASK])    // 缺 b
    const noMsk = await abl([P_DELETE, P_CONFIRM]) // 缺 c
    // 每个影响集只落在自己的 concern 上——互不相交
    expect(noDel.every(d => d.includes('a'))).toBe(true)
    expect(noCfm.every(d => d.includes('b'))).toBe(true)
    expect(noMsk.every(d => d.includes('c'))).toBe(true)
  })
})
