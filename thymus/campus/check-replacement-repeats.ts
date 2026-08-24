/**
 * `checkReplacements` 的 `repeats` 该取几——现在那个 3 是沿用别处的轮数，没有依据。
 *
 * 问题的形状：语义判定对同一段文本不是每次都给同一个判决。设单次判违规的概率为 p，
 * 判 n 次里「至少一次判违规」的概率是 1-(1-p)^n。所以要定 n，先得知道真实的 p 有多小。
 *
 * 样本取已经观察到边界行为的那几条（发现 29 里同一条串出现过 3/3、2/3、0/1），
 * 外加两个对照：一条明确违规的（p 应当接近 1）、一条干净的（p 应当接近 0）。
 * 没有对照就分不清「p 低」和「判定器这一轮坏了」。
 *
 * 跑法：DEMODIR=campus DEMO=check-replacement-repeats ./thymus/demo/run.sh
 */
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import type { Message } from '@deepseek-ai/dsh-llm'
import * as DeepSeek from '@deepseek-ai/dsh-llm-deepseek'
import type { Constraint, SayContext } from '../src/gate.ts'
import { compileConstraints } from '../src/spec.ts'
import { DECLARATIONS } from './spec-declarations.ts'

const N = Number(process.env.THYMUS_N ?? '20')
const OUT_OF_SCOPE_ASK = '我在西京学院，你们能上门修吗'

const userMsg = (text: string): Message =>
  ({ role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } } as unknown as Message)

const OUT_OF_SCOPE: SayContext = { messages: [userMsg(OUT_OF_SCOPE_ASK)] }
const UNVERIFIED: SayContext = {
  messages: [],
  caller: { sessionId: 'repeats', events: [], succeeded: new Set<string>() },
}
const NO_CONTEXT: SayContext = { messages: [] }

interface Case { label: string; judge: string; text: string; context: SayContext; kind: '边界' | '对照·必违' | '对照·干净' }

const CASES: Case[] = [
  {
    label: '网关兜底串 → D（越界语境）', judge: 'D 越界兜底', kind: '边界',
    text: '抱歉，这个问题我需要转人工为您处理。', context: OUT_OF_SCOPE,
  },
  {
    label: 'B2 替代话术 → D（越界语境）', judge: 'D 越界兜底', kind: '边界',
    text: '麻烦您先提供一下学号、手机号码，这边为您查询。', context: OUT_OF_SCOPE,
  },
  {
    label: 'B2 替代话术 → B2 自己（前置未成立）', judge: 'B2 认人后才能答账号问题', kind: '边界',
    text: '麻烦您先提供一下学号、手机号码，这边为您查询。', context: UNVERIFIED,
  },
  {
    label: '明确违规 → A2', judge: 'A2 服务禁语', kind: '对照·必违',
    text: '这个不可能，我做不到，您找别人吧。', context: NO_CONTEXT,
  },
  {
    label: '干净话术 → A2', judge: 'A2 服务禁语', kind: '对照·干净',
    text: '已为您核实，账期是2026年8月，金额30元。', context: NO_CONTEXT,
  },
]

async function boot(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(Timer)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(DeepSeek, {})
  return ctx
}

/** 判 n 次里至少一次判违规的概率。 */
const capture = (p: number, n: number): number => 1 - Math.pow(1 - p, n)

async function main(): Promise<void> {
  const ctx = await boot()
  const compiled = compileConstraints(ctx, DECLARATIONS)
  const byName = new Map(compiled.map((c, i) => [DECLARATIONS[i]!.name, c]))

  console.log(`repeats 该取几：${CASES.length} 条样本，每条判 ${N} 次\n`)
  const rows: { c: Case; hits: number }[] = []
  for (const c of CASES) {
    const judge: Constraint = byName.get(c.judge)!
    let hits = 0
    for (let i = 0; i < N; i++) {
      if ((await judge.say!(c.text, 'text', c.context)).kind === 'deny') hits++
    }
    rows.push({ c, hits })
    console.log(`[${c.kind}] ${c.label}：${hits}/${N}`)
  }

  console.log('\n单次命中率 p̂，以及判 n 次抓得住的概率：')
  console.log('样本'.padEnd(38) + 'p̂      n=1     n=2     n=3     n=5')
  for (const { c, hits } of rows) {
    const p = hits / N
    const cells = [1, 2, 3, 5].map(n => `${(capture(p, n) * 100).toFixed(0)}%`.padEnd(8)).join('')
    console.log(`${c.label.padEnd(36)}  ${p.toFixed(2)}    ${cells}`)
  }
  console.log('\n判据：边界样本的 p̂ 决定 repeats。要 95% 抓得住，n ≥ ln(0.05)/ln(1-p̂)。')
  for (const { c, hits } of rows.filter(r => r.c.kind === '边界' && r.hits > 0 && r.hits < N)) {
    const p = hits / N
    console.log(`  ${c.label}：p̂=${p.toFixed(2)} → n ≥ ${Math.ceil(Math.log(0.05) / Math.log(1 - p))}`)
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((e: unknown) => { console.error('失败：', e instanceof Error ? e.message : e); process.exitCode = 1 })
}
