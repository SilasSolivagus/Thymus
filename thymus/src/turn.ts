/**
 * 取一轮对话的结束原因。
 *
 * 实跑脚本里的 say() 只等 whenIdle()，不看这一轮是怎么结束的。模型侧传输失败时
 * 那一轮什么都没做，脚本照常往下走——campus 主线三轮反馈有两轮是这样空转的，
 * 控制台零输出，结果被记成「模型三轮没修好」（thymus/campus/FINDINGS-03 二）。
 * 测量本身不可信，后续所有「几轮收敛」的结论都建在它上面。
 *
 * @module thymus/turn
 */
import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** 一轮的结束情况：正常结束，或没正常结束并附可读原因。 */
export type TurnOutcome = { ok: true } | { ok: false; reason: string }

interface TurnEndData {
  reason: { kind: string; error?: { code?: string; message?: string } }
}

/**
 * 从会话事件里取最后一个 turn/end 的结束原因。
 * @param events - 会话事件序列（agent.session.events）。
 * @returns 最后一轮是否正常结束；没有 turn/end 也算没正常结束。
 */
export function lastTurnOutcome(events: readonly SessionEvent[]): TurnOutcome {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!
    if (e.type !== 'turn/end') continue
    const { reason } = e.data as TurnEndData
    if (reason.kind === 'completed') return { ok: true }
    if (reason.kind === 'error') {
      const { code = 'UNKNOWN', message = '' } = reason.error ?? {}
      return { ok: false, reason: `turn 以错误结束：${code} ${message}`.trimEnd() }
    }
    return { ok: false, reason: `turn 以 ${reason.kind} 结束` }
  }
  return { ok: false, reason: '会话里没有 turn/end：这一轮没有跑起来' }
}
