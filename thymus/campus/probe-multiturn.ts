/**
 * 探针：真实模型面对「模糊输入 + 多轮填槽」的行为。
 * 不评测、不挂插件，只看 agent 拿到模糊输入时会不会先追问、会不会乱调工具。
 * 这一步定后面评测怎么写。
 */
import { resolve } from 'node:path'
import { mkdirSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import * as DeepSeek from '@deepseek-ai/dsh-llm-deepseek'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'

const MODEL = process.env.THYMUS_MODEL ?? 'deepseek-chat'
const STORE = process.env.THYMUS_STORE ?? resolve(process.cwd(), 'thymus/trajectories')

const PERSONA = `你是校园网 wenet 的在线客服。可用工具：
- lookup_account({student_id, phone})：按学号+手机号查账号，信息不全会查不到。
- reply({text})：对用户说话，你所有面向用户的话都必须通过 reply 发出。
遇到用户信息不全时，先用 reply 追问缺的信息，不要用不全的信息瞎调 lookup_account。`

const toolCalls: { name: string; args: unknown }[] = []
function tools(): ToolDefinition[] {
  return [
    {
      name: 'lookup_account',
      description: '按学号和手机号查账号信息。',
      parameters: { type: 'object', properties: { student_id: { type: 'string' }, phone: { type: 'string' } } },
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v as string }] },
      execute: (a: unknown): Promise<string> => {
        toolCalls.push({ name: 'lookup_account', args: a })
        const x = a as { student_id?: string; phone?: string }
        if (!x.student_id || !x.phone) return Promise.resolve('查询失败：信息不全')
        return Promise.resolve('学校=西大 账期=正常 认证=已通过')
      },
    },
    {
      name: 'reply',
      description: '对用户说话。',
      parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v as string }] },
      execute: (a: unknown): Promise<string> => {
        toolCalls.push({ name: 'reply', args: a })
        return Promise.resolve('（已发送给用户）')
      },
    },
  ]
}

async function main(): Promise<void> {
  if (!process.env.DEEPSEEK_API_KEY) throw new Error('缺少 DEEPSEEK_API_KEY')
  mkdirSync(STORE, { recursive: true })
  const ctx = new Context()
  await ctx.plugin(Timer); await ctx.plugin(LlmRuntime); await ctx.plugin(DeepSeek, {})
  await ctx.plugin(SessionStore); await ctx.plugin(SystemPrompt, { persona: PERSONA })
  await ctx.plugin(ToolRuntime); await ctx.plugin(AgentRegistry)
  await ctx.plugin(Jsonl, { root: STORE, compression: 'none' })
  await ctx.plugin(AgentLoop, { agents: [] })
  for (const t of tools()) ctx.tools.register(t)
  const handle = await ctx.agents.create({
    sessionId: SessionId('campus-probe'),
    agentOptions: { provider: 'deepseek-official', model: MODEL }, setup: async () => {},
  })
  const agent: Agent = handle.agent

  const userTurns = ['我上不了网', '我是西大的', '学号2021001，手机13800000000']
  for (const u of userTurns) {
    console.log(`\n用户：${u}`)
    const before = toolCalls.length
    agent.followup(createUserMessage({ content: [{ type: 'text', text: u }], source: { kind: 'user' } }))
    await agent.whenIdle()
    await new Promise(r => setTimeout(r, 300))
    for (const c of toolCalls.slice(before)) {
      if (c.name === 'reply') console.log(`  agent→用户：${(c.args as { text: string }).text.slice(0, 120)}`)
      else console.log(`  agent 调用 ${c.name}(${JSON.stringify(c.args)})`)
    }
  }
  console.log(`\n=== 工具调用汇总 ===`)
  console.log(`  lookup_account 调用次数：${toolCalls.filter(c => c.name === 'lookup_account').length}`)
  const firstLookup = toolCalls.find(c => c.name === 'lookup_account')
  console.log(`  首次 lookup 的参数：${firstLookup ? JSON.stringify(firstLookup.args) : '（整段对话未调用）'}`)
}
main().catch((e: unknown) => { console.error('失败：', e instanceof Error ? e.message : e); process.exitCode = 1 })
