/**
 * 拿 `checkEvalGradient` 体检 A2 的三组冻结评测集。
 *
 * 冻结之前该跑的那道闸：负向断言在空插件组下每条都必须垮，垮不掉就是死用例；
 * 正向断言（过度改写对照）空组下通过属正常。不调模型，确定性。
 *
 * 跑法：DEMODIR=campus DEMO=check-a2-gradient ./thymus/demo/run.sh
 */
import { pathToFileURL } from 'node:url'
import { checkEvalGradient } from '../src/eval-framework.ts'
import { PUBLIC, HELDOUT, HELDOUT2, INTACT } from './a2-evals.ts'

async function main(): Promise<void> {
  let bad = 0
  for (const [name, cases] of [['公开集', PUBLIC], ['留出集', HELDOUT], ['留出集2', HELDOUT2]] as const) {
    const r = await checkEvalGradient(cases, () => [])
    console.log(`${name}（${r.total} 条）：${r.ok ? '✓ 通过' : '✗ 不通过'}`
      + ` · 空组下垮掉 ${r.brokenByEmpty} 条 · 正向对照通过 ${r.passingPositives} 条`)
    for (const d of r.deadNegatives) { console.log(`    ✗ 死用例（负向断言但空组也过）：${d}`); bad++ }
  }
  // 回归集全部是正向断言，按设计就没有梯度——只报数，不按约束评测集的判据卡。
  const g = await checkEvalGradient(INTACT, () => [])
  console.log(`回归集（${g.total} 条，全正向）：空组下垮掉 ${g.brokenByEmpty} 条`
    + ` · 正向通过 ${g.passingPositives} 条`
    + `${g.brokenByEmpty === 0 ? ' —— 符合预期：不挂插件时合规话术本就该原样通过' : ' —— ★ 异常：有合规话术在空插件组下就没原样返回'}`)
  if (g.brokenByEmpty > 0) bad++

  if (bad > 0) process.exitCode = 1
}

// 只在被直接执行时跑。
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e: unknown) => { console.error('失败：', e instanceof Error ? e.message : e); process.exitCode = 1 })
}
