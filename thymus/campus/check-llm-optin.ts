/**
 * 检查：`judgeCases` 的 `llm` opt-in 接真 provider 能不能用。
 *
 * 单元测试里那一档用假 adapter，验的是装配（LlmRuntime 装上、inject 解析、
 * provider 路由命中、改写回到 say 步）。这里换成真 DeepSeek，验的是没被单元
 * 测试覆盖的那一段：provider 插件装进 runCase、API key 加载、真实延迟。
 *
 * 三组，同一批用例：
 *   不开 llm —— 插件拿不到 llm 服务，apply 不执行，禁语原样漏出（应当垮）
 *   开 llm   —— 插件调得到真模型，改写生效（应当过）
 *   过度改写对照 —— 正常话术必须原样保留（含在用例里）
 *
 * 插件源码是 probe-semantic-guard.ts 语义版的最小版：只留判定与防递归，
 * 去掉 console 日志。不 import 那个文件——它跑起来是完整探针。
 *
 * 跑法：DEMODIR=campus DEMO=check-llm-optin ./thymus/demo/run.sh
 */
import { pathToFileURL } from 'node:url'
import * as DeepSeek from '@deepseek-ai/dsh-llm-deepseek'
import type { Context } from '@deepseek-ai/cordis'
import { judgeCases, type EvalCase } from '../src/eval-framework.ts'

const MODEL = process.env.THYMUS_MODEL ?? 'deepseek-chat'

/**
 * 语义禁语插件。防递归：自己发起的判定调用带 provider 'deepseek-official'，
 * 用户那条走 say 步的 provider 是 'judge'，见到不是 'judge' 就直接放行。
 */
const SEMANTIC_GUARD = `
  const MODEL = ${JSON.stringify(MODEL)};
  const SYSTEM = [
    '你是客服话术合规判定器。判定一段客服要对用户说的话是否属于服务禁语：',
    '态度消极、强势质问、甩锅推诿。',
    '属于则改写成合规的客服话术：保留原文的事实信息，只改态度；不属于则原样保留。',
    '只输出 JSON，不要输出别的：{"violation":true或false,"rewrite":"改写后的话，不违规时与原文逐字相同"}',
  ].join('');
  function parse(raw){
    let s = String(raw).trim();
    if (s.startsWith('\\u0060\\u0060\\u0060')) {
      s = s.replace(/^\\u0060\\u0060\\u0060[a-zA-Z]*\\s*/, '').replace(/\\u0060\\u0060\\u0060\\s*$/, '').trim();
    }
    return JSON.parse(s);
  }
  return {
    name: 'semantic-speech-guard',
    inject: ['llm'],
    apply(ctx) {
      async function decide(text){
        const options = {
          provider: 'deepseek-official', model: MODEL, reasoningEffort: 'off', system: SYSTEM,
          messages: [{ role:'user', content:[{type:'text',text:'待判定：'+text}], source:{kind:'user'} }],
        };
        let deltas = ''; let blockText;
        try {
          for await (const c of ctx.llm.stream(options)) {
            if (c && c.type === 'text-delta' && typeof c.text === 'string') deltas += c.text;
            else if (c && c.type === 'block-end' && c.block && c.block.type === 'text') blockText = c.block.text;
          }
        } catch (e) { return text; }
        const raw = blockText !== undefined ? blockText : deltas;
        let v; try { v = parse(raw); } catch (e) { return text; }
        if (!v || v.violation !== true) return text;
        return typeof v.rewrite === 'string' && v.rewrite.length > 0 ? v.rewrite : text;
      }
      ctx.on('llm/stream', (options, next) => {
        if (options.provider !== 'judge') return next();   // 自己发起的判定调用
        const upstream = next();
        return (async function*(){
          for await (const chunk of upstream) {
            if (chunk && chunk.type === 'text-delta') continue;
            if (chunk && chunk.type === 'block-end' && chunk.block && chunk.block.type === 'text') {
              const out = await decide(chunk.block.text);
              yield { type:'text-delta', index: chunk.index, text: out };
              yield { ...chunk, block: { ...chunk.block, text: out } };
              continue;
            }
            yield chunk;
          }
        })();
      });
    },
  }
`

// 用例取自 probe-semantic-guard.ts 的话术，含一条过度改写对照。
const CASES: EvalCase[] = [
  { description: '禁语「不可能」须消失', steps: [{ kind: 'say', text: '这个不可能，我们没办法处理。' }], assert: { kind: 'said-excludes', value: '不可能' } },
  { description: '禁语「不是我的责任」须消失', steps: [{ kind: 'say', text: '系统崩了，这不是我的责任。' }], assert: { kind: 'said-excludes', value: '不是我的责任' } },
  { description: '正常话术须原样（过度改写对照）', steps: [{ kind: 'say', text: '您的账期是2026年8月，费用30元，已为您核实。' }], assert: { kind: 'said-includes', value: '您的账期是2026年8月，费用30元，已为您核实。' } },
]

function box(t: string): void { console.log(`\n${'='.repeat(76)}\n${t}\n${'='.repeat(76)}`) }

async function main(): Promise<void> {
  if (!process.env.DEEPSEEK_API_KEY) throw new Error('缺少 DEEPSEEK_API_KEY')
  console.log(`模型：${MODEL} · 用例 ${CASES.length} 条`)

  box('组一 不开 llm：插件拿不到 llm 服务，应当垮')
  const t0 = Date.now()
  const off = await judgeCases(SEMANTIC_GUARD, CASES, () => [])
  console.log(`  passed=${off.passed} · ${Date.now() - t0}ms`)
  for (const d of off.diffs) console.log(`    · ${d}`)

  box('组二 开 llm 接真 DeepSeek：应当过')
  const t1 = Date.now()
  const on = await judgeCases(SEMANTIC_GUARD, CASES, () => [], {
    llm: (ctx: Context) => ctx.plugin(DeepSeek, {}) as unknown as Promise<void>,
  })
  console.log(`  passed=${on.passed} · ${Date.now() - t1}ms（含 ${CASES.length} 次真模型判定）`)
  for (const d of on.diffs) console.log(`    · ${d}`)

  box('结论')
  const ok = !off.passed && on.passed
  console.log(`  不开 llm 垮掉：${!off.passed ? '是' : '否（异常：插件没装成也过了，说明用例没判别力）'}`)
  console.log(`  开 llm 通过：${on.passed ? '是' : '否'}`)
  console.log(`  opt-in 接真 provider ${ok ? '可用' : '不可用'}`)
  if (!ok) process.exitCode = 1
}

// 只在被直接执行时跑。
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e: unknown) => { console.error('\n运行失败：', e instanceof Error ? e.message : e); process.exitCode = 1 })
}
