/**
 * 把 SPEC.md 整份声明跑一遍验收——本轮命题的收口动作。
 *
 * 问的是两件事：
 *   一、四类约束用内置类型填得满吗？填不进去的是哪几条？（见 `spec-declarations.ts` 的 UNCOVERED）
 *   二、填进去的那些，验收过不过？留出集这一层各类各是什么水平？
 *   三、拒绝时换上去的那句话，自己合不合别的规矩？（发现 29——它发出前不再过闸）
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
import {
  checkReplacements, checkSpecEvals, formatReplacementReports, formatSpecEvalReports,
} from '../src/spec.ts'
import type { SpecEvalReport } from '../src/spec.ts'
import { checkSpecHygiene, formatHygieneReport } from '../src/hygiene.ts'
import { BUNDLE, DECLARATIONS, UNCOVERED } from './spec-declarations.ts'

const REPEATS = Number(process.env.THYMUS_REPEATS ?? '3')
/**
 * 替代话术那一轮每条判几次。和评测轮数不是一回事，所以不复用 REPEATS：
 * 那个是「整套评测跑几遍看方差」，这个是「同一段文本判几次才不漏」。
 * 5 是实测出来的——最难那条单次命中率只有 0.55（发现 29 六）。
 */
const REPLACEMENT_REPEATS = Number(process.env.THYMUS_REPLACEMENT_REPEATS ?? '5')

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

  // 替代话术自己也要验收：它发出之前不再过闸，违反什么都不会有位置发现（发现 29）。
  // 网关兜底串不在任何一条声明里，得单独送进来——实测它是撞得最狠的一条。
  console.log(`\n${'='.repeat(76)}\n替代话术交叉验收\n${'='.repeat(76)}`)
  const replacements = await checkReplacements(await boot(), DECLARATIONS, [
    { from: '网关兜底串', text: '抱歉，这个问题我需要转人工为您处理。' },
  ], { repeats: REPLACEMENT_REPEATS })
  console.log(formatReplacementReports(replacements))
  const badReplacements = replacements.filter(r => !r.ok)

  console.log(`\n${'='.repeat(76)}\n填不进声明的条款（${UNCOVERED.length} 条）\n${'='.repeat(76)}`)
  for (const u of UNCOVERED) console.log(`\n· ${u.clause}\n  ${u.why}`)

  // 拦在最后而不是当场抛：上面那几节都是这次交付的记录，先打全再判。
  //
  // 为什么是 error 不是警告：这不是「理论上可能」。真 agent 上越界的 10 轮里有 4 轮，
  // 网关吐出去的那句让 D 的兜底义务落空（发现 29 七）。而且**靠声明顺序护不住**——
  // 顺序只决定两条都拦时谁的话术赢；没拦原句的那条根本不参与裁决，替代话术从它面前
  // 直接过去（论证96）。所以只要有一条替代话术在别的约束下站不住，就不该冻结。
  if (badReplacements.length > 0) {
    throw new Error(`${badReplacements.length} 条替代话术自己违规，不应冻结：`
      + badReplacements.map(r => `[${r.from}] 撞上 ${r.hits.map(h => h.constraint).join('、')}`).join('；'))
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e: unknown) => { console.error('失败：', e instanceof Error ? e.message : e); process.exitCode = 1 })
}
