/**
 * Thymus 的轨迹证据投影。
 *
 * 注册进 dsh 的 session-projection 座（「领域注册纯数学，框架负责驱动」），
 * 在每条已提交的会话事件上折叠出评价体系要用的数字。
 *
 * 字段对应 DESIGN.md 5.3 的信号表：
 *   steps / toolCalls  → 信号 3（步数节省），消融时两边相减
 *   deadCalls          → 信号 2（必经性）：结果没被后续步骤消费的调用 = 空转
 *   turns              → 归一化的分母，按 spec 比较时用
 *
 * @module thymus/trajectory
 */
import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** 一条轨迹折叠出来的证据。 */
export interface TrajectoryEvidence {
  /** 至少含一个已闭合步骤的轮次数。 */
  turns: number
  /** `step/end` 计数——完成、失败、取消、超长都算。 */
  steps: number
  /** `tool/call` 计数。 */
  toolCalls: number
  /** 结果直到本轮结束都没被后续步骤消费的调用数。空转。 */
  deadCalls: number
}

interface State extends TrajectoryEvidence {
  /** 本轮内已产生、尚未被任何后续步骤消费的结果数。 */
  pending: number
  /** 本轮内已闭合的步骤数，用来决定这一轮算不算数。 */
  stepsThisTurn: number
}

const INITIAL: State = { turns: 0, steps: 0, toolCalls: 0, deadCalls: 0, pending: 0, stepsThisTurn: 0 }

/** @returns 空日志的初始状态。 */
export function init(): State {
  return INITIAL
}

/**
 * 纯折叠：前一状态 + 一条已提交事件 → 下一状态。
 *
 * 不关心的事件必须原样返回同一个引用——投影座靠 `Object.is` 判断有没有变，
 * 返回新对象会白白触发下游工作。
 *
 * @param state - 覆盖此前所有事件的状态。
 * @param event - 下一条已提交的会话事件。
 * @returns 下一状态；事件与本单元无关时返回同一引用。
 */
export function apply(state: State, event: SessionEvent): State {
  switch (event.type) {
    case 'turn/start':
      // 新一轮开始，轮内计数归零。上一轮的悬空结果已在 turn/end 结清。
      return { ...state, pending: 0, stepsThisTurn: 0 }

    case 'step/start':
      // 一个新步骤开始，意味着它读到了此前所有的工具结果——它们不是空转。
      return state.pending === 0 ? state : { ...state, pending: 0 }

    case 'step/end':
      return { ...state, steps: state.steps + 1, stepsThisTurn: state.stepsThisTurn + 1 }

    case 'tool/call':
      return { ...state, toolCalls: state.toolCalls + 1 }

    case 'tool/result':
      return { ...state, pending: state.pending + 1 }

    case 'turn/end':
      // 收尾：本轮还悬着的结果没人消费，记为空转。
      // 空轮（一个闭合步骤都没有）不计入 turns，与 session-stats 的口径一致。
      return {
        ...state,
        turns: state.stepsThisTurn > 0 ? state.turns + 1 : state.turns,
        deadCalls: state.deadCalls + state.pending,
        pending: 0,
        stepsThisTurn: 0,
      }

    default:
      return state
  }
}

/**
 * 状态 → 对外读值。
 * @param state - 当前状态。
 * @returns 这条轨迹的证据。
 */
export function view(state: State): TrajectoryEvidence {
  return { turns: state.turns, steps: state.steps, toolCalls: state.toolCalls, deadCalls: state.deadCalls }
}

/**
 * 两条轨迹证据相减——消融验证的算法核心。
 *
 * @param withOrgan - 挂着器官时的证据。
 * @param without - 卸掉器官时的证据。
 * @returns 各项差值；负值表示器官让该项变小（步数、空转变小是好事）。
 */
export function contribution(withOrgan: TrajectoryEvidence, without: TrajectoryEvidence): TrajectoryEvidence {
  return {
    turns: withOrgan.turns - without.turns,
    steps: withOrgan.steps - without.steps,
    toolCalls: withOrgan.toolCalls - without.toolCalls,
    deadCalls: withOrgan.deadCalls - without.deadCalls,
  }
}
