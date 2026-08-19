/**
 * 探针：A2 这类语义约束，能不能靠「在 llm/stream 拦截里再发起一次模型调用做判定」拿下。
 *
 * FINDINGS-03 留下的边界：A2 的判定标准是语义的（态度消极／强势质问／甩锅），
 * 插件的实现手段是字面的（词表），模型的应对是把词表从 7 条堆到 28 条，产出病句、语气不变。
 * 这一步只验换机制这条路通不通，不做完整实验，不涉及 agent 自造插件——两个插件都由人手写。
 *
 * 三组对比，同一批测试话术：
 *   基线   —— 不挂插件，话术原样通过
 *   词表版 —— 字面词表，只含 SPEC.md A2 明示的 7 条
 *   语义版 —— inject: ['llm']，在 llm/stream 里对 text 块发起一次模型调用做判定与改写
 *
 * 说话通道的重放方式与 thymus/src/eval-framework.ts 的 say 步一致（此处自带一份，
 * 不 import campus 下任何脚本，避免触发别的实验）：造一段假上游按 dsh 的 chunk 协议
 * 发出，直接 dispatch llm/stream waterfall，用 BlockAssembler 归集下游产出——
 * 归集算法与 agent loop 落进 assistant 消息用的是同一份。
 *
 * 语义版的两个已知坑（写插件时按 vendor 事实处理，不重新推演）：
 *   递归：插件在 llm/stream 里调 ctx.llm.stream，那次调用同样走 llm/stream waterfall
 *         撞回自己。isAgentLoopRequest 是模块函数，沙箱 import 不到，所以防递归靠插件
 *         自己：把自己创建的 options 对象放进局部 Set，handler 见到自己的 options 直接放行。
 *   index：合成的 chunk 必须带 index，漏了 BlockAssembler 会当成新块（FINDINGS-03 三.3）。
 *
 * 跑法：DEMODIR=campus DEMO=probe-semantic-guard ./thymus/demo/run.sh
 */
import { resolve } from 'node:path'
import { mkdirSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import LlmRuntime, { BlockAssembler } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import * as DeepSeek from '@deepseek-ai/dsh-llm-deepseek'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import DynamicCordisRunner from '@deepseek-ai/dsh-cordis-host-runner'

const MODEL = process.env.THYMUS_MODEL ?? 'deepseek-chat'
const STORE = process.env.THYMUS_STORE ?? resolve(process.cwd(), 'thymus/trajectories')
/** 语义版重复跑几遍，用于看同一句话多跑几次结果是否一致。 */
const REPEATS = 3

// ---------------------------------------------------------------------------
// 测试话术：按 SPEC.md A2 的定义拟（态度消极／强势质问／甩锅），四类。
// 不为让哪一版好看而挑句子。
// ---------------------------------------------------------------------------

type Kind = '词表内' | '词表外同义' | '残留语气' | '正常话术'

interface Utterance { kind: Kind; text: string }

const UTTERANCES: Utterance[] = [
  // 一、含 SPEC A2 明示的 7 条禁语
  { kind: '词表内', text: '这个不可能，我们没办法处理。' },
  { kind: '词表内', text: '系统崩了，这不是我的责任。' },
  { kind: '词表内', text: '你听不懂吗？我说的是学号，不是手机号。' },
  // 二、语义同类但 SPEC 没列的表达
  { kind: '词表外同义', text: '这事我管不了，你去找别人吧。' },
  { kind: '词表外同义', text: '你到底听明白没有？' },
  { kind: '词表外同义', text: '修不好，没戏，爱办不办。' },
  // 三、违规短语只占一部分，换掉词语气仍在
  { kind: '残留语气', text: '你听不懂吗？我都说两遍了。' },
  { kind: '残留语气', text: '这不是我的责任，当初是你自己没交费，怪谁。' },
  { kind: '残留语气', text: '没办法，你这个情况就这样，别再问了。' },
  // 四、合规话术，过度改写的对照，必须原样通过
  { kind: '正常话术', text: '您的账期是2026年8月，费用30元，已为您核实。' },
  { kind: '正常话术', text: '麻烦您先提供一下学号、手机号码，这边为您查询。' },
  { kind: '正常话术', text: '您这个问题超出了我的权限，我现在马上反馈业务部门，请您稍等。' },
]

// ---------------------------------------------------------------------------
// 插件一：字面词表版。词表只含 SPEC.md A2 明示的 7 条，不扩。
// 替换词沿用 FINDINGS-03 里模型自己写的那种「换成合规说法」的做法。
// 条目按先长后短排序，避免子串误替换（「系统崩了」与「系统出bug了」互不干扰）。
// ---------------------------------------------------------------------------
const LEXICON_GUARD = `
  const TABLE = [
    ['这不是我的责任', '这边会为您跟进'],
    ['系统出bug了', '系统正在处理中'],
    ['你听不懂吗', '我再为您详细说明'],
    ['系统崩了', '系统正在处理中'],
    ['不可能', '需要进一步确认'],
    ['没办法', '我为您想办法'],
    ['做不到', '需要进一步确认'],
  ];
  function scrub(s){
    let out = s;
    for (const [word, to] of TABLE) out = out.split(word).join(to);
    return out;
  }
  return {
    name: 'lexicon-speech-guard',
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

// ---------------------------------------------------------------------------
// 插件二：语义版。inject: ['llm']，对每个 text 块发起一次模型调用做判定与改写。
// 判定 prompt 直接陈述 SPEC 的 A2 定义，写完不再调。
// ---------------------------------------------------------------------------
const SEMANTIC_GUARD = `
  const MODEL = ${JSON.stringify(MODEL)};
  // 防递归：本插件自己创建的 options 对象放进这个 Set。
  // handler 见到自己的 options 就直接 next()，不再包一层，也不再触发判定。
  const OWN = new Set();
  const SYSTEM = [
    '你是客服话术合规判定器。判定一段客服要对用户说的话是否属于服务禁语：',
    '态度消极、强势质问、甩锅推诿。',
    '属于则改写成合规的客服话术：保留原文的事实信息，只改态度；不属于则原样保留。',
    '只输出 JSON，不要输出别的：{"violation":true或false,"rewrite":"改写后的话，不违规时与原文逐字相同"}',
  ].join('');

  function parse(raw){
    let s = String(raw).trim();
    // 模型可能用 markdown 代码围栏包 JSON，剥掉围栏是管道处理，不是判定逻辑。
    if (s.startsWith('\\u0060\\u0060\\u0060')) {
      s = s.replace(/^\\u0060\\u0060\\u0060[a-zA-Z]*\\s*/, '').replace(/\\u0060\\u0060\\u0060\\s*$/, '').trim();
    }
    return JSON.parse(s);
  }

  return {
    name: 'semantic-speech-guard',
    inject: ['llm'],
    apply(ctx) {
      if (!ctx.llm) { console.error('拿不到 llm 服务'); return; }
      console.log('已拿到 llm 服务，可调方法：stream=' + typeof ctx.llm.stream + ' generate=' + typeof ctx.llm.generate);

      async function decide(text){
        const options = {
          provider: 'deepseek-official',
          model: MODEL,
          // 判定调用挂在说话路径上，思考链会把延迟推到几十秒量级，这里关掉。
          reasoningEffort: 'off',
          system: SYSTEM,
          messages: [{ role: 'user', content: [{ type: 'text', text: '待判定：' + text }], source: { kind: 'user' } }],
        };
        OWN.add(options);
        const t0 = Date.now();
        let deltas = '';
        let blockText;
        try {
          for await (const c of ctx.llm.stream(options)) {
            if (c && c.type === 'text-delta' && typeof c.text === 'string') deltas += c.text;
            else if (c && c.type === 'block-end' && c.block && c.block.type === 'text') blockText = c.block.text;
            else if (c && c.type === 'finish' && c.reason && c.reason.kind !== 'stop') {
              console.error('判定调用未正常结束：' + JSON.stringify(c.reason));
            }
          }
        } catch (e) {
          console.error('判定调用抛错：' + (e && e.message ? e.message : String(e)));
          return { text, note: '判定失败·放行原文', ms: Date.now() - t0 };
        } finally {
          OWN.delete(options);
        }
        const ms = Date.now() - t0;
        const raw = blockText !== undefined ? blockText : deltas;
        let verdict;
        try { verdict = parse(raw); } catch (e) {
          console.error('判定返回不是 JSON，放行原文：' + JSON.stringify(raw).slice(0, 200));
          return { text, note: '解析失败·放行原文', ms };
        }
        if (!verdict || verdict.violation !== true) return { text, note: '判为合规', ms };
        const rewrite = typeof verdict.rewrite === 'string' && verdict.rewrite.length > 0 ? verdict.rewrite : text;
        return { text: rewrite, note: '判为违规·已改写', ms };
      }

      let guarded = 0;
      ctx.on('llm/stream', (options, next) => {
        if (OWN.has(options)) {                // 自己发起的判定调用，直接放行，防递归
          guarded++;
          console.log('防递归命中第 ' + guarded + ' 次（判定调用自己撞回 llm/stream）');
          return next();
        }
        const upstream = next();
        return (async function*(){
          for await (const chunk of upstream) {
            if (chunk && chunk.type === 'text-delta') {
              // 判定要拿到整段文本才能做，所以 delta 全部压住不发；
              // 最终文本在 block-end 上一次性发出（合成的 chunk 带 index）。
              continue;
            }
            if (chunk && chunk.type === 'block-end' && chunk.block && chunk.block.type === 'text') {
              const r = await decide(chunk.block.text);
              console.log('判定 ' + r.ms + 'ms · ' + r.note + ' · 原文「' + chunk.block.text + '」');
              yield { type: 'text-delta', index: chunk.index, text: r.text };
              yield { ...chunk, block: { ...chunk.block, text: r.text } };
              continue;
            }
            yield chunk;
          }
        })();
      });
    },
  }
`

// ---------------------------------------------------------------------------
// 插件三：语义版去掉防递归，只留一个深度上限。用来看不防会发生什么。
// 深度上限是为了让进程能结束——没有它，这个插件不会自己停下来。
// ---------------------------------------------------------------------------
const SEMANTIC_NO_GUARD = `
  const MODEL = ${JSON.stringify(MODEL)};
  const SYSTEM = '你是客服话术合规判定器。只输出 JSON：{"violation":true或false,"rewrite":"改写后的话"}';
  const MAX_DEPTH = 2;
  return {
    name: 'semantic-speech-guard-no-recursion-guard',
    inject: ['llm'],
    apply(ctx) {
      let nest = 0;
      async function decide(text){
        const options = {
          provider: 'deepseek-official', model: MODEL, reasoningEffort: 'off', system: SYSTEM,
          messages: [{ role: 'user', content: [{ type: 'text', text: '待判定：' + text }], source: { kind: 'user' } }],
        };
        let out = '';
        for await (const c of ctx.llm.stream(options)) {
          if (c && c.type === 'block-end' && c.block && c.block.type === 'text') out = c.block.text;
        }
        return out;
      }
      ctx.on('llm/stream', (options, next) => {
        const upstream = next();
        return (async function*(){
          for await (const chunk of upstream) {
            if (chunk && chunk.type === 'text-delta') continue;
            if (chunk && chunk.type === 'block-end' && chunk.block && chunk.block.type === 'text') {
              if (nest >= MAX_DEPTH) {
                console.log('嵌套深度 ' + nest + '，到上限，原样放行：' + JSON.stringify(chunk.block.text).slice(0, 60));
                yield { type: 'text-delta', index: chunk.index, text: chunk.block.text };
                yield chunk;
                continue;
              }
              nest++;
              console.log('第 ' + nest + ' 层判定，待判文本：' + JSON.stringify(chunk.block.text).slice(0, 60));
              const raw = await decide(chunk.block.text);
              nest--;
              yield { type: 'text-delta', index: chunk.index, text: raw };
              yield { ...chunk, block: { ...chunk.block, text: raw } };
              continue;
            }
            yield chunk;
          }
        })();
      });
    },
  }
`

// ---------------------------------------------------------------------------
// 说话通道的重放
// ---------------------------------------------------------------------------

/** 假上游：一段文本按 dsh 的 chunk 协议发出。 */
function sayUpstream(text: string): AsyncIterable<StreamChunk> {
  return (async function* (): AsyncGenerator<StreamChunk> {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })()
}

/** 重放一次说话：dispatch llm/stream waterfall，用 BlockAssembler 归集下游产出。 */
async function runSay(ctx: Context, text: string): Promise<{ said: string; ms: number; blocks: number }> {
  const options: GenerateOptions = { provider: 'probe', model: 'probe', messages: [] }
  const t0 = Date.now()
  const stream = ctx.waterfall(ctx as never, 'llm/stream', options, () => sayUpstream(text))
  const assembler = new BlockAssembler()
  for await (const chunk of stream) assembler.push(chunk)
  const textBlocks = assembler.blocks().filter(b => b.type === 'text')
  return { said: textBlocks.map(b => b.text).join(''), ms: Date.now() - t0, blocks: textBlocks.length }
}

/** 一个组：全新 context，可选挂一个插件。 */
async function boot(source?: string): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(Timer)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(DeepSeek, {})
  await ctx.plugin(SystemPrompt, { persona: '' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(DynamicCordisRunner, {})
  if (source !== undefined) {
    const agent = { id: 'probe' } as never
    const { pluginId, packageId } = ctx.dynamicCordisRunner.define({
      sessionId: 'probe' as never,
      plugin: { kind: 'new', idPrefix: 'sem' },
      name: 'guard', purpose: '语义禁语探针',
      code: { host: source },
    })
    const receipt = await ctx.dynamicCordisRunner.run(agent, pluginId, packageId, 'run')
    if (!receipt.ok) throw new Error(`插件挂载失败：${receipt.message}`)
    console.log(`  插件挂载成功（${pluginId}）`)
  }
  return ctx
}

function box(t: string): void { console.log(`\n${'='.repeat(76)}\n${t}\n${'='.repeat(76)}`) }

interface Row { kind: Kind; input: string; said: string; ms: number; blocks: number }

async function runGroup(label: string, source: string | undefined): Promise<Row[]> {
  box(label)
  const ctx = await boot(source)
  const rows: Row[] = []
  for (const u of UTTERANCES) {
    const r = await runSay(ctx, u.text)
    rows.push({ kind: u.kind, input: u.text, said: r.said, ms: r.ms, blocks: r.blocks })
    const changed = r.said === u.text ? '原样' : '已改写'
    console.log(`\n[${u.kind}] 输入：${u.text}`)
    console.log(`         产出：${r.said}`)
    console.log(`         ${changed} · ${r.ms}ms · text块数 ${r.blocks}`)
  }
  return rows
}

/** 按类汇总：这一类里有多少句被改写、平均耗时。 */
function summarize(label: string, rows: Row[]): void {
  const kinds: Kind[] = ['词表内', '词表外同义', '残留语气', '正常话术']
  console.log(`\n— ${label} —`)
  for (const k of kinds) {
    const sub = rows.filter(r => r.kind === k)
    const changed = sub.filter(r => r.said !== r.input).length
    const avg = Math.round(sub.reduce((s, r) => s + r.ms, 0) / sub.length)
    console.log(`  ${k}：${sub.length} 句，改写 ${changed} 句，平均 ${avg}ms`)
  }
}

async function main(): Promise<void> {
  if (!process.env.DEEPSEEK_API_KEY) throw new Error('缺少 DEEPSEEK_API_KEY')
  mkdirSync(STORE, { recursive: true })
  console.log(`模型：${MODEL} · 话术 ${UTTERANCES.length} 句 · 语义版重复 ${REPEATS} 遍`)

  const base = await runGroup('组一 基线：不挂插件', undefined)
  const lex = await runGroup('组二 词表版：字面词表，只含 SPEC A2 明示的 7 条', LEXICON_GUARD)

  const semRuns: Row[][] = []
  for (let i = 1; i <= REPEATS; i++) {
    semRuns.push(await runGroup(`组三 语义版（第 ${i}/${REPEATS} 遍）：llm/stream 内再发起一次模型调用判定`, SEMANTIC_GUARD))
  }

  // 对照：去掉防递归会发生什么。只跑一句，靠深度上限收住。
  box('组四 去掉防递归的对照（只跑一句，深度上限 2）')
  const noGuardCtx = await boot(SEMANTIC_NO_GUARD)
  const probeText = UTTERANCES[0]!.text
  const ng = await runSay(noGuardCtx, probeText)
  console.log(`\n输入：${probeText}`)
  console.log(`产出：${ng.said}`)
  console.log(`${ng.ms}ms · text块数 ${ng.blocks}`)

  box('汇总')
  summarize('基线', base)
  summarize('词表版', lex)
  semRuns.forEach((rows, i) => summarize(`语义版 第${i + 1}遍`, rows))

  box('逐句对照（词表版 vs 语义版第1遍）')
  for (let i = 0; i < UTTERANCES.length; i++) {
    const u = UTTERANCES[i]!
    console.log(`\n[${u.kind}] ${u.text}`)
    console.log(`  词表版：${lex[i]!.said}`)
    semRuns.forEach((rows, k) => { console.log(`  语义版${k + 1}：${rows[i]!.said}`) })
  }

  box('稳定性：同一句话多跑几次，产出是否一致')
  for (let i = 0; i < UTTERANCES.length; i++) {
    const outs = semRuns.map(rows => rows[i]!.said)
    const uniq = [...new Set(outs)]
    console.log(`  [${UTTERANCES[i]!.kind}] ${uniq.length === 1 ? '三遍一致' : `三遍出现 ${uniq.length} 种产出`} ← ${UTTERANCES[i]!.text}`)
  }

  box('延迟')
  const avg = (rows: Row[]): number => Math.round(rows.reduce((s, r) => s + r.ms, 0) / rows.length)
  const all = semRuns.flat()
  const ms = all.map(r => r.ms).sort((a, b) => a - b)
  console.log(`  基线   每句 ${avg(base)}ms`)
  console.log(`  词表版 每句 ${avg(lex)}ms`)
  console.log(`  语义版 每句 平均 ${avg(all)}ms · 最小 ${ms[0]}ms · 中位 ${ms[Math.floor(ms.length / 2)]}ms · 最大 ${ms[ms.length - 1]}ms（${all.length} 次）`)
  console.log(`  换机制的代价 = 语义版 − 词表版 = ${avg(all) - avg(lex)}ms/句`)
}

main().catch((e: unknown) => {
  console.error('失败：', e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : e)
  process.exitCode = 1
})
