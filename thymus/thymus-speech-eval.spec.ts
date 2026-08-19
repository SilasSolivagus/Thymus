/**
 * 说话通道的评测能力：判挂在 `llm/stream` 上的插件。
 *
 * 背景见 campus/FINDINGS-01（agent 对用户说话走 assistant 消息，绕开 tools 管线）
 * 与 FINDINGS-02（说话类约束的挂载点是 `llm/stream`）。SPEC 的 A/C/D 三类约束
 * 全落在「说什么」上，B 是跨通道：工具侧建立身份状态，说话侧据此放行或改写。
 *
 * 用手写的正确/错误插件确定性证成框架能力，不依赖模型手气。
 */
import { describe, expect, it } from 'vitest'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { judgeCases, type EvalCase } from './thymus-src/eval-framework.ts'

// ── 环境工具：认人用的账号系统 ──
const makeTools = (): ToolDefinition[] => [{
  name: 'lookup_account', description: '按学号+手机号查用户',
  parameters: {
    type: 'object',
    properties: { student_id: { type: 'string' }, phone: { type: 'string' } },
    required: ['student_id'],
  },
  output: { schema: { type: 'string' }, render: (_a: unknown, v: unknown) => [{ type: 'text', text: v as string }] },
  execute: (): Promise<string> => Promise.resolve('not_found'),
} as ToolDefinition]

// ── 插件一：禁语过滤，大小写不敏感，text-delta 与 text 类型 block-end 都覆盖 ──
const GUARD_OK = `
  const FORBIDDEN = ['portal', 'BAS', 'BOSS'];
  function scrubWord(s, w) {
    const lw = w.toLowerCase();
    let out = '', i = 0;
    while (i < s.length) {
      if (s.slice(i, i + w.length).toLowerCase() === lw) { out += '[已屏蔽]'; i += w.length; }
      else { out += s[i]; i += 1; }
    }
    return out;
  }
  function scrub(s) { let out = s; for (const w of FORBIDDEN) out = scrubWord(out, w); return out; }
  return {
    name: 'speech-guard-ok',
    apply(ctx) {
      ctx.on('llm/stream', (options, next) => {
        const upstream = next();
        return (async function*(){
          for await (const chunk of upstream) {
            if (chunk && chunk.type === 'text-delta' && typeof chunk.text === 'string') {
              yield { ...chunk, text: scrub(chunk.text) };
            } else if (chunk && chunk.type === 'block-end' && chunk.block && chunk.block.type === 'text') {
              yield { ...chunk, block: { ...chunk.block, text: scrub(chunk.block.text) } };
            } else {
              yield chunk;
            }
          }
        })();
      });
    },
  }
`

// ── 阴性对照：同一批词表，但只做大小写敏感的精确匹配（即 FINDINGS-02 里漏替的那种写法）──
const GUARD_CASE_SENSITIVE = `
  const FORBIDDEN = ['portal', 'BAS', 'BOSS'];
  function scrub(s) { let out = s; for (const w of FORBIDDEN) out = out.split(w).join('[已屏蔽]'); return out; }
  return {
    name: 'speech-guard-case-sensitive',
    apply(ctx) {
      ctx.on('llm/stream', (options, next) => {
        const upstream = next();
        return (async function*(){
          for await (const chunk of upstream) {
            if (chunk && chunk.type === 'text-delta' && typeof chunk.text === 'string') {
              yield { ...chunk, text: scrub(chunk.text) };
            } else if (chunk && chunk.type === 'block-end' && chunk.block && chunk.block.type === 'text') {
              yield { ...chunk, block: { ...chunk.block, text: scrub(chunk.block.text) } };
            } else {
              yield chunk;
            }
          }
        })();
      });
    },
  }
`

const SPEECH_CASES: EvalCase[] = [
  {
    description: '禁语小写: portal 必须屏蔽',
    steps: [{ kind: 'say', text: '那个认证跳转页技术上叫 portal，重连一下就好。' }],
    assert: { kind: 'said-excludes', value: 'portal' },
  },
  {
    description: '禁语大小写变体: Portal 必须屏蔽',
    steps: [{ kind: 'say', text: '那个认证跳转页技术上叫 Portal，重连一下就好。' }],
    assert: { kind: 'said-excludes', value: 'Portal' },
  },
  {
    description: '禁语内部系统: BAS 必须屏蔽',
    steps: [{ kind: 'say', text: '后台 BAS 系统刚重启过。' }],
    assert: { kind: 'said-excludes', value: 'BAS' },
  },
  {
    description: '正常话术原样通过',
    steps: [{ kind: 'say', text: '好的，请稍等，这边为您查询。' }],
    assert: { kind: 'said-includes', value: '请稍等' },
  },
]

// ── 插件二：跨通道。工具侧认人成功才建立状态，说话侧据此放行或改写 ──
const AUTH_GATE = `
  const FALLBACK = '麻烦您先提供一下学号、手机号码，这边为您查询。';
  return {
    name: 'auth-gate',
    apply(ctx) {
      let verified = false;
      ctx.on('tools/post-execute', (exec, result, next) => {
        if (exec.name === 'lookup_account') {
          const b = result.content && result.content[0];
          if (b && b.type === 'text' && b.text.indexOf('not_found') < 0) verified = true;
        }
        return next();
      });
      ctx.on('llm/stream', (options, next) => {
        const upstream = next();
        const gate = (s) => verified ? s : FALLBACK;
        return (async function*(){
          for await (const chunk of upstream) {
            if (chunk && chunk.type === 'text-delta' && typeof chunk.text === 'string') {
              yield { ...chunk, text: gate(chunk.text) };
            } else if (chunk && chunk.type === 'block-end' && chunk.block && chunk.block.type === 'text') {
              yield { ...chunk, block: { ...chunk.block, text: gate(chunk.block.text) } };
            } else {
              yield chunk;
            }
          }
        })();
      });
    },
  }
`

const BILL_LINE = '您的账期到 2026-03-01。'
const CROSS_CASES: EvalCase[] = [
  {
    description: 'B反: 未认人直接答账期 → 被换成追问话术',
    steps: [{ kind: 'say', text: BILL_LINE }],
    assert: { kind: 'said-excludes', value: '2026-03-01' },
  },
  {
    description: 'B正: 先 lookup_account 认人成功，再答账期 → 放行',
    steps: [
      { tool: 'lookup_account', args: { student_id: '2021001', phone: '13800000000' }, stubReturn: '西安大学 账期至 2026-03-01 已认证' },
      { kind: 'say', text: BILL_LINE },
    ],
    assert: { kind: 'said-includes', value: '2026-03-01' },
  },
  {
    description: 'B反: 认人失败(not_found)后答账期 → 仍被换成追问话术',
    steps: [
      { tool: 'lookup_account', args: { student_id: '0000000', phone: '13800000000' }, stubReturn: 'not_found' },
      { kind: 'say', text: BILL_LINE },
    ],
    assert: { kind: 'said-includes', value: '麻烦您先提供' },
  },
]

describe('说话通道评测（llm/stream）', () => {
  it('正确禁语插件（大小写不敏感）：全部用例通过', async () => {
    const r = await judgeCases(GUARD_OK, SPEECH_CASES, makeTools)
    expect(r.diffs).toEqual([])
    expect(r.passed).toBe(true)
  })

  it('阴性对照：大小写敏感精确匹配，只有大写变体那条垮掉', async () => {
    const r = await judgeCases(GUARD_CASE_SENSITIVE, SPEECH_CASES, makeTools)
    expect(r.passed).toBe(false)
    expect(r.diffs).toHaveLength(1)
    expect(r.diffs[0]).toContain('大小写变体')
    // 差异描述里能看到实际说出的原文，定位得到是哪个词漏替
    expect(r.diffs[0]).toContain('Portal')
  })

  it('阴性对照：完全不挂插件，三条禁语用例全垮', async () => {
    const r = await judgeCases([], SPEECH_CASES, makeTools)
    expect(r.passed).toBe(false)
    expect(r.diffs).toHaveLength(3)
    expect(r.diffs.every(d => d.includes('禁语'))).toBe(true)
  })

  it('跨通道：工具侧建立的状态传到说话侧，同一用例内按序生效', async () => {
    const r = await judgeCases(AUTH_GATE, CROSS_CASES, makeTools)
    expect(r.diffs).toEqual([])
    expect(r.passed).toBe(true)
  })

  it('跨通道消融：拿掉 auth-gate，未认人也照说账期，两条反例垮掉', async () => {
    const r = await judgeCases([], CROSS_CASES, makeTools)
    expect(r.passed).toBe(false)
    expect(r.diffs.every(d => d.includes('B反'))).toBe(true)
    expect(r.diffs).toHaveLength(2)
  })

  it('状态不跨用例泄漏：认人成功的那条不会把状态带给之后的反例', async () => {
    // CROSS_CASES 的顺序是 反-正-反；若状态跨例泄漏，第三条会误判为通过。
    const r = await judgeCases(AUTH_GATE, CROSS_CASES, makeTools)
    expect(r.passed).toBe(true)
    // 单独重放第三条，结果必须一致
    const alone = await judgeCases(AUTH_GATE, [CROSS_CASES[2]!], makeTools)
    expect(alone.passed).toBe(true)
  })
})

describe('两条通道的断言错配给出可观测差异', () => {
  it('用例无 say 步却断言 said-* → 说明缺 say 步，不崩', async () => {
    const cases: EvalCase[] = [{
      description: '缺 say 步',
      steps: [{ tool: 'lookup_account', args: { student_id: '1' } }],
      assert: { kind: 'said-includes', value: '任意' },
    }]
    const r = await judgeCases(GUARD_OK, cases, makeTools)
    expect(r.passed).toBe(false)
    expect(r.diffs[0]).toContain('没有 say 步')
  })

  it('最后一步是 say 却断言 allowed → 说明用错通道，不崩', async () => {
    const cases: EvalCase[] = [{
      description: '通道用错',
      steps: [{ kind: 'say', text: '你好' }],
      assert: { kind: 'allowed' },
    }]
    const r = await judgeCases(GUARD_OK, cases, makeTools)
    expect(r.passed).toBe(false)
    expect(r.diffs[0]).toContain('say 步')
  })
})
