/**
 * 把 SPEC.md 整份声明跑一遍验收——本轮命题的收口动作。
 *
 * 问的是两件事：
 *   一、四类约束用内置类型填得满吗？填不进去的是哪几条？（见 `spec-declarations.ts` 的 UNCOVERED）
 *   二、填进去的那些，验收过不过？留出集这一层各类各是什么水平？
 *
 * 语义类要真模型，所以整轮花钱。跑法：
 *   DEMODIR=campus DEMO=check-spec-full ./thymus/demo/run.sh
 */
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import * as DeepSeek from '@deepseek-ai/dsh-llm-deepseek'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { checkSpecEvals, formatSpecEvalReports } from '../src/spec.ts'
import type { SpecEvalReport } from '../src/spec.ts'
import { checkSpecHygiene, formatHygieneReport } from '../src/hygiene.ts'
import { BUNDLE, DECLARATIONS, UNCOVERED } from './spec-declarations.ts'

const REPEATS = Number(process.env.THYMUS_REPEATS ?? '3')

async function boot(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(Timer)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(DeepSeek, {})
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  return ctx
}

async function main(): Promise<void> {
  // 先过机械闸：不花钱，过不了就不该谈验收。
  console.log(`${'='.repeat(76)}\n冻结前机械体检\n${'='.repeat(76)}`)
  const hygiene = checkSpecHygiene(BUNDLE)
  console.log(formatHygieneReport(hygiene))
  if (process.env.THYMUS_HYGIENE_ONLY === '1') return
  if (!hygiene.ok) throw new Error('机械体检不通过，先修再跑验收')

  if (!process.env.DEEPSEEK_API_KEY) throw new Error('缺少 DEEPSEEK_API_KEY')
  console.log(`${'='.repeat(76)}\nSPEC.md 整份声明验收（${DECLARATIONS.length} 条，${REPEATS} 轮）\n${'='.repeat(76)}`)

  const rounds: SpecEvalReport[][] = []
  for (let i = 1; i <= REPEATS; i++) {
    const ctx = await boot()
    const t0 = Date.now()
    const reports = await checkSpecEvals(ctx, DECLARATIONS)
    console.log(`\n— 第 ${i} 轮（${Date.now() - t0}ms）—`)
    console.log(formatSpecEvalReports(reports))
    rounds.push(reports)
  }

  console.log(`\n${'='.repeat(76)}\n汇总\n${'='.repeat(76)}`)
  DECLARATIONS.forEach((spec, k) => {
    const rs = rounds.map(r => r[k]!)
    console.log(`\n${spec.name}（${spec.type}）`)
    console.log(`  必拦 ${rs.map(r => `${r.deny.caught}/${r.deny.total}`).join(' ')}`
      + ` · 必放 ${rs.map(r => `${r.allow.kept}/${r.allow.total}`).join(' ')}`
      + ` · 留出 ${rs.map(r => `${r.heldout.caught}/${r.heldout.total}`).join(' ')}`)
    const always = rs[0]!.heldout.missed.filter(m => rs.every(r => r.heldout.missed.includes(m)))
    if (always.length > 0) console.log(`  留出每轮都漏：\n    ${always.join('\n    ')}`)
    const over = [...new Set(rs.flatMap(r => r.allow.overreached))]
    if (over.length > 0) console.log(`  被误拦过：\n    ${over.join('\n    ')}`)
  })

  console.log(`\n${'='.repeat(76)}\n填不进声明的条款（${UNCOVERED.length} 条）\n${'='.repeat(76)}`)
  for (const u of UNCOVERED) console.log(`\n· ${u.clause}\n  ${u.why}`)
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e: unknown) => { console.error('失败：', e instanceof Error ? e.message : e); process.exitCode = 1 })
}
