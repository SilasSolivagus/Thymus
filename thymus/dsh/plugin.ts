/**
 * 把 Thymus 挂进真 dsh：一个 cordis 插件，`dsh web --patch` 能直接 insert 它。
 *
 * 在这之前所有验证都跑在自己搭的 Context 里（campus 脚本、evals 框架）。那证明得了
 * 机制，证明不了「在真部署里挂得上、拦得住」。这个文件补的就是那一段。
 *
 * 挂两条通道，用的是 campus 那份真声明（`spec-declarations.ts`），不为演示改一个字：
 *   工具通道 —— `installToolGate`，拒绝与产出抹除
 *   说话通道 —— `installSayGate`，替代话术会再过一遍闸（发现 31）
 *
 * 顺带把 SOP 里那四个工具注册上，否则声明里的 B 类无从谈起。
 *
 * 路径写法照 campus 脚本的老规矩：`../src/*` 指的是拷进 dsh workspace 之后那份合并目录
 * （`packages/thymus/src` 与 `thymus/src` 并进同一个 `src/`），在仓库里直接看是解析不了的。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { installSayGate, installToolGate, type Constraint } from '../src/gate.ts'
import { compileConstraints } from '../src/spec.ts'
import { DECLARATIONS } from '../campus/spec-declarations.ts'

export const name = 'thymus'
export const inject = ['llm', 'tools']

/** 本轮网关做过什么。给观察界面用的旁路记录，不参与裁决。 */
export interface ThymusEvent {
  kind: '说话被拦' | '工具被拦' | '产出被改写'
  who: string
  detail: string
}

/** 挂在 ctx 上的旁路记录本：界面插件按轮取走。 */
export interface ThymusTrace {
  events: ThymusEvent[]
  reset(): void
}

/** 网关兜底串。终点串，必须在所有语境下干净——冻结闸盯着这一条（发现 31 四）。 */
const GATEWAY_REPLY = '抱歉，这个问题超出我这边能处理的范围，我帮您转相关部门跟进。'

const T = (name: string, props: Record<string, unknown>, ret: string): ToolDefinition => ({
  name, description: name,
  parameters: { type: 'object', properties: props },
  output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v as string }] },
  execute: (): Promise<string> => Promise.resolve(ret),
})

function campusTools(): ToolDefinition[] {
  return [
    {
      name: 'lookup_account', description: '按学号+手机号核验用户身份',
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

/** 约束外面包一层，把发生的事记进旁路本子。不改约束本身，也不影响判决。 */
function instrument(constraints: readonly Constraint[], trace: ThymusTrace): Constraint[] {
  return constraints.map(c => ({
    ...c,
    ...c.say === undefined ? {} : {
      say: async (text: string, channel: 'text' | 'reasoning', context?: never) => {
        const v = await c.say!(text, channel, context)
        if (channel === 'text' && v.kind === 'deny') {
          trace.events.push({ kind: '说话被拦', who: c.name, detail: `原话「${text.slice(0, 60)}」／${v.reason}` })
        }
        return v
      },
    },
    ...c.preTool === undefined ? {} : {
      preTool: async (call: Parameters<NonNullable<Constraint['preTool']>>[0]) => {
        const v = await c.preTool!(call)
        if (v.kind === 'deny') trace.events.push({ kind: '工具被拦', who: c.name, detail: `${call.name}／${v.reason}` })
        return v
      },
    },
    ...c.postTool === undefined ? {} : {
      postTool: async (call: Parameters<NonNullable<Constraint['postTool']>>[0], text: string) => {
        const out = await c.postTool!(call, text)
        if (typeof out === 'string' && out !== text) {
          trace.events.push({ kind: '产出被改写', who: c.name, detail: `${call.name}：「${text.slice(0, 50)}」→「${out.slice(0, 50)}」` })
        }
        return out
      },
    },
  }))
}

export function apply(ctx: Context): void {
  for (const tool of campusTools()) ctx.tools.register(tool)
  const trace: ThymusTrace = { events: [], reset(): void { this.events = [] } }
  const guarded = instrument(compileConstraints(ctx, DECLARATIONS), trace)
  installToolGate(ctx, guarded)
  installSayGate(ctx, guarded, GATEWAY_REPLY)
  // 旁路本子挂到 ctx 上：观察界面是另一个插件，只有这样拿得到。治理本身不读它。
  const provide = ctx as unknown as { provide(name: string, value?: unknown): void; thymusTrace?: ThymusTrace }
  provide.provide('thymusTrace')
  provide.thymusTrace = trace
  console.log(`[thymus] 已挂载 ${guarded.length} 条约束：${DECLARATIONS.map(s => s.name).join('、')}`)
}
