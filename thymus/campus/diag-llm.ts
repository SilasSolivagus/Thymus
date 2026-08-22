/** 诊断：harness 里的模型调用到底报什么错。judgeText 会把静默失败翻成异常。 */
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import * as DeepSeek from '@deepseek-ai/dsh-llm-deepseek'
import { judgeText } from '../src/gate.ts'

async function main(): Promise<void> {
  console.log('key 长度：', (process.env.DEEPSEEK_API_KEY ?? '').length)
  const ctx = new Context()
  await ctx.plugin(Timer)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(DeepSeek, {})
  for (const model of ['deepseek-chat', 'deepseek-v4-flash']) {
    const t0 = Date.now()
    try {
      const out = await judgeText(ctx, {
        provider: 'deepseek-official', model,
        messages: [{ role: 'user', content: [{ type: 'text', text: '说三个字' }], source: { kind: 'user' } }],
      } as never)
      console.log(`${model} ✓ ${Date.now() - t0}ms 产出：${out.slice(0, 40)}`)
    } catch (e) {
      console.log(`${model} ✗ ${Date.now() - t0}ms 错误：${e instanceof Error ? e.message : String(e)}`)
    }
  }
}
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e: unknown) => { console.error('失败：', e); process.exitCode = 1 })
}
