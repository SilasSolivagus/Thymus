/**
 * 通用评测框架：把一份 spec 的评测用例，在独立 context 里对候选插件重放。
 *
 * 用同一套结构表达三档递增的约束：
 *   无状态   —— 单次调用，看参数决定放行/拒绝（assert: allowed / denied）
 *   有状态   —— 决策依赖历史，用调用序列表达（steps 多步，assert 判最后一步）
 *   看产出   —— 不是放行/拒绝，而是产出须满足谓词（assert: output-includes / output-excludes）
 *
 * 判定器是固定代码，不含任何模型；每条用例在全新 context 独立重放，
 * 状态不跨用例泄漏。只返回可观测差异。
 *
 * @module thymus/eval-framework
 */
import { Context } from '@deepseek-ai/cordis'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import DynamicCordisRunner from '@deepseek-ai/dsh-cordis-host-runner'

/** 一步工具调用。 */
export interface EvalStep {
  tool: string
  args: Record<string, unknown>
  /**
   * 可选桩返回值：本步该工具应返回的文本。用于「看产出」类评测——
   * 让出题方掌控工具返回的内容，而不是依赖环境写死的固定值。
   * 声明后，判定器用它覆盖该工具本次的产出（在插件的 post-execute 之前）。
   */
  stubReturn?: string
}

/** 对最后一步可观测结果的断言。 */
export interface EvalAssert {
  /**
   * allowed         —— 调用被放行（正常返回）
   * denied          —— 调用被拒绝（返回错误）
   * output-includes —— 调用正常返回，且产出文本包含 value
   * output-excludes —— 调用正常返回，且产出文本不包含 value
   */
  kind: 'allowed' | 'denied' | 'output-includes' | 'output-excludes'
  value?: string
}

/** 一条评测用例：一段调用序列 + 对最后一步的断言。 */
export interface EvalCase {
  description: string
  steps: EvalStep[]
  assert: EvalAssert
}

/** 判定结果。 */
export interface JudgeResult {
  passed: boolean
  diffs: string[]
}

interface CaseOutcome {
  error?: string
  lastText: string
  lastIsError: boolean
}

/** 在全新 context 挂载一组候选插件，按序执行一条用例的所有步骤，返回最后一步的可观测结果。 */
async function runCase(sources: readonly string[], c: EvalCase, makeTools: () => ToolDefinition[]): Promise<CaseOutcome> {
  const ctx = new Context()
  await ctx.plugin(Timer)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(DynamicCordisRunner, {})
  const agent = { id: 'judge' } as never
  // 收集本用例各步声明的桩返回值：工具名 → 返回文本。
  const stubs = new Map<string, string>()
  for (const step of c.steps) if (step.stubReturn !== undefined) stubs.set(step.tool, step.stubReturn)
  for (const tool of makeTools()) {
    if (stubs.has(tool.name)) {
      const ret = stubs.get(tool.name)!
      ctx.tools.register({ ...tool, execute: (): Promise<string> => Promise.resolve(ret) })
    } else {
      ctx.tools.register(tool)
    }
  }

  // 组内每个插件独立 define + run，全部挂进同一运行时——真实部署的形态。
  for (let i = 0; i < sources.length; i++) {
    try {
      const { pluginId, packageId } = ctx.dynamicCordisRunner.define({
        sessionId: 'judge' as never,
        plugin: { kind: 'new', idPrefix: 'cand' },
        name: `candidate-${i}`, purpose: 'eval candidate',
        code: { host: sources[i]! },
      })
      const receipt = await ctx.dynamicCordisRunner.run(agent, pluginId, packageId, 'run')
      if (!receipt.ok) return { error: `插件[${i}]无法挂载：${receipt.message}`, lastText: '', lastIsError: true }
    } catch (e) {
      return { error: `插件[${i}]无法挂载：${e instanceof Error ? e.message.split('\n')[0] : String(e)}`, lastText: '', lastIsError: true }
    }
  }

  let lastText = ''
  let lastIsError = false
  let n = 0
  for (const step of c.steps) {
    const res = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId(`judge-${++n}`),
      name: step.tool,
      arguments: step.args,
      agent,
    })
    const first = res.content[0]
    lastText = first?.type === 'text' ? first.text : ''
    lastIsError = res.isError
  }
  return { lastText, lastIsError }
}

/** 检查一条用例的断言，返回可观测差异（通过则返回 undefined）。 */
function checkAssert(c: EvalCase, o: CaseOutcome): string | undefined {
  const { kind, value } = c.assert
  switch (kind) {
    case 'allowed':
      return o.lastIsError ? '期望放行，实际被拒绝' : undefined
    case 'denied':
      return o.lastIsError ? undefined : '期望拒绝，实际放行了'
    case 'output-includes':
      if (o.lastIsError) return '期望正常返回，实际被拒绝'
      return o.lastText.includes(value ?? '') ? undefined : `产出应包含「${value}」，实际未包含`
    case 'output-excludes':
      if (o.lastIsError) return '期望正常返回，实际被拒绝'
      return o.lastText.includes(value ?? '') ? `产出不应包含「${value}」，实际包含了` : undefined
  }
}

/**
 * 对候选插件重放整组评测用例。
 * @param source - 开发方提交的宿主半插件源码，单个或一组（一组则全部挂进同一运行时）。
 * @param cases - 冻结的评测用例。
 * @param makeTools - 该 spec 的环境工具集（每条用例重新构造，避免状态跨例泄漏）。
 * @returns 判定结果，diffs 仅含可观测差异。
 */
export async function judgeCases(
  source: string | readonly string[],
  cases: readonly EvalCase[],
  makeTools: () => ToolDefinition[],
): Promise<JudgeResult> {
  const sources = typeof source === 'string' ? [source] : source
  const diffs: string[] = []
  for (const c of cases) {
    const outcome = await runCase(sources, c, makeTools)
    if (outcome.error !== undefined) { diffs.push(`用例「${c.description}」：${outcome.error}`); continue }
    const diff = checkAssert(c, outcome)
    if (diff !== undefined) diffs.push(`用例「${c.description}」：${diff}`)
  }
  return { passed: diffs.length === 0, diffs }
}
