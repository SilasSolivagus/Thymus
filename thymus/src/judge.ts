/**
 * 独立判定器：把开发方提交的插件源码，在全新 context 里挂载，
 * 逐条重放冻结的评测用例。固定代码，不含任何模型。
 *
 * 只返回可观测差异（期望允许/拒绝 vs 实际允许/拒绝），不泄露判定逻辑——
 * 这是反馈给开发 agent 时保持独立性的关键。
 *
 * @module thymus/judge
 */
import { Context } from '@deepseek-ai/cordis'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import DynamicCordisRunner from '@deepseek-ai/dsh-cordis-host-runner'

/** 一条冻结的评测用例：对某文件的删除请求是否应被允许。 */
export interface EvalCase {
  file: string
  shouldAllowDelete: boolean
  reason?: string
}

/** 判定结果：是否通过，以及可观测差异。 */
export interface JudgeResult {
  passed: boolean
  diffs: string[]
}

/**
 * 在独立 context 挂载候选插件，重放评测用例。
 * @param source - 开发方提交的宿主半插件源码。
 * @param cases - 冻结的评测用例。
 * @returns 判定结果，diffs 仅含可观测差异。
 */
export async function judge(source: string, cases: readonly EvalCase[]): Promise<JudgeResult> {
  const ctx = new Context()
  await ctx.plugin(Timer)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(DynamicCordisRunner, {})

  const delFile: ToolDefinition = {
    name: 'delete_file',
    description: '删除一个文件。',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v as string }] },
    execute: (a: { path: string }): Promise<string> => Promise.resolve(`deleted:${a.path}`),
  }
  ctx.tools.register(delFile)
  const agent = { id: 'judge' } as never

  try {
    const { pluginId, packageId } = ctx.dynamicCordisRunner.define({
      sessionId: 'judge' as never,
      plugin: { kind: 'new', idPrefix: 'cand' },
      name: 'candidate', purpose: 'eval candidate',
      code: { host: source },
    })
    const receipt = await ctx.dynamicCordisRunner.run(agent, pluginId, packageId, 'run')
    if (!receipt.ok) return { passed: false, diffs: [`插件无法挂载：${receipt.message}`] }
  } catch (e) {
    return { passed: false, diffs: [`插件无法挂载：${e instanceof Error ? e.message.split('\n')[0] : String(e)}`] }
  }

  const diffs: string[] = []
  let n = 0
  for (const c of cases) {
    const res = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId(`judge-${++n}`),
      name: 'delete_file',
      arguments: { path: c.file },
      agent,
    })
    const first = res.content[0]
    const allowed = (first?.type === 'text' ? first.text : '').startsWith('deleted:')
    if (allowed !== c.shouldAllowDelete) {
      diffs.push(`文件 ${c.file}：期望${c.shouldAllowDelete ? '允许删除' : '拒绝删除'}，`
        + `实际${allowed ? '允许了' : '拒绝了'}`)
    }
  }
  return { passed: diffs.length === 0, diffs }
}
