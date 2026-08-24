/**
 * 真模型交叉验证：说话侧的替代话术，会不会自己违反另一类规矩。
 *
 * 背景是 HANDOFF「已知未解」那条：判定器只看到孤立一句，没有会话上下文与工具调用
 * 事实，拒绝时换上去的那句话可能凭空补事实（「我这就为您转接」），A2 违规换成
 * B/D 违规。
 *
 * 机制那半已经确定性验过（`gate.spec.ts` 论证94）：替代话术是固定串，`rewriteSay`
 * 把它直接塞进正文块，**发出之前不再过任何约束**，另一条约束一次都不响。
 * 所以这里只剩一个问题——真实交付里写出来的替代话术，有多大比例本身就违规。
 *
 * 样本两类：
 *   真的 —— 声明里已有的（B2.reply / D.reply）与网关兜底串
 *   写的 —— 让模型照单条规矩各写 3 条（交付时填表就是这么写的）
 *
 * 判定用同一份声明里的**其他**约束，跳过它自己那条：自指那件事发现 27 验过了。
 * 每条判定重复 THYMUS_REPEATS 次（缺省 3）——n=1 的结论这个项目栽过（发现 12）。
 *
 * 跑法：DEMODIR=campus DEMO=check-replacement-crossclass ./thymus/demo/run.sh
 */
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import * as DeepSeek from '@deepseek-ai/dsh-llm-deepseek'
import { judgeText, type Constraint, type SayContext } from '../src/gate.ts'
import { compileConstraints } from '../src/spec.ts'
import { DECLARATIONS } from './spec-declarations.ts'

const MODEL = process.env.THYMUS_MODEL ?? 'deepseek-chat'
const REPEATS = Number(process.env.THYMUS_REPEATS ?? '3')

/**
 * D 要靠用户那句提问才判得了。两个语境都要判：
 * 只判越界语境等于把 D 的触发条件强行打开，那个数是造出来的，不是测出来的。
 */
const OUT_OF_SCOPE_ASK = '我在西京学院，你们能上门修吗'
const IN_SCOPE_ASK = '我这个月账单多少'

const userMsg = (text: string): Message =>
  ({ role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } } as unknown as Message)

/** 未认人的调用方身份：B2 的触发条件就是这个。 */
const UNVERIFIED: SayContext['caller'] =
  { sessionId: 'crossclass', events: [], succeeded: new Set<string>() }

/** 一条替代话术样本。`from` 是它属于哪条约束，判定时跳过自己。 */
interface Sample { from: string; origin: '声明里已有' | '模型写的'; text: string }

/** 判定器：拿同一份声明编译出来的约束去判一段话。 */
interface Judge { name: string; label?: string; context: SayContext }

const JUDGES: Judge[] = [
  { name: 'A1 内部术语不外泄', context: { messages: [] } },
  { name: 'A2 服务禁语', context: { messages: [] } },
  { name: 'D2 不得承诺', context: { messages: [] } },
  { name: 'B2 认人后才能答账号问题', context: { messages: [], caller: UNVERIFIED } },
  { name: 'D 越界兜底', label: 'D 越界兜底（越界语境）', context: { messages: [userMsg(OUT_OF_SCOPE_ASK)] } },
  { name: 'D 越界兜底', label: 'D 越界兜底（在范围内·对照）', context: { messages: [userMsg(IN_SCOPE_ASK)] } },
]

async function boot(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(Timer)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(DeepSeek, {})
  return ctx
}

/** 让模型照单条规矩写一句替代话术——交付时填表的人看到的也只有这条规矩。 */
async function authorReplacement(ctx: Context, rule: string): Promise<string> {
  const options: GenerateOptions = {
    provider: 'deepseek-official', model: MODEL,
    system: '你在为一个校园网客服 agent 填写约束声明的「替代话术」一栏。'
      + '当客服要说的话违反这条规矩时，系统会把整句换成你写的这句固定话术。',
    messages: [userMsg(`规矩：${rule}\n\n请只输出一句替代话术，不要解释、不要引号。`)],
  } as GenerateOptions
  return (await judgeText(ctx, options)).trim().replace(/^["“]|["”]$/g, '')
}

/** 判 REPEATS 次，返回判为违规的次数。 */
async function denials(c: Constraint, text: string, context: SayContext): Promise<number> {
  let n = 0
  for (let i = 0; i < REPEATS; i++) {
    const v = await c.say!(text, 'text', context)
    if (v.kind === 'deny') n++
  }
  return n
}

async function main(): Promise<void> {
  const ctx = await boot()
  const compiled = compileConstraints(ctx, DECLARATIONS)
  const byName = new Map(compiled.map((c, i) => [DECLARATIONS[i]!.name, c]))
  const specByName = new Map(DECLARATIONS.map(s => [s.name, s]))

  const samples: Sample[] = []
  for (const name of ['B2 认人后才能答账号问题', 'D 越界兜底']) {
    const s = specByName.get(name) as { reply?: string }
    samples.push({ from: name, origin: '声明里已有', text: s.reply! })
  }
  samples.push({
    from: '网关兜底', origin: '声明里已有',
    text: '抱歉，这个问题我需要转人工为您处理。',
  })

  // 模型写的：A2 / B2 / D 各三条，只给它那一条规矩的原文
  const rules: [string, string][] = [
    ['A2 服务禁语', (specByName.get('A2 服务禁语') as { policy: string }).policy],
    ['B2 认人后才能答账号问题',
      `未核验用户身份前，不得回复${(specByName.get('B2 认人后才能答账号问题') as { topic: string }).topic}`],
    ['D 越界兜底',
      `遇到${(specByName.get('D 越界兜底') as { outOfScope: string }).outOfScope}时，`
      + (specByName.get('D 越界兜底') as { fallback: string }).fallback],
  ]
  for (const [from, rule] of rules) {
    for (let i = 0; i < 3; i++) {
      samples.push({ from, origin: '模型写的', text: await authorReplacement(ctx, rule) })
    }
  }

  console.log(`替代话术交叉验证：${samples.length} 条样本 × 其他约束，每条判 ${REPEATS} 次`)
  console.log(`D 判两个语境：越界（「${OUT_OF_SCOPE_ASK}」）与在范围内（「${IN_SCOPE_ASK}」，对照）\n`)

  let violating = 0
  for (const s of samples) {
    const hits: string[] = []
    for (const j of JUDGES) {
      if (j.name === s.from) continue                       // 跳过自指
      const n = await denials(byName.get(j.name)!, s.text, j.context)
      if (n > 0) hits.push(`${j.label ?? j.name} ${n}/${REPEATS}`)
    }
    if (hits.length > 0) violating++
    console.log(`[${s.from}｜${s.origin}]「${s.text}」`)
    console.log(`   ${hits.length === 0 ? '✓ 其他约束都放行' : `✗ 撞上：${hits.join('，')}`}`)
  }
  console.log(`\n${violating}/${samples.length} 条替代话术至少违反一条别的规矩。`)
  console.log('对照那一列是判据：在范围内的语境下 D 也拦，说明是判定器过度拦截，不是话术的问题。')
  console.log('这些违规现在没有任何位置会发现——替代话术发出之前不再过闸（论证94）。')
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((e: unknown) => { console.error('失败：', e instanceof Error ? e.message : e); process.exitCode = 1 })
}
