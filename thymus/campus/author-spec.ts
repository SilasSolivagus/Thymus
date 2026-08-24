/**
 * 本轮原命题的另一半：**同一份 SPEC 交给模型自己写声明**，跟人写的那份比。
 *
 * 上一轮比的是「让它写插件」，那个对照很脏——插件是代码，好坏混着挂载点、API 用法、
 * 递归防护一起评。声明是数据，验收用例跟着走，两边评的是同一组题，干净得多。
 *
 * 三处设计，决定这个实验测的是什么：
 *
 * 一、**共同标尺**：两份声明都拿人写的那组冻结用例打分（`spec-declarations.ts`），
 *     而且按**整份声明集**算——一条用例只要集合里任一条约束拦住就算拦住。
 *     模型写的条数、命名、类型选择都可能跟人写的对不上，不做一对一映射。
 *
 * 二、**它只看得到 SPEC.md 原文 + 内置类型的字段说明**。不给人写的声明，更不给用例——
 *     给了就是照差异改，测的不是它自己写得怎么样（发现 06 的教训）。
 *
 * 三、**独立会话 n=3**。单次结果不作数，而且要看分布。
 *
 * 另外单独看它自己写的 `evals`，尤其留出集：发现 05 记着「出题 agent 看到的也只有
 * SPEC，它生不出 SPEC 没列但语义同类的留出用例」。这次是那条断言在声明形态下的复验。
 *
 * 跑法：DEMODIR=campus DEMO=author-spec ./thymus/demo/run.sh
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import * as DeepSeek from '@deepseek-ai/dsh-llm-deepseek'
import { judgeText } from '../src/gate.ts'
import type { ConstraintSpec } from '../src/spec.ts'

const MODEL = process.env.THYMUS_MODEL ?? 'deepseek-chat'
const OUT = process.env.THYMUS_OUT ?? resolve(process.cwd(), 'thymus/campus/submitted')
const ROUNDS = Number(process.env.THYMUS_ROUNDS ?? '3')

/** SPEC.md 原文。它看得到的全部业务信息就是这个。 */
function readSpec(): string {
  const candidates = [
    new URL('./SPEC.md', import.meta.url).pathname,   // demo 目录里跟脚本放在一起
    resolve(OUT, '../SPEC.md'),                        // 仓库里的原件
    resolve(process.cwd(), 'thymus/campus/SPEC.md'),
  ]
  for (const p of candidates) {
    try { return readFileSync(p, 'utf8') } catch { /* 换下一个 */ }
  }
  throw new Error(`找不到 SPEC.md，试过：${candidates.join(' / ')}`)
}

/**
 * 内置类型的字段说明。照 `spec.ts` 的文档写，不掺人写那份声明里的具体选择
 * （不提该管哪个工具、该列哪些词）。这是一个客户读 README 也能拿到的信息量。
 */
const TYPES = `
可用的内置类型只有以下五种。写不出来的规矩不要硬套，也不要自己发明类型或写判定逻辑。

1. forbidden-phrases —— 字面禁语，逐字匹配。
   { name, type: "forbidden-phrases", phrases: string[], ignoreCase?: boolean }
   用于能精确列举的说法。

2. semantic-policy —— 语义策略，把条款原文交给模型判。
   { name, type: "semantic-policy", policy: string, provider, model }
   用于没有精确边界的规矩。policy 尽量照抄条款原文。

3. no-leak —— 内部字段不外泄，在工具产出交给模型之前把「字段名=值」抹掉。
   { name, type: "no-leak", tool: string, field: string, replacement?: string }

4. require-before —— 前置条件：requires 那个工具在本会话里成功调用过之后，
   才允许调用受管工具。**按白名单写**：unguarded 列不需要前置的工具，其余一律受管；
   requires 自己总是免管。
   { name, type: "require-before", requires: string, unguarded?: string[], reason?: string }

5. require-fallback —— 越界兜底：当用户问的事落在 outOfScope 描述的范围里，
   回复必须做到 fallback 描述的事，否则改说 reply。
   { name, type: "require-fallback", outOfScope: string, fallback: string, reply: string, provider, model }

每条声明都要自带验收用例 evals，三组：
  deny    必须被拦住的
  allow   必须原样放行的
  heldout 留出用例：语义同类、但字面上跟 deny 不重叠的说法
用例的形状随类型：
  forbidden-phrases / semantic-policy —— 字符串（一句话）
  no-leak —— 字符串（工具产出的原文）
  require-before —— { before: string[], call: string }，before 是本会话已成功调用过的工具
  require-fallback —— { ask: string, reply: string }

provider 一律写 "deepseek-official"，model 一律写 "deepseek-chat"。
`

const SYSTEM = `你把一份客服作业指导书里的规矩，写成一份「约束声明」——数据，不是代码。
${TYPES}
只输出一个 JSON 数组，不要解释，不要 markdown 代码块。`

/** 去掉可能的代码围栏再解析。 */
function parseSpecs(raw: string): ConstraintSpec[] {
  let s = raw.trim()
  if (s.startsWith('```')) s = s.replace(/^```[a-zA-Z]*\s*/, '').replace(/```\s*$/, '').trim()
  const parsed: unknown = JSON.parse(s)
  if (!Array.isArray(parsed)) throw new Error('返回的不是数组')
  return parsed as ConstraintSpec[]
}

async function boot(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(Timer)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(DeepSeek, {})
  return ctx
}

async function authorOnce(spec: string, round: number): Promise<ConstraintSpec[] | undefined> {
  const ctx = await boot()
  const options: GenerateOptions = {
    provider: 'deepseek-official', model: MODEL,
    system: SYSTEM,
    messages: [{
      role: 'user',
      content: [{ type: 'text', text: `作业指导书原文：\n\n${spec}` }],
      source: { kind: 'user' },
    }],
  } as GenerateOptions
  const t0 = Date.now()
  const raw = await judgeText(ctx, options)
  const ms = Date.now() - t0
  try {
    const specs = parseSpecs(raw)
    mkdirSync(OUT, { recursive: true })
    writeFileSync(resolve(OUT, `authored-spec-r${round}.json`), JSON.stringify(specs, null, 2), 'utf8')
    console.log(`  第 ${round} 轮：${specs.length} 条声明，${ms}ms`)
    for (const s of specs) {
      const e = (s as { evals?: Record<string, unknown[]> }).evals
      console.log(`    · ${s.name}（${s.type}）`
        + ` 用例 必拦 ${e?.deny?.length ?? 0} · 必放 ${e?.allow?.length ?? 0} · 留出 ${e?.heldout?.length ?? 0}`)
    }
    return specs
  } catch (e) {
    console.log(`  第 ${round} 轮：解析失败——${e instanceof Error ? e.message : String(e)}`)
    writeFileSync(resolve(OUT, `authored-spec-r${round}.raw.txt`), raw, 'utf8')
    return undefined
  }
}

async function main(): Promise<void> {
  if (!process.env.DEEPSEEK_API_KEY) throw new Error('缺少 DEEPSEEK_API_KEY')
  const spec = readSpec()
  console.log(`${'='.repeat(76)}\n让模型自己写声明（${ROUNDS} 轮，各自独立）\n${'='.repeat(76)}\n`)
  for (let i = 1; i <= ROUNDS; i++) {
    if (existsSync(resolve(OUT, `authored-spec-r${i}.json`)) && process.env.THYMUS_REUSE === '1') {
      console.log(`  第 ${i} 轮：已有产物，跳过`)
      continue
    }
    await authorOnce(spec, i)
  }
  console.log(`\n产物写在 ${OUT}/authored-spec-r*.json`)
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e: unknown) => { console.error('失败：', e instanceof Error ? e.message : e); process.exitCode = 1 })
}
