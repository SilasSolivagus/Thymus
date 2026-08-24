/**
 * 给撞闸的两条替代话术出候选，用 `checkReplacements` 逐条打分。
 *
 * 冻结闸拦下了 campus 这份 SPEC 的两条替代话术（发现 29 结论 4）。这里不直接改声明，
 * 先把候选摆上闸——过得了的交人挑，一条都过不了就说明拦的是设计不是措辞。
 *
 * 每条候选拿**所有**约束在各自触发条件下判，`repeats` 与冻结闸同为 5（发现 29 六）。
 *
 * 跑法：DEMODIR=campus DEMO=check-wording-candidates ./thymus/demo/run.sh
 */
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import * as DeepSeek from '@deepseek-ai/dsh-llm-deepseek'
import { checkReplacements } from '../src/spec.ts'
import { DECLARATIONS } from './spec-declarations.ts'

const REPEATS = Number(process.env.THYMUS_REPLACEMENT_REPEATS ?? '5')

/** B2 的候选：要么绕开「说出账号字段」，要么把兜底义务也一起说了。 */
const B2_CANDIDATES: string[] = [
  '麻烦您先提供一下学号、手机号码，这边为您查询。',                     // 现状，对照
  '为了保护您的账号安全，需要先完成身份核验才能继续。',                 // 不点名字段
  '这个我需要先核验您的身份才能答复。',                                 // 更短，不点名字段
  '这个问题我这边暂时不能直接答复：需要先核验身份；若超出我们的服务范围，会转相关部门跟进。',  // 两头都说
]

/** 网关兜底串的候选：现状只说「转人工」，没说明超出范围或权限。 */
const GATEWAY_CANDIDATES: string[] = [
  '抱歉，这个问题我需要转人工为您处理。',                               // 现状，对照
  '抱歉，这个问题超出我这边能处理的范围，我帮您转相关部门跟进。',
  '抱歉，这个问题超出我的权限，我转给相关部门为您跟进。',
]

async function boot(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(Timer)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(DeepSeek, {})
  return ctx
}

async function main(): Promise<void> {
  if (!process.env.DEEPSEEK_API_KEY) throw new Error('缺少 DEEPSEEK_API_KEY')
  const extra = [
    ...B2_CANDIDATES.map((text, i) => ({ from: `B2候选${i}${i === 0 ? '（现状）' : ''}`, text })),
    ...GATEWAY_CANDIDATES.map((text, i) => ({ from: `网关候选${i}${i === 0 ? '（现状）' : ''}`, text })),
  ]
  console.log(`候选 ${extra.length} 条，每条拿全部约束在各自触发条件下判 ${REPEATS} 次\n`)
  // 只判候选：把声明自带的 reply 排除掉，免得输出里混进不相干的行
  const specsNoReply = DECLARATIONS.map(s => 'reply' in s ? { ...s, reply: undefined } as never : s)
  const reports = await checkReplacements(await boot(), specsNoReply, extra, { repeats: REPEATS })
  for (const r of reports) {
    console.log(`${r.ok ? '✓' : '✗'} [${r.from}]「${r.text}」`)
    for (const h of r.hits) console.log(`      撞上 ${h.constraint}（${h.trigger}）`)
  }
  const ok = reports.filter(r => r.ok)
  console.log(`\n过闸的候选：${ok.length}/${reports.length}`)
  for (const r of ok) console.log(`  [${r.from}]「${r.text}」`)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((e: unknown) => { console.error('失败：', e instanceof Error ? e.message : e); process.exitCode = 1 })
}
