/**
 * 消融：把 arm on 插件的字面门控拿掉，其余一字不动，重判留出集。
 *
 * a2-ab.ts 的结果是 arm on 留出集 3/6，失败的 3 条原文一字未动。静态复查显示
 * 插件在调模型之前加了一道字面门控：`if (!patternHit && !suspicious) return original`
 * ——词表和可疑词正则都没命中就直接放行，模型根本不会被调用。
 *
 * 这一步分开两件事：是模型判不出来，还是模型压根没被问。
 * 只改门控那一行（改成永不提前返回），其余源码原样，跑同一批留出集用例。
 *
 * 跑法：DEMODIR=campus DEMO=a2-gate-ablation ./thymus/demo/run.sh
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import * as DeepSeek from '@deepseek-ai/dsh-llm-deepseek'
import { judgeCases, type JudgeOptions } from '../src/eval-framework.ts'
import { HELDOUT } from './a2-evals.ts'

const OUT = process.env.THYMUS_OUT ?? resolve(process.cwd(), 'thymus-campus-out')
const GATE = 'if (!patternHit && !suspicious) return original;'

async function main(): Promise<void> {
  if (!process.env.DEEPSEEK_API_KEY) throw new Error('缺少 DEEPSEEK_API_KEY')
  const original = readFileSync(resolve(OUT, 'a2-on-plugin.js'), 'utf8')
  if (!original.includes(GATE)) throw new Error(`没找到门控那一行，插件源码变了：${GATE}`)
  const ablated = original.replace(GATE, '// 门控已消融：每句都问模型')
  const options: JudgeOptions = { llm: (ctx: Context) => ctx.plugin(DeepSeek, {}) as unknown as Promise<void> }

  console.log(`留出集 ${HELDOUT.length} 条 · 只改门控一行，其余 ${original.length} 字符原样\n`)
  let passed = 0
  for (const c of HELDOUT) {
    const t0 = Date.now()
    const r = await judgeCases(ablated, [c], () => [], options)
    if (r.passed) passed++
    console.log(`  ${r.passed ? '✓' : '✗'} ${c.description} · ${Date.now() - t0}ms${r.passed ? '' : `\n      ${r.diffs[0]}`}`)
  }
  console.log(`\n门控消融后：${passed}/${HELDOUT.length}（原插件 3/${HELDOUT.length}）`)
  console.log(passed > 3
    ? '  → 那 3 条漏在门控，不漏在判定：模型没被问到。'
    : '  → 拿掉门控也没多过：漏在判定本身，不在门控。')
}

// 只在被直接执行时跑。
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e: unknown) => { console.error('\n运行失败：', e instanceof Error ? e.message : e); process.exitCode = 1 })
}
