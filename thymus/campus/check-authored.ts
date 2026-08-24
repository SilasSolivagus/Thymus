/**
 * 模型自己写的声明 vs 人写的声明，同一把尺子量。
 *
 * 尺子是**人写的那组冻结用例**（`spec-declarations.ts`），按**整份声明集**算：
 * 一条用例只要集合里任一条约束拦住就算拦住。两边的条数、命名、类型选择都可能对不上，
 * 不做一对一映射——问的就是「这份声明整体拦不拦得住」。
 *
 * 另外两项：
 *   自评   —— 每份声明按**它自己写的用例**跑一遍，看它会报出什么（客户看到的就是这个）
 *   留出体检 —— 机械检查：`forbidden-phrases` 的留出用例里有没有直接含着已声明的词。
 *              含着就说明那条根本不是留出用例，是伪装成留出的必拦用例。这一项不花钱。
 *
 * 说话类用例判定时给的是空对话（`{messages: []}`）：`require-fallback` 那种要上下文的
 * 约束在没有用户提问时触发条件不成立，会放行——否则它会把每一条无关句子都拦掉，
 * 集合口径就没法算了。
 *
 * 跑法：DEMODIR=campus DEMO=check-authored ./thymus/demo/run.sh
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import * as DeepSeek from '@deepseek-ai/dsh-llm-deepseek'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { compileConstraints, checkSpecEvals, formatSpecEvalReports } from '../src/spec.ts'
import type { Constraint } from '../src/gate.ts'
import type { ConstraintSpec, DialogueCase, SequenceCase } from '../src/spec.ts'
import { DECLARATIONS } from './spec-declarations.ts'

const OUT = process.env.THYMUS_OUT ?? resolve(process.cwd(), 'thymus/campus/submitted')
const ROUNDS = Number(process.env.THYMUS_ROUNDS ?? '3')
const REPEATS = Number(process.env.THYMUS_REPEATS ?? '2')

type Group = 'deny' | 'allow' | 'heldout'
const GROUPS: Group[] = ['deny', 'allow', 'heldout']

/** 一条可路由的用例：判据随通道走。 */
type Case =
  | { group: Group; kind: 'say'; text: string; from: string }
  | { group: Group; kind: 'output'; tool: string; text: string; from: string }
  | { group: Group; kind: 'seq'; seq: SequenceCase; from: string }
  | { group: Group; kind: 'dialogue'; dlg: DialogueCase; from: string }

/** 把人写的声明里的用例摊平成一张可路由的题目表。 */
function humanCases(): Case[] {
  const out: Case[] = []
  for (const spec of DECLARATIONS) {
    const e = (spec as { evals?: Record<Group, unknown[]> }).evals
    if (e === undefined) continue
    for (const group of GROUPS) {
      for (const raw of e[group] ?? []) {
        if (spec.type === 'no-leak') out.push({ group, kind: 'output', tool: spec.tool, text: raw as string, from: spec.name })
        else if (spec.type === 'require-before') out.push({ group, kind: 'seq', seq: raw as SequenceCase, from: spec.name })
        else if (spec.type === 'require-fallback') out.push({ group, kind: 'dialogue', dlg: raw as DialogueCase, from: spec.name })
        else out.push({ group, kind: 'say', text: raw as string, from: spec.name })
      }
    }
  }
  return out
}

/** 整份声明集判一条题：任一条约束拒绝即算拦住。 */
async function denied(cs: readonly Constraint[], c: Case): Promise<boolean> {
  if (c.kind === 'say') {
    const vs = await Promise.all(cs.map(x => x.say?.(c.text, 'text', { messages: [] })))
    return vs.some(v => v?.kind === 'deny')
  }
  if (c.kind === 'dialogue') {
    const messages = [{ role: 'user', content: [{ type: 'text', text: c.dlg.ask }], source: { kind: 'user' } }] as never
    const vs = await Promise.all(cs.map(x => x.say?.(c.dlg.reply, 'text', { messages })))
    return vs.some(v => v?.kind === 'deny')
  }
  if (c.kind === 'seq') {
    const caller = { sessionId: 'x', events: [], succeeded: new Set(c.seq.before) }
    const vs = await Promise.all(cs.map(x => x.preTool?.({ name: c.seq.call, arguments: {}, caller })))
    return vs.some(v => v?.kind === 'deny')
  }
  let text = c.text
  for (const x of cs) {
    const next = await x.postTool?.({ name: c.tool, arguments: {} }, text)
    if (typeof next === 'string') text = next
  }
  return text !== c.text
}

async function boot(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(Timer)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(DeepSeek, {})
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  return ctx
}

function describe(c: Case): string {
  if (c.kind === 'say' || c.kind === 'output') return c.text.slice(0, 28)
  if (c.kind === 'seq') return `${c.seq.before.join('+') || '（无）'}→${c.seq.call}`
  return `${c.dlg.ask.slice(0, 14)}／${c.dlg.reply.slice(0, 14)}`
}

/** 用共同标尺给一份声明集打分。 */
async function score(label: string, specs: readonly ConstraintSpec[], cases: readonly Case[]): Promise<void> {
  for (let i = 1; i <= REPEATS; i++) {
    const ctx = await boot()
    const cs = compileConstraints(ctx, specs as ConstraintSpec[])
    const t0 = Date.now()
    const results = await Promise.all(cases.map(async c => ({ c, denied: await denied(cs, c) })))
    const tally = (g: Group): string => {
      const rows = results.filter(r => r.c.group === g)
      const hit = rows.filter(r => g === 'allow' ? !r.denied : r.denied).length
      return `${hit}/${rows.length}`
    }
    console.log(`  ${label} 第 ${i} 轮（${Date.now() - t0}ms）：`
      + `必拦 ${tally('deny')} · 必放 ${tally('allow')} · 留出 ${tally('heldout')}`)
    for (const g of ['deny', 'heldout'] as const) {
      const missed = results.filter(r => r.c.group === g && !r.denied)
      if (missed.length > 0) {
        console.log(`    ${g === 'deny' ? '必拦' : '留出'}漏：${missed.map(r => describe(r.c)).join(' ｜ ')}`)
      }
    }
    const over = results.filter(r => r.c.group === 'allow' && r.denied)
    if (over.length > 0) console.log(`    ✗ 误拦：${over.map(r => describe(r.c)).join(' ｜ ')}`)
  }
}

/**
 * 留出体检（不花钱）：`forbidden-phrases` 的留出用例里直接含着已声明的词，
 * 说明它根本不是留出用例——是伪装成留出的必拦用例，判别力为零。
 */
function auditHeldout(label: string, specs: readonly ConstraintSpec[]): void {
  for (const spec of specs) {
    if (spec.type !== 'forbidden-phrases') continue
    const h = spec.evals?.heldout ?? []
    if (h.length === 0) continue
    const norm = (s: string): string => (spec.ignoreCase ?? true) ? s.toLowerCase() : s
    const bad = h.filter(t => spec.phrases.some(p => norm(t).includes(norm(p))))
    console.log(`  ${label} · ${spec.name}：留出 ${h.length} 条，其中 ${bad.length} 条直接含着已声明的词`
      + `${bad.length > 0 ? ` → ${bad.join(' ｜ ')}` : ''}`)
  }
}

function load(round: number): ConstraintSpec[] | undefined {
  try { return JSON.parse(readFileSync(resolve(OUT, `authored-spec-r${round}.json`), 'utf8')) as ConstraintSpec[] }
  catch { return undefined }
}

async function main(): Promise<void> {
  if (!process.env.DEEPSEEK_API_KEY) throw new Error('缺少 DEEPSEEK_API_KEY')
  const cases = humanCases()
  const counts = GROUPS.map(g => `${g} ${cases.filter(c => c.group === g).length}`).join(' · ')
  console.log(`${'='.repeat(76)}\n共同标尺：人写的冻结用例 ${cases.length} 条（${counts}）\n${'='.repeat(76)}\n`)

  await score('人写', DECLARATIONS, cases)
  const authored: { round: number; specs: ConstraintSpec[] }[] = []
  for (let r = 1; r <= ROUNDS; r++) {
    const specs = load(r)
    if (specs === undefined) { console.log(`  模型第 ${r} 版：没有产物`); continue }
    authored.push({ round: r, specs })
    await score(`模型第 ${r} 版（${specs.length} 条）`, specs, cases)
  }

  console.log(`\n${'='.repeat(76)}\n自评：各自按自己写的用例跑\n${'='.repeat(76)}`)
  const ctx = await boot()
  console.log('\n人写：')
  console.log(formatSpecEvalReports(await checkSpecEvals(ctx, DECLARATIONS)))
  for (const a of authored) {
    const c2 = await boot()
    console.log(`\n模型第 ${a.round} 版：`)
    console.log(formatSpecEvalReports(await checkSpecEvals(c2, a.specs)))
  }

  console.log(`\n${'='.repeat(76)}\n留出体检（字面词表那一类，不花钱）\n${'='.repeat(76)}`)
  auditHeldout('人写', DECLARATIONS)
  for (const a of authored) auditHeldout(`模型第 ${a.round} 版`, a.specs)
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e: unknown) => { console.error('失败：', e instanceof Error ? e.message : e); process.exitCode = 1 })
}
