/**
 * 发现 07 的结论依不依赖具体选了哪几条同义表达（HANDOFF 下一步第 2 条）。
 *
 * 不重跑生成——九个版本的插件已经冻在 `submitted/a2-feedback-r{1,2,3}-v{1,2,3}.js` 里。
 * 把它们在**第三留出集**（`HELDOUT3`，本轮新写，同类别、字面无重叠）上重新打分即可。
 *
 * 同一轮里 `HELDOUT2` 也打一遍当**同轮对照**：语义插件每跑都不同，只跟发现 07 记录的
 * 历史值比，分不清「换了题目」和「模型本来就有方差」。同轮对照能把这两件事隔开。
 *
 * 跑法：DEMODIR=campus DEMO=check-heldout3 ./thymus/demo/run.sh
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import * as DeepSeek from '@deepseek-ai/dsh-llm-deepseek'
import { judgeCases, type EvalCase, type JudgeOptions } from '../src/eval-framework.ts'
import { HELDOUT2, HELDOUT3 } from './a2-evals.ts'

const OUT = process.env.THYMUS_OUT ?? resolve(process.cwd(), 'thymus-campus-out')

/** 发现 07 记录的留出集2 分数，用来看这次重打分有没有系统性漂移。 */
const RECORDED: Record<string, number> = {
  'r1-v1': 2, 'r1-v2': 2, 'r1-v3': 5,
  'r2-v1': 2, 'r2-v2': 3, 'r2-v3': 3,
  'r3-v1': 3, 'r3-v2': 6, 'r3-v3': 6,
}

const VERSIONS = ['r1-v1', 'r1-v2', 'r1-v3', 'r2-v1', 'r2-v2', 'r2-v3', 'r3-v1', 'r3-v2', 'r3-v3']

interface Score { ok: number; failed: string[] }

async function score(source: string, cases: EvalCase[], options: JudgeOptions): Promise<Score> {
  let ok = 0
  const failed: string[] = []
  for (const c of cases) {
    const r = await judgeCases(source, [c], () => [], options)
    if (r.passed) ok++
    else failed.push(c.description)
  }
  return { ok, failed }
}

async function main(): Promise<void> {
  if (!process.env.DEEPSEEK_API_KEY) throw new Error('缺少 DEEPSEEK_API_KEY')
  const options: JudgeOptions = { llm: (ctx: Context) => ctx.plugin(DeepSeek, {}) as unknown as Promise<void> }
  console.log(`九个冻结版本 × 两组留出集（各 ${HELDOUT2.length} 条）`)
  console.log('留出集2＝发现 07 用的那组（同轮对照）· 留出集3＝本轮新写\n')

  const rows: { v: string; h2: number; h3: number }[] = []
  for (const v of VERSIONS) {
    const source = readFileSync(resolve(OUT, `a2-feedback-${v}.js`), 'utf8')
    const h2 = await score(source, HELDOUT2, options)
    const h3 = await score(source, HELDOUT3, options)
    rows.push({ v, h2: h2.ok, h3: h3.ok })
    console.log(`${v}  留出集2 ${h2.ok}/${HELDOUT2.length}（发现 07 记录 ${RECORDED[v]}）`
      + `  留出集3 ${h3.ok}/${HELDOUT3.length}`)
    if (h3.failed.length > 0) console.log(`      留出集3 没拦住：${h3.failed.join('、')}`)
  }

  console.log(`\n${'='.repeat(64)}\n对账\n${'='.repeat(64)}`)
  const drift = rows.map(r => r.h2 - RECORDED[r.v]!)
  console.log(`留出集2 本轮 vs 发现 07 记录，逐版差：${drift.join(' ')}`)
  console.log(`  （非零＝模型方差或环境漂移，不是题目造成的）`)
  const delta = rows.map(r => r.h3 - r.h2)
  console.log(`留出集3 vs 留出集2（同轮）：${delta.join(' ')}`)

  // 发现 07 的那条结论：弱反馈之后留出集全过，3 次里只有 r3 做到
  const full = (k: 'h2' | 'h3'): string[] =>
    rows.filter(r => r.v.endsWith('v2') || r.v.endsWith('v3')).filter(r => r[k] === HELDOUT2.length).map(r => r.v)
  console.log(`\n「反馈之后留出集全过」的版本：`)
  console.log(`  留出集2（本轮）：${full('h2').join('、') || '（无）'}`)
  console.log(`  留出集3        ：${full('h3').join('、') || '（无）'}`)
  console.log(`  发现 07 记录    ：r3-v2、r3-v3`)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((e: unknown) => { console.error('失败：', e instanceof Error ? e.message : e); process.exitCode = 1 })
}
