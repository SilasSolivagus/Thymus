/**
 * turn 结束原因的鉴别力测试。
 *
 * 实跑里 say() 只等 whenIdle()，不看这一轮是怎么结束的：模型侧传输失败时
 * 那一轮什么都没做，脚本照常往下走，把「空转」记成了「模型没修好」
 * （见 thymus/campus/FINDINGS-03 二）。这里验的是失败不再被吞。
 * 不花模型。
 */
import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { lastTurnOutcome } from './thymus-src/turn.ts'

const ev = (type: string, data: unknown): SessionEvent =>
  ({ type, data } as unknown as SessionEvent)

const turnEnd = (reason: unknown): SessionEvent => ev('turn/end', { turn: 1, reason })

describe('lastTurnOutcome', () => {
  it('正常结束的一轮判为 ok', () => {
    const events = [ev('turn/start', { turn: 1 }), turnEnd({ kind: 'completed' })]
    expect(lastTurnOutcome(events)).toEqual({ ok: true })
  })

  it('传输失败的一轮判为不 ok，并带出错误信息', () => {
    const events = [turnEnd({ kind: 'error', error: { code: 'TRANSPORT', message: 'stream closed' } })]
    const out = lastTurnOutcome(events)
    expect(out.ok).toBe(false)
    expect(out.ok === false && out.reason).toContain('TRANSPORT')
    expect(out.ok === false && out.reason).toContain('stream closed')
  })

  it('只看最后一个 turn/end：先失败后成功判为 ok', () => {
    const events = [
      turnEnd({ kind: 'error', error: { code: 'TRANSPORT', message: '断了' } }),
      turnEnd({ kind: 'completed' }),
    ]
    expect(lastTurnOutcome(events)).toEqual({ ok: true })
  })

  it('会话里没有 turn/end 判为不 ok', () => {
    expect(lastTurnOutcome([ev('user/message', {})]).ok).toBe(false)
  })

  it('completed 之外的其他结束原因判为不 ok', () => {
    const out = lastTurnOutcome([turnEnd({ kind: 'max-tokens' })])
    expect(out.ok).toBe(false)
    expect(out.ok === false && out.reason).toContain('max-tokens')
  })
})
