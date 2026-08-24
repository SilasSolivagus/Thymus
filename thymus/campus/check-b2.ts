/**
 * 真模型验 `require-before-say`：判定器判不判得住「这句话在不在讲账号的事」。
 *
 * 假判定器只证明了机制通（三态、事实优先、含糊按涉及计）。按发现 20 的教训，
 * 机制通不等于判定器判得住，这一步不能省。
 *
 * 三臂，同一批冻结用例（`b2-evals.ts`）：
 *   完整 —— topic 照抄 SOP 原文（账期、费用、账号详情）
 *   削弱 —— topic 只写「费用」（阳性对照：必拦与留出应当掉）
 *   写宽 —— topic 写成「任何与这位用户有关的信息」（阳性对照：必放应当掉）
 *
 * 两个方向的阳性对照都要有：只往窄了削，看不出「写宽会过度拦截」，
 * 而那一侧只有 allow 那组抓得住（发现 20 的教训）。
 *
 * 顺带数一件事：**判定调用次数**。事实成立时应当直接放行、不问模型，
 * 所以判定次数应当明显少于用例数。
 *
 * 跑法：DEMODIR=campus DEMO=check-b2 ./thymus/demo/run.sh
 */
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import * as DeepSeek from '@deepseek-ai/dsh-llm-deepseek'
import { checkSpecEvals, formatSpecEvalReports } from '../src/spec.ts'
import type { ConstraintSpec } from '../src/spec.ts'
import { ALLOW, DENY, HELDOUT } from './b2-evals.ts'

const MODEL = process.env.THYMUS_MODEL ?? 'deepseek-chat'
const REPEATS = Number(process.env.THYMUS_REPEATS ?? '3')
const TOTAL = DENY.length + ALLOW.length + HELDOUT.length

/** SOP 原文照抄。 */
const FULL_TOPIC = '具体账号的账期、费用、账号详情'
const NARROW_TOPIC = '具体账号的费用'
const WIDE_TOPIC = '任何与这位用户有关的信息'

const spec = (topic: string): ConstraintSpec => ({
  name: 'B2 认人后才能答账号问题',
  type: 'require-before-say',
  requires: 'lookup_account',
  topic,
  reply: '麻烦您先提供一下学号、手机号码，这边为您查询。',
  provider: 'deepseek-official', model: MODEL,
  evals: { deny: DENY, allow: ALLOW, heldout: HELDOUT },
})

/** 建宿主，并数判定调用次数——这一轮没有 agent，`llm.stream` 只服务判定器。 */
async function boot(): Promise<{ ctx: Context; judgeCalls: () => number }> {
  const ctx = new Context()
  await ctx.plugin(Timer)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(DeepSeek, {})
  let calls = 0
  const llm = ctx.llm as unknown as { stream: (o: GenerateOptions) => AsyncIterable<StreamChunk> }
  const inner = llm.stream.bind(llm)
  llm.stream = (o: GenerateOptions): AsyncIterable<StreamChunk> => { calls++; return inner(o) }
  return { ctx, judgeCalls: () => calls }
}

async function arm(label: string, topic: string): Promise<void> {
  console.log(`\n${'='.repeat(76)}\n臂「${label}」：topic = ${topic}\n${'='.repeat(76)}`)
  for (let i = 1; i <= REPEATS; i++) {
    const { ctx, judgeCalls } = await boot()
    const t0 = Date.now()
    const [r] = await checkSpecEvals(ctx, [spec(topic)])
    console.log(`\n— 第 ${i} 轮（${Date.now() - t0}ms，${TOTAL} 条用例，判定调用 ${judgeCalls()} 次）—`)
    console.log(formatSpecEvalReports([r!]))
  }
}

async function main(): Promise<void> {
  if (!process.env.DEEPSEEK_API_KEY) throw new Error('缺少 DEEPSEEK_API_KEY')
  const only = process.env.THYMUS_ARM
  if (only === undefined || only === 'full') await arm('完整（SOP 原文）', FULL_TOPIC)
  if (only === undefined || only === 'narrow') await arm('削弱（只写费用）', NARROW_TOPIC)
  if (only === undefined || only === 'wide') await arm('写宽（任何相关信息）', WIDE_TOPIC)
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e: unknown) => { console.error('失败：', e instanceof Error ? e.message : e); process.exitCode = 1 })
}
