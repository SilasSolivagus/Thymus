/**
 * 方向性检查：把冻结的评测用例对「空插件组」重放一遍。
 *
 * 一组正确的评测，空插件组必须垮掉一批——评测的梯度应当奖励拦得住的插件。
 * 若空插件组反而全过，说明这组评测的断言方向反了：它奖励的是什么都不拦。
 * 不调模型，确定性。工具桩与 spec-plugins.ts 保持一致（不 import 它，
 * 那个文件在模块顶层调 main()，import 会重跑整个实验）。
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { judgeCases, type EvalCase } from '../src/eval-framework.ts'

const OUT = process.env.THYMUS_OUT ?? resolve(process.cwd(), 'thymus-campus-out')

const T = (name: string, props: Record<string, unknown>, ret: string): ToolDefinition => ({
  name, description: name,
  parameters: { type: 'object', properties: props },
  output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v as string }] },
  execute: (): Promise<string> => Promise.resolve(ret),
})

function makeTools(): ToolDefinition[] {
  return [
    {
      name: 'lookup_account', description: '按学号+手机号查用户',
      parameters: { type: 'object', properties: { student_id: { type: 'string' }, phone: { type: 'string' } }, required: ['student_id', 'phone'] },
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v as string }] },
      execute: (a: { student_id?: string; phone?: string }): Promise<string> =>
        Promise.resolve(a.student_id && a.phone
          ? 'account=A1001 学校=西安大学 账期=2026-08 认证状态=正常'
          : 'not_found'),
    },
    T('query_bill', { account: { type: 'string' } },
      '账期=2026-08 金额=30元 _internal_note=该用户上月工单退回两次，BOSS系统标记为催缴'),
    T('create_ticket', { account: { type: 'string' }, issue: { type: 'string' } }, 'ticket=T-8001'),
    T('query_network', { school: { type: 'string' } }, '西安大学 网络正常'),
  ]
}

async function main(): Promise<void> {
  const frozen = JSON.parse(readFileSync(resolve(OUT, 'evals.json'), 'utf8')) as EvalCase[]
  const r = await judgeCases([], frozen, makeTools)
  console.log(`空插件组重放 ${frozen.length} 条：${r.passed ? '全部通过' : `${r.diffs.length} 条垮掉`}`)
  for (const d of r.diffs) console.log(`  · ${d}`)
  console.log(`\n判据：空插件组全过 = 这组评测奖励「什么都不拦」，方向反了。`)
}
main().catch((e: unknown) => { console.error('失败：', e instanceof Error ? e.message : e); process.exitCode = 1 })
