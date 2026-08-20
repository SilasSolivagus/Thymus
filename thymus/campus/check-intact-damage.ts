/**
 * 拿回归集测已存盘的插件：拦得多的，是不是也改坏得多。
 *
 * 发现 07 的 r1 露出这个权衡（留出集 2→5 的同时公开集 9→7→6），但当时公开集里
 * 只有 2 条过度改写对照，测得出坏了，测不出坏到什么程度。回归集 20 条补上这一维。
 *
 * 不重新生成插件，直接读 submitted/ 下已冻结的源码，所以这一轮只花判定的钱。
 * 每条用例断言合规话术逐字原样返回，任何改写都算破坏。
 *
 * 跑法：DEMODIR=campus DEMO=check-intact-damage ./thymus/demo/run.sh
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import * as DeepSeek from '@deepseek-ai/dsh-llm-deepseek'
import { judgeCases, type JudgeOptions } from '../src/eval-framework.ts'
import { INTACT, HELDOUT2 } from './a2-evals.ts'

const OUT = process.env.THYMUS_OUT ?? resolve(process.cwd(), 'thymus-campus-out')

/** 被测插件：发现 11 同批跑出来的六个，留出集2 成绩已知，正好做相关性对照。 */
const PLUGINS = [
  { file: 'a2-jspace-base-r1.js', label: 'base/r1', held2: 6 },
  { file: 'a2-jspace-base-r2.js', label: 'base/r2', held2: 6 },
  { file: 'a2-jspace-base-r3.js', label: 'base/r3', held2: 6 },
  { file: 'a2-jspace-jspace-r1.js', label: 'jspace/r1', held2: 1 },
  { file: 'a2-jspace-jspace-r2.js', label: 'jspace/r2', held2: 2 },
  { file: 'a2-jspace-jspace-r3.js', label: 'jspace/r3', held2: 2 },
  { file: 'a2-feedback-r1-v2.js', label: '历史 r1/v2', held2: 2 },
  { file: 'a2-feedback-r1-v3.js', label: '历史 r1/v3', held2: 5 },
]

/**
 * 合成阳性对照：一个必定过度改写的插件（每段文本加个后缀）。
 *
 * 需要它是因为——真实插件一个都没触发回归集，而「全员满分」的评测集判别力为零，
 * 和公开集是同一个毛病。必须先证明这套题在真被破坏时会响，否则 20/20 只能说明
 * 「这批数据里没发生过度改写」，不能说明「这套题测得出过度改写」。
 *
 * 顺带纠正一处：原以为发现 07 的 r1 是「改坏合规话术」，查逐条数据才发现它公开集
 * 掉的全是禁语用例（做不到／系统崩了／系统出bug了），两条过度改写对照一次都没垮。
 * 真实权衡是「拦住新的、丢掉旧的」，不是误伤合规话术。
 */
const SYNTHETIC_OVERWRITER = `
  return { name:'overwriter', apply(ctx){
    ctx.on('llm/stream',(o,next)=>{
      const up = next();
      return (async function*(){
        for await (const c of up) {
          if (c && c.type === 'text-delta') { yield { ...c, text: '【已优化】' + c.text }; continue; }
          if (c && c.type === 'block-end' && c.block && c.block.type === 'text') {
            yield { ...c, block: { ...c.block, text: '【已优化】' + c.block.text } }; continue;
          }
          yield c;
        }
      })();
    });
  } }`

async function main(): Promise<void> {
  if (!process.env.DEEPSEEK_API_KEY) throw new Error('缺少 DEEPSEEK_API_KEY')
  const options: JudgeOptions = { llm: (ctx: Context) => ctx.plugin(DeepSeek, {}) as unknown as Promise<void> }
  console.log(`回归集 ${INTACT.length} 条 · 被测插件 ${PLUGINS.length} 个 · 断言合规话术逐字原样返回\n`)

  const rows: { label: string; held2: number; kept: number; damaged: string[]; ms: number }[] = []
  for (const p of PLUGINS) {
    const src = readFileSync(resolve(OUT, p.file), 'utf8')
    const t0 = Date.now()
    const damaged: string[] = []
    for (const c of INTACT) {
      const r = await judgeCases(src, [c], () => [], options)
      if (!r.passed) damaged.push(c.description)
    }
    const ms = Date.now() - t0
    rows.push({ label: p.label, held2: p.held2, kept: INTACT.length - damaged.length, damaged, ms })
    console.log(`${p.label.padEnd(10)} 留出集2 ${p.held2}/${HELDOUT2.length}`
      + ` · 回归集保住 ${INTACT.length - damaged.length}/${INTACT.length} · ${ms}ms`)
    for (const d of damaged.slice(0, 4)) console.log(`    ✗ 被改写：${d}`)
    if (damaged.length > 4) console.log(`     …另有 ${damaged.length - 4} 条`)
  }

  const syn: string[] = []
  for (const c of INTACT) {
    const r = await judgeCases(SYNTHETIC_OVERWRITER, [c], () => [], options)
    if (!r.passed) syn.push(c.description)
  }
  console.log(`\n仪器灵敏度对照（合成的必定过度改写插件）：回归集保住 ${INTACT.length - syn.length}/${INTACT.length}`)
  console.log(syn.length === INTACT.length
    ? '  ✓ 全部垮掉——这套题在真被破坏时会响，上面的 20/20 是真干净'
    : `  ★ 只垮掉 ${syn.length} 条——灵敏度不足，20/20 说明不了问题`)

  console.log('\n对账：拦得多的是不是也改坏得多')
  console.log('  插件        留出集2(拦截)  回归集保住(不误伤)')
  for (const r of rows) console.log(`  ${r.label.padEnd(11)} ${r.held2}/6            ${r.kept}/${INTACT.length}`)
  const hi = rows.filter(r => r.held2 >= 5)
  const lo = rows.filter(r => r.held2 <= 2)
  const avg = (xs: number[]): string => xs.length === 0 ? '—' : (xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(1)
  console.log(`\n  拦得多的一组（留出集2 ≥5，n=${hi.length}）：回归集平均保住 ${avg(hi.map(r => r.kept))}/${INTACT.length}`)
  console.log(`  拦得少的一组（留出集2 ≤2，n=${lo.length}）：回归集平均保住 ${avg(lo.map(r => r.kept))}/${INTACT.length}`)
}

// 只在被直接执行时跑。
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e: unknown) => { console.error('失败：', e instanceof Error ? e.message : e); process.exitCode = 1 })
}
