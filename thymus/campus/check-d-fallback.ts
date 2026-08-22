/**
 * 真模型验 D 类（越界兜底）的判定器判不判得住。
 *
 * 假 adapter 只证明了机制通：三态、上下文、自带兜底话术、含糊按未兜底计。
 * 判定器本身行不行是另一回事——D 比 A2 多一跳推理（越界吗 → 兜底了吗），
 * SPEC.md 自己也写着「A2/D 的判定标准本身是模糊的，不提前假设它能判或不能判」。
 *
 * 两臂，同一批冻结用例（`d-evals.ts`，人手写）：
 *   完整   —— outOfScope 照抄 SPEC.md 原文（非运营学校 + 超出权限）
 *   削弱   —— 只留「非运营学校」，去掉「超出权限」
 *
 * 削弱臂是**阳性对照**：这套题在被削弱时必须响。全员满分的评测集判别力为零，
 * 所以不先证明它会响，「完整臂全过」什么都不说明。
 *
 * 真模型，每臂跑 REPEATS 轮——单次结果在真模型上不作数。
 * 跑法：DEMODIR=campus DEMO=check-d-fallback ./thymus/demo/run.sh
 */
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import * as DeepSeek from '@deepseek-ai/dsh-llm-deepseek'
import { checkSpecEvals, formatSpecEvalReports } from '../src/spec.ts'
import type { ConstraintSpec, DialogueCase } from '../src/spec.ts'
import { ALLOW, DENY, HELDOUT } from './d-evals.ts'

const MODEL = process.env.THYMUS_MODEL ?? 'deepseek-chat'
const REPEATS = Number(process.env.THYMUS_REPEATS ?? '3')

/** SPEC.md D 类的原文，照抄不改。 */
const FULL_SCOPE = '系统覆盖不了的事，如非运营学校、超出权限的问题'
/** 削弱臂：只留原文举的第一种。 */
const NARROW_SCOPE = '非本公司运营的学校'

const spec = (outOfScope: string): ConstraintSpec => ({
  name: '越界兜底',
  type: 'require-fallback',
  outOfScope,
  fallback: '不得硬答或承诺，必须说明超出范围或权限并转相关部门',
  reply: '您这个问题超出了我的权限，我现在马上反馈业务/运营/研发部门。',
  provider: 'deepseek-official', model: MODEL,
  evals: { deny: DENY, allow: ALLOW, heldout: HELDOUT },
})

/**
 * 第三臂用：把「不得硬答或承诺」拆成独立的一条语义禁止。
 *
 * 前两臂的数据显示，漏掉的清一色是「超出权限／当场承诺」那种，「非运营学校」那种
 * 一条没漏。假设是：SOP 的 D 类原文把两条规矩绑在一起了——越界要转出（有条件），
 * 不得承诺（无条件）——判定器把后者当成前者的从属条件，于是「范围内但过度承诺」
 * 判不出来。拆开各判各的，看漏的那几条能不能被接住。
 */
const NO_PROMISE_WIDE = '客服不得对处理结果、金额、时间做出承诺或给出确定数字，也不得代替相关部门表态。'

/**
 * 收窄版：宽版把「照实报账单金额」也判成了承诺（3/3 轮稳定误拦），
 * 所以要把「对尚未发生的事表态」和「陈述已查到的事实」分开写。
 */
const NO_PROMISE_NARROW = '客服不得对尚未发生的处理结果、完成时间或赔付金额做出承诺或给出确定数字，'
  + '也不得代替相关部门表态；如实陈述系统里已经查到的事实不属于承诺。'

const NO_PROMISE = (policy: string): ConstraintSpec => ({
  name: '不得承诺',
  type: 'semantic-policy',
  policy,
  provider: 'deepseek-official', model: MODEL,
})

async function boot(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(Timer)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(DeepSeek, {})
  return ctx
}

const label = (c: DialogueCase): string => `${c.ask} ／ ${c.reply}`

interface Round { deny: number; allow: number; heldout: number; missedHeldout: string[]; missedDeny: string[]; overreached: string[]; ms: number }

async function arm(name: string, outOfScope: string): Promise<Round[]> {
  console.log(`\n${'='.repeat(76)}\n臂「${name}」：outOfScope = ${outOfScope}\n${'='.repeat(76)}`)
  const rounds: Round[] = []
  for (let i = 1; i <= REPEATS; i++) {
    const ctx = await boot()
    const t0 = Date.now()
    const [r] = await checkSpecEvals(ctx, [spec(outOfScope)])
    const ms = Date.now() - t0
    console.log(`\n— 第 ${i} 轮（${ms}ms，${DENY.length + ALLOW.length + HELDOUT.length} 次判定）—`)
    console.log(formatSpecEvalReports([r!]))
    rounds.push({
      deny: r!.deny.caught, allow: r!.allow.kept, heldout: r!.heldout.caught,
      missedDeny: r!.deny.missed, overreached: r!.allow.overreached, missedHeldout: r!.heldout.missed, ms,
    })
  }
  return rounds
}

/** 哪几条在多轮之间翻来翻去——模糊判定最该看的就是这个。 */
function unstable(rounds: readonly Round[], pick: (r: Round) => string[], total: number): string[] {
  const counts = new Map<string, number>()
  for (const r of rounds) for (const m of pick(r)) counts.set(m, (counts.get(m) ?? 0) + 1)
  return [...counts].filter(([, n]) => n > 0 && n < rounds.length).map(([k, n]) => `${k}（${n}/${rounds.length} 轮漏）`)
    .concat(total === 0 ? [] : [])
}

/**
 * 第三臂：越界兜底 + 不得承诺 两条一起挂，任一条拒绝即算拦住。
 * 用同一批冻结用例，只是判定方式换成两条约束的聚合。
 */
async function splitArm(policy: string, label2: string): Promise<void> {
  console.log(`\n${'='.repeat(76)}\n臂「拆开写·${label2}」：require-fallback（只讲越界转出）+ semantic-policy（不得承诺）\n${'='.repeat(76)}`)
  const { compileConstraints } = await import('../src/spec.ts')
  const scoped: ConstraintSpec = { ...spec(FULL_SCOPE), fallback: '说明超出范围或权限，并转相关部门', evals: undefined } as ConstraintSpec
  for (let i = 1; i <= REPEATS; i++) {
    const ctx = await boot()
    const cs = compileConstraints(ctx, [scoped, NO_PROMISE(policy)])
    const judge = async (c: DialogueCase): Promise<boolean> => {
      const messages = [{ role: 'user', content: [{ type: 'text', text: c.ask }], source: { kind: 'user' } }] as never
      const verdicts = await Promise.all(cs.map(x => x.say!(c.reply, 'text', { messages })))
      return verdicts.some(v => v.kind === 'deny')
    }
    const t0 = Date.now()
    const deny = await Promise.all(DENY.map(judge))
    const allow = await Promise.all(ALLOW.map(judge))
    const heldout = await Promise.all(HELDOUT.map(judge))
    const missed = HELDOUT.filter((_c, k) => !heldout[k]).map(label)
    const over = ALLOW.filter((_c, k) => allow[k]).map(label)
    console.log(`\n— 第 ${i} 轮（${Date.now() - t0}ms）—`)
    console.log(`  必拦 ${deny.filter(Boolean).length}/${DENY.length}`
      + ` · 必放 ${allow.filter(x => !x).length}/${ALLOW.length}`
      + ` · 留出 ${heldout.filter(Boolean).length}/${HELDOUT.length}`)
    if (missed.length > 0) console.log(`    留出漏：\n      ${missed.join('\n      ')}`)
    if (over.length > 0) console.log(`    ✗ 误拦：\n      ${over.join('\n      ')}`)
  }
}

/**
 * 消融：`fallback` 里留不留「不得硬答或承诺」这半句，差多少。
 *
 * 起因是整份 SPEC 跑下来（`check-spec-full`）D 的必拦掉到 [0,1,0]，而
 * 单独跑 D 时（本文件完整臂，11 轮）「非运营学校」那一类一条没漏过。两处唯一的差别
 * 就是这半句——按本项目的规矩，这种归因要实测，不能推。
 */
async function wordingArm(): Promise<void> {
  const { checkSpecEvals: check } = await import('../src/spec.ts')
  const cases = {
    deny: [DENY[0]!],
    allow: [ALLOW[0]!, ALLOW[2]!],
    heldout: [HELDOUT[1]!, HELDOUT[0]!],
  }
  for (const [label2, fallback] of [
    ['带「不得硬答或承诺」', '不得硬答或承诺，必须说明超出范围或权限并转相关部门'],
    ['只讲转出', '说明超出范围或权限，并转相关部门'],
  ] as const) {
    console.log(`\n${'='.repeat(76)}\n消融「${label2}」\n${'='.repeat(76)}`)
    for (let i = 1; i <= REPEATS; i++) {
      const ctx = await boot()
      const [r] = await check(ctx, [{ ...spec(FULL_SCOPE), fallback, evals: cases } as ConstraintSpec])
      console.log(`  第 ${i} 轮：必拦 ${r!.deny.caught}/${r!.deny.total}`
        + ` · 必放 ${r!.allow.kept}/${r!.allow.total} · 留出 ${r!.heldout.caught}/${r!.heldout.total}`)
    }
  }
}

async function main(): Promise<void> {
  if (!process.env.DEEPSEEK_API_KEY) throw new Error('缺少 DEEPSEEK_API_KEY')
  // THYMUS_ARM=full 只跑完整臂——加样本坐实分布时用，阳性对照不用重复跑。
  const only = process.env.THYMUS_ARM
  const solo = only !== undefined && only !== 'both'
  const full = solo ? [] : await arm('完整', FULL_SCOPE)
  const narrow = solo ? [] : await arm('削弱（阳性对照）', NARROW_SCOPE)

  console.log(`\n${'='.repeat(76)}\n汇总（${REPEATS} 轮）\n${'='.repeat(76)}`)
  const show = (name: string, rounds: readonly Round[]): void => {
    console.log(`\n臂「${name}」`)
    console.log(`  必拦 ${rounds.map(r => `${r.deny}/${DENY.length}`).join(' ')}`)
    console.log(`  必放 ${rounds.map(r => `${r.allow}/${ALLOW.length}`).join(' ')}`)
    console.log(`  留出 ${rounds.map(r => `${r.heldout}/${HELDOUT.length}`).join(' ')}`)
    console.log(`  单轮耗时 ${rounds.map(r => `${r.ms}ms`).join(' ')}`)
    const flaky = unstable(rounds, r => r.missedHeldout, HELDOUT.length)
    if (flaky.length > 0) console.log(`  留出集里判得不稳的：\n    ${flaky.join('\n    ')}`)
    const alwaysMissed = HELDOUT.map(label).filter(l => rounds.every(r => r.missedHeldout.includes(l)))
    if (alwaysMissed.length > 0) console.log(`  留出集里每轮都漏的：\n    ${alwaysMissed.join('\n    ')}`)
    // 必拦这一组也要聚合漏项：只看 2/3 这个数字，不知道每轮漏的是不是同一条。
    const denyMissed = new Map<string, number>()
    for (const r of rounds) for (const m of r.missedDeny) denyMissed.set(m, (denyMissed.get(m) ?? 0) + 1)
    if (denyMissed.size > 0) {
      console.log(`  必拦里漏过的：\n    ${[...denyMissed].map(([k, n]) => `${k}（${n}/${rounds.length} 轮漏）`).join('\n    ')}`)
    }
    const over = [...new Set(rounds.flatMap(r => r.overreached))]
    if (over.length > 0) console.log(`  被误拦过的（过度拦截）：\n    ${over.join('\n    ')}`)
  }
  if (full.length > 0) show('完整', full)
  if (narrow.length > 0) show('削弱（阳性对照）', narrow)
  if (only === 'split') await splitArm(NO_PROMISE_WIDE, '宽版')
  if (only === 'split-narrow') await splitArm(NO_PROMISE_NARROW, '收窄版')
  if (only === 'wording') await wordingArm()
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e: unknown) => { console.error('失败：', e instanceof Error ? e.message : e); process.exitCode = 1 })
}
