/**
 * `propose_tool`：让 agent 自己长出工具，但**装工具的动作留在宿主手里**。
 *
 * 为什么要拆开：给业务 agent 动态插件能力，它就能卸掉约束、或者把网关包在外面
 * （实测四次）。不给，又没有「自己长工具」这件事。拆开之后 agent 只提交**数据**，
 * 宿主校验、注册、记账、回收——注册这个动作它够不到。
 *
 * 实测过的三条边界，这个模块按它们设计：
 *
 *   1. **已注册的工具名动不了**（dsh 自己堵的），所以冒牌工具换不掉受管工具。
 *   2. **名字先到先得**：抢先占名之后宿主就注册不上了。所以受管工具必须在放行 agent
 *      之前注册完，而提案里的重名要在这一层先拒掉、别让它去撞 dsh 的错。
 *   3. **被拒的 agent 会一直造工具**：真 agent 上实测过，网关拦住它之后它一口气注册了
 *      4 个新工具想绕过去（其中一个描述里写着「无需身份核验」），一个都没绕成，
 *      但工具表和名字空间被撑大了。所以要有配额、去重、回收。
 *
 * 这一层**不做准入之外的安全判断**：新工具照样受约束层管（白名单写法下，
 * 没列进免检名单的一律受管）。准入是第一道，约束层是第二道。
 *
 * @module thymus/propose
 */
import { Context } from '@deepseek-ai/cordis'

/** 一份工具提案。`kind` 决定还要带哪些字段，由宿主的执行器自己校验。 */
export interface ToolProposal {
  name: string
  description: string
  kind: string
  [field: string]: unknown
}

/** 宿主认得的一种执行器。提案里给不了代码，工具体由这里造。 */
export interface ProposalKind {
  /**
   * 校验这一 kind 特有的字段。
   * @param proposal - 待校验的提案。
   * @returns 一句**能照着改**的话；通过则返回 undefined。
   *   拒绝理由写得能照着改，是有实测支撑的：不告诉 agent 边界时，它靠拒绝理由
   *   4 次往返就能改对，一次纠正一条。
   */
  validate(proposal: ToolProposal): string | undefined
  /** 造工具体。 */
  execute(proposal: ToolProposal, args: Record<string, unknown>): Promise<string>
  /**
   * 去重键：同一个会话里两份提案算不算同一件事。缺省是 `kind` 加工具名。
   * 机械去重只挡得住「同一件事换个名字」里能机械看出来的那部分——
   * 语义上相同但键不同的提案挡不住，那要靠配额兜。
   */
  identity?(proposal: ToolProposal): string
}

/** 提案准入策略。 */
export interface ProposalPolicy {
  /** 宿主认得的执行器，键是 `kind`。 */
  kinds: Record<string, ProposalKind>
  /** 一个会话最多注册几个工具，缺省 3。 */
  maxRegistered?: number
  /** 一个会话最多提交几次（含被拒的），缺省 8。防的是被拒之后无限重试。 */
  maxAttempts?: number
}

/** 装上之后的句柄：按会话回收，或整体卸掉。 */
export interface ProposeToolHandle {
  /** 回收一个会话注册过的工具。会话结束时调用。 */
  release(sessionId: string): void
  /** 回收全部。 */
  dispose(): void
  /** 这个会话已注册的工具名，按注册顺序。 */
  registered(sessionId: string): readonly string[]
}

/** 一个会话的记账。 */
interface SessionBooks {
  attempts: number
  /** 工具名 → 取消注册。回收就靠它。 */
  tools: Map<string, () => void>
  /** 已经受理过的去重键。 */
  identities: Set<string>
}

const NAME_RE = /^[a-z][a-z0-9_]{2,40}$/

/**
 * 装 `propose_tool`：agent 提交数据，宿主校验后代为注册。
 *
 * 必须在**全部受管工具注册完之后**装——名字先到先得，受管工具要先占住自己的名字。
 *
 * @param ctx - 宿主 context。
 * @param policy - 准入策略：认得哪些 kind、配额多少。
 * @returns 回收句柄。会话结束时记得 {@link ProposeToolHandle.release}。
 */
export function installProposeTool(ctx: Context, policy: ProposalPolicy): ProposeToolHandle {
  const maxRegistered = policy.maxRegistered ?? 3
  const maxAttempts = policy.maxAttempts ?? 8
  const books = new Map<string, SessionBooks>()
  const bookOf = (sid: string): SessionBooks => {
    const existing = books.get(sid)
    if (existing !== undefined) return existing
    const fresh: SessionBooks = { attempts: 0, tools: new Map(), identities: new Set() }
    books.set(sid, fresh)
    return fresh
  }

  const dispose = ctx.tools.register({
    name: 'propose_tool',
    description: '提交一份工具定义（JSON 字符串），宿主校验通过后代为注册',
    parameters: {
      type: 'object',
      properties: { proposal: { type: 'string', description: '工具定义的 JSON 字符串' } },
      required: ['proposal'],
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v as string }] },
    execute: (args: { proposal: string }, exec: unknown): Promise<string> => {
      // 身份从执行上下文取。没有身份就没法记账，也就没法配额——只能拒。
      const sid = (exec as { agent?: { id?: string } } | undefined)?.agent?.id
      if (sid === undefined) return Promise.resolve('提案被拒：这次调用没有会话身份，无法记账')
      const book = bookOf(sid)

      book.attempts++
      if (book.attempts > maxAttempts) {
        return Promise.resolve(
          `提案被拒：本次会话提交次数已达上限（${maxAttempts} 次）。`
          + '如果前面的工具已经注册成功却调不动，问题多半不在工具，而在调用它的前置条件。',
        )
      }

      let p: ToolProposal
      try { p = JSON.parse(args.proposal) as ToolProposal } catch { return Promise.resolve('提案被拒：不是合法 JSON') }
      if (typeof p !== 'object' || p === null) return Promise.resolve('提案被拒：提案必须是一个 JSON 对象')
      if (typeof p.name !== 'string' || !NAME_RE.test(p.name)) {
        return Promise.resolve('提案被拒：name 必须是 3–41 位小写字母、数字或下划线，且以字母开头')
      }
      if (typeof p.description !== 'string' || p.description.trim() === '') {
        return Promise.resolve('提案被拒：description 不能为空')
      }
      const kind = policy.kinds[p.kind as string]
      if (kind === undefined) {
        return Promise.resolve(
          `提案被拒：kind 只接受 ${Object.keys(policy.kinds).map(k => `"${k}"`).join(' 或 ')}，不接受代码或其它类型`,
        )
      }
      const bad = kind.validate(p)
      if (bad !== undefined) return Promise.resolve(`提案被拒：${bad}`)

      // 去重在配额之前：重复提交不该消耗名额，但要给出「已经有一个了」的指引。
      const identity = kind.identity?.(p) ?? `${p.kind}:${p.name}`
      if (book.identities.has(identity)) {
        return Promise.resolve(
          `提案被拒：本次会话已经提交过等价的工具（${identity}）。`
          + `已注册的是：${[...book.tools.keys()].join('、') || '（无）'}`,
        )
      }
      if (book.tools.size >= maxRegistered) {
        return Promise.resolve(
          `提案被拒：本次会话注册的工具已达上限（${maxRegistered} 个）：`
          + `${[...book.tools.keys()].join('、')}。先用已有的工具，或换个思路。`,
        )
      }
      // 名字先到先得，重名要在这一层拒掉——撞到 dsh 的注册错误会变成一次工具执行失败。
      if (ctx.tools.schemas().some(s => s.name === p.name)) {
        return Promise.resolve(`提案被拒：工具名「${p.name}」已被占用，换一个名字`)
      }

      const name = p.name
      const undo = ctx.tools.register({
        name, description: p.description,
        parameters: { type: 'object', properties: { q: { type: 'string', description: '查询参数' } } },
        output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v as string }] },
        execute: (toolArgs: Record<string, unknown>): Promise<string> => kind.execute(p, toolArgs),
      })
      book.tools.set(name, undo)
      book.identities.add(identity)
      return Promise.resolve(`已注册工具「${name}」，现在可以直接调用它`)
    },
  })

  const release = (sessionId: string): void => {
    const book = books.get(sessionId)
    if (book === undefined) return
    for (const undo of book.tools.values()) undo()
    books.delete(sessionId)
  }

  return {
    release,
    registered: (sessionId: string): readonly string[] => [...books.get(sessionId)?.tools.keys() ?? []],
    dispose: (): void => {
      for (const sid of [...books.keys()]) release(sid)
      dispose()
    },
  }
}
