/**
 * 判定器鉴别力测试：证明它不是橡皮图章。
 * 三种插件——正确、过度拒绝、全部放行——判定器必须只让正确的通过。
 */
import { describe, expect, it } from 'vitest'
import { judge, type EvalCase } from './thymus-src/judge.ts'

const CASES: EvalCase[] = [
  { file: 'a.tmp', shouldAllowDelete: true },
  { file: 'notes.txt', shouldAllowDelete: false },
  { file: 'report.TMP', shouldAllowDelete: false },
  { file: 'b.tmp', shouldAllowDelete: true },
]

const CORRECT = `return { name:'g', apply(ctx){ ctx.on('tools/pre-execute',(e,next)=>{
  if(e.name==='delete_file'){ const p=(e.arguments&&e.arguments.path)||''; if(!p.endsWith('.tmp'))
    return Promise.resolve({kind:'deny',reason:'not tmp'}); } return next(); }); } }`
const OVER_DENY = `return { name:'g', apply(ctx){ ctx.on('tools/pre-execute',(e,next)=>
  Promise.resolve({kind:'deny',reason:'all denied'})); } }`
const ALLOW_ALL = `return { name:'g', apply(ctx){ ctx.on('tools/pre-execute',(e,next)=>next()); } }`
const BROKEN = `function (ctx) { this is not valid }`

describe('判定器鉴别力', () => {
  it('正确插件通过', async () => {
    expect((await judge(CORRECT, CASES)).passed).toBe(true)
  })
  it('过度拒绝（连 .tmp 也拦）被抓住', async () => {
    const r = await judge(OVER_DENY, CASES)
    expect(r.passed).toBe(false)
    expect(r.diffs.some(d => d.includes('a.tmp'))).toBe(true)
  })
  it('全部放行（连非 .tmp 也删）被抓住', async () => {
    const r = await judge(ALLOW_ALL, CASES)
    expect(r.passed).toBe(false)
    expect(r.diffs.some(d => d.includes('notes.txt'))).toBe(true)
  })
  it('无法挂载的源码：报可观测差异，不崩溃', async () => {
    const r = await judge(BROKEN, CASES)
    expect(r.passed).toBe(false)
    expect(r.diffs[0]).toContain('无法挂载')
  })
})
