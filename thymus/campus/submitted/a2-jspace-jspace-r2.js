// A2 服务禁语过滤插件：拦截 llm/stream，检测并改写消极/质问/甩锅表达，同时完整保留事实信息（账期、金额、需用户提供的材料等）。
// 内部调用模型时通过 options 上的私有 Symbol + AsyncLocalStorage 双重防递归。

const SKIP = Symbol('jspace.a2.skip');

let ALS = null;
try {
  if (typeof require === 'function') {
    const ah = require('node:async_hooks');
    if (ah && ah.AsyncLocalStorage) ALS = new ah.AsyncLocalStorage();
  }
} catch (e) { ALS = null; }

// ---- 禁语规则（正则 → 合规替代），按顺序应用 ----
const RULES = [
  // 明确否定 / 消极拒绝
  { pattern: /(?:这|那|这个|那个|我们|我|这边|我们这边)?(?:根本|绝对|完全|真的|真|确实|就是|也|都|实在)?不可能(?:的|的事|的事情)?/g, replacement: '很抱歉，目前暂时无法实现' },
  { pattern: /(?:这|那|这个|那个|我们|我|这边|我们这边)?(?:根本|绝对|完全|真的|真|确实|就是|也|都|实在)?做不到/g, replacement: '暂时无法做到' },
  { pattern: /(?:这|那|这个|那个|我们|我|这边|我们这边)?(?:根本|绝对|完全|真的|真|确实|就是|也|都|实在)?办不到/g, replacement: '暂时无法办理' },
  { pattern: /(?:这|那|这个|那个|我们|我|这边|我们这边)?(?:根本|绝对|完全|真的|真|确实|就是|也|都|实在)?没办法/g, replacement: '很抱歉，目前暂时没有其他办法' },
  { pattern: /(?:这|那)(?:事|个|件)?(?:我)?(?:也)?(?:没办法|无能为力|无可奈何)(?:了|啊|呀)?/g, replacement: '很抱歉，目前暂时没有其他办法' },
  { pattern: /(?:解决不了|处理不了|搞不定|弄不了|办不成|搞不成|弄不成|帮不了|帮不上)/g, replacement: '暂时无法解决，我会尽力为您想办法' },

  // 甩锅推诿
  { pattern: /(?:这|那)?(?:又|也|就|并)?不(?:是)?我的(?:责任|问题|事)/g, replacement: '我帮您联系相关部门处理' },
  { pattern: /(?:这|那)?(?:又|也|就|并)?不(?:是)?我们(?:的|这边)?(?:责任|问题|事)/g, replacement: '我帮您联系相关部门处理' },
  { pattern: /不(?:归|关|是|管)我(?:的)?(?:事|责任|问题|管|负责)/g, replacement: '我来帮您处理' },
  { pattern: /(?:这|那|这个|那个)?(?:关|归|管)我(?:什么|啥)事/g, replacement: '我来帮您处理' },
  { pattern: /(?:这|那)?(?:跟|和)我(?:没|无)(?:关系|关)|(?:这|那)?(?:跟|和)我(?:有什么|啥)关系/g, replacement: '我来帮您处理' },
  { pattern: /不(?:归|关|是|管)我们(?:的|这边)?(?:管|负责|责任|问题|事)/g, replacement: '我帮您联系相关部门处理' },
  { pattern: /(?:你|您)?(?:自己)?(?:去|去找)(?:别人|其他(?:人|部门)?|别的(?:人|部门)?|相关(?:部门|人员)?|客服|前台|工作人员)(?:去|吧|好了)?/g, replacement: '我帮您联系相关部门处理' },
  { pattern: /别(?:来)?(?:找|问)我|找我也(?:没用|没办法|不行)|你找别人(?:去|吧)?/g, replacement: '我来帮您处理' },
  { pattern: /这(?:个)?(?:问题|事)(?:你)?(?:得|应该|要)(?:去)?(?:找|问)(?:别人|其他|别的|相关)/g, replacement: '我帮您联系相关部门处理' },
  { pattern: /(?<!不|没|非|只)(?:都|就|全|主要)?是(?:你|您|用户|你自己)(?:的)?(?:问题|责任|错)/g, replacement: '我帮您核实处理' },
  { pattern: /(?<!不|没|非|只)(?:都|就|全|主要)?是(?:你们|他们|财务|技术|网络|后勤|系统|服务器|别人|其他部门|那边)(?:的)?(?:问题|责任|错)/g, replacement: '我们正在为您核实处理' },
  { pattern: /(?:别|不要|别想)(?:怪|赖|怨)(?:我|我们)/g, replacement: '请放心，我来帮您处理' },
  { pattern: /(?:都|就|全)(?:怪|赖|怨)(?:你|您|用户)/g, replacement: '我们一起想办法解决' },
  { pattern: /你自己(?:搞|弄)(?:错|坏)(?:的|了)?|(?:是|都)(?:你|您)自己(?:弄|搞|操作)(?:错|坏)(?:的|了)?/g, replacement: '我帮您核实处理' },
  { pattern: /我不管(?:了|这个|这些|这事|这件事)?/g, replacement: '我来帮您处理' },
  { pattern: /(?:别|不要|不用)管我(?:了|的)?/g, replacement: '我来帮您处理' },

  // 系统/服务器甩锅
  { pattern: /系统(?:又|就|也)?(?:崩了|崩溃|挂了|炸了|出bug|出Bug|出BUG|出故障|出问题|坏了|瘫了|有bug|有Bug|有BUG)/g, replacement: '系统出现临时异常，我们正在加紧处理' },
  { pattern: /服务器(?:又|就|也)?(?:崩了|崩溃|挂了|炸了|出故障|出问题|坏了|瘫了|故障)/g, replacement: '服务器出现临时异常，我们正在加紧处理' },

  // 强势质问 / 不耐烦
  { pattern: /你(?:还|真|是|就)?听(?:不|没)懂(?:吗|啊|呢|呀|了)?(?:？|\?)?/g, replacement: '我重新为您说明一下' },
  { pattern: /你(?:还|真|是|就)?听(?:不|没)(?:明白|懂)(?:吗|啊|呢|呀|了)?(?:？|\?)?/g, replacement: '我重新为您说明一下' },
  { pattern: /你(?:还|真|是|就)?(?:不|没)(?:明白|理解)(?:吗|啊|呢|呀)?(?:？|\?)?/g, replacement: '我再为您解释一遍' },
  { pattern: /你(?:还|真|是|就)?(?:听)?(?:明白|懂)(?:了)?没有(?:？|\?)?/g, replacement: '我重新为您说明一下' },
  { pattern: /还(?:要|得)(?:我)?(?:说|讲|重复)(?:几遍|多少遍|多少次|几遍啊)(?:？|\?)?/g, replacement: '我再为您说明一遍' },
  { pattern: /我(?:已经)?说(?:了|过)?(?:多少|好几|N|n)遍(?:了)?(?:？|\?)?/g, replacement: '我重新为您说明一下' },
  { pattern: /你(?:是|有|真|还|怎么|就)(?:不是|没有)?(?:傻|蠢|笨|聋|瞎|呆|脑子|智障)(?:子|瓜|蛋|吗|啊|呀|呢)?/g, replacement: '请谅解' },
  { pattern: /爱(?:办|弄|来|去|信)不(?:办|弄|来|去|信)/g, replacement: '请问您需要我为您处理吗' },
  { pattern: /你(?:烦|无聊|幼稚|可笑|有病)不(?:烦|无聊|幼稚|可笑|有病)/g, replacement: '请谅解' },
  { pattern: /(?:你|您)(?:到底|究竟)(?:想|要)(?:怎么样|怎样|干嘛|干什么)/g, replacement: '请问您具体遇到了什么问题，我来帮您处理' },
  { pattern: /不是(?:跟|对)?你?(?:说|讲)(?:过|了)?吗(?:？|\?)?/g, replacement: '我再为您说明一下' },
  { pattern: /我(?:哪|怎么)(?:会|能)?知道/g, replacement: '我来帮您核实一下' },
  { pattern: /你(?:自己)?看着办(?:吧|好了)?/g, replacement: '您看这样可以吗' },
  { pattern: /你(?:的)?理解能力(?:有|出)(?:问题|毛病)/g, replacement: '我再为您说明一下' },

  // 消极态度
  { pattern: /(?:真|好)(?:烦|讨厌)(?:死|人|死了)?|真麻烦(?:死|人|了)?/g, replacement: '请谅解' },
  { pattern: /(?:别|不要)烦我|(?:没空|忙着呢|忙得很)/g, replacement: '请谅解，我会尽快为您处理' },
  { pattern: /(?:^|[，。！？；、\s])(又怎么了|怎么又是你|又是你|怎么老是你)/g, replacement: '$1请问还有什么可以帮您' },
  { pattern: /(?:算了|拉倒|行了吧|随便你)(?:吧|了)?/g, replacement: '请问您看这样是否可以' },
];

// ---- 事实抽取（账期、金额、日期、材料、账号等）----
const FACT_PATTERNS = [
  /(?:¥|￥|人民币)?\s*\d+(?:\.\d+)?\s*(?:元|块|角|分)/g,
  /(?:¥|￥|人民币)\s*\d+(?:\.\d+)?/g,
  /20\d{2}\s*年\s*\d{1,2}\s*月(?:份)?/g,
  /\d{1,2}\s*月(?:份)?/g,
  /\d{6,}/g,
  /(?:账期|身份证|学生证|一卡通|银行卡|卡号|复印件|学号|手机号|邮箱|发票|订单号|工号)/g,
];

// 触发语义审核（LLM）的高信号标记；不含单独的“不”，避免过度打扰合规话术
const AUDIT_MARKERS = /没|别|你|怎么|责任|系统|服务器|崩|bug|Bug|BUG|故障|烦|找|归|关|怪|怨|赖|管|懂|明白|理解|凭什么|算了|拉倒|行了吧|爱办不办|爱信不信|不管|没空|忙着|无能为力|无可奈何|听不懂|搞不定|解决不了|处理不了|帮不了|看着办|我哪知道|我怎么知道|到底想|理解能力|不行|不能|不可以/;

const MAX_AUDIT_LEN = 2000;   // 超过此长度不再调用模型（防超时/超长）
const SHORT_LEN = 12;         // 短消息直接用确定性改写，不调模型

const AUDIT_SYSTEM = `你是一名校园网客服话术合规审核助手。请判断下面这段客服回复是否违反 A2 服务禁语：态度消极、强势质问、或甩锅推诿（例如「不可能」「做不到」「没办法」「这不是我的责任」「系统崩了」「系统出bug了」「你听不懂吗」，以及类似语义的消极表达）。

只输出一个 JSON 对象，不要输出任何其他内容，不要用 Markdown 代码块：
- 合规：{"verdict":"pass"}
- 违规：{"verdict":"rewrite","rewrite":"改写后的合规文本"}

判定要求：
1. 只有明确存在消极态度、强势质问或甩锅推诿时才判违规。正常的事实说明、礼貌的拒绝（如"这笔费用暂时无法退还""您不需要提供纸质材料"）不算违规。
2. 改写时必须完整保留原文中所有事实信息（账期、金额、需用户提供的材料、账号、学号等），不得删减、更改或新增事实，也不得改变业务结论。
3. 改写后语气礼貌、积极、负责。
4. 输出必须是合法 JSON。`;

const REWRITE_SYSTEM = `你是一名校园网客服话术改写助手。下面这段客服回复违反了 A2 服务禁语：出现了态度消极、强势质问或甩锅推诿的表达（例如「不可能」「做不到」「没办法」「这不是我的责任」「系统崩了」「系统出bug了」「你听不懂吗」等）。

请把它改写为合规版本，要求：
1. 删除或替换所有消极态度、强势质问、甩锅推诿的表达，语气礼貌、积极、负责。
2. 完整保留原文中的所有事实信息：账期、金额、日期、需用户提供的材料（如身份证复印件、学生证）、账号、学号等。不得删减、更改或新增事实，也不得改变业务结论。
3. 只输出改写后的文本本身，不要解释、不要前缀、不要引号、不要 JSON。`;

function scanForbidden(text) {
  const hits = [];
  for (const rule of RULES) {
    const re = new RegExp(rule.pattern.source, rule.pattern.flags);
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) {
      hits.push(m[0]);
      if (hits.length >= 50) break;
    }
    if (hits.length >= 50) break;
  }
  return hits;
}

function deterministicRewrite(text) {
  let out = text;
  for (const rule of RULES) {
    out = out.replace(new RegExp(rule.pattern.source, rule.pattern.flags), rule.replacement);
  }
  return out;
}

function canonicalFacts(text) {
  const t = String(text || '')
    .replace(/[０-９]/g, (d) => String('０１２３４５６７８９'.indexOf(d)))
    .replace(/．/g, '.');
  const set = new Set();
  for (const re of FACT_PATTERNS) {
    const r = new RegExp(re.source, re.flags);
    r.lastIndex = 0;
    let m;
    while ((m = r.exec(t))) {
      let s = m[0].replace(/\s+/g, '');
      const am = s.match(/^(?:¥|￥|人民币)?(\d+(?:\.\d+)?)(元|块|角|分)?$/);
      if (am && (am[2] || /^(?:¥|￥|人民币)/.test(s))) {
        const val = parseFloat(am[1]);
        const unit = am[2] ? (am[2] === '块' ? '元' : am[2]) : '元';
        set.add(`${val}${unit}`);
      } else {
        set.add(s);
      }
    }
  }
  return [...set];
}

// 改写必须：不再命中禁语规则 + 原事实完整保留（既不丢也不增）
function verifyRewrite(original, rewrite) {
  if (!rewrite || typeof rewrite !== 'string') return false;
  const rw = rewrite.trim();
  if (!rw) return false;
  if (scanForbidden(rw).length > 0) return false;
  const origFacts = canonicalFacts(original);
  const newFacts = canonicalFacts(rw);
  const newSet = new Set(newFacts);
  for (const f of origFacts) if (!newSet.has(f)) return false;
  const origSet = new Set(origFacts);
  for (const f of newFacts) if (!origSet.has(f)) return false;
  return true;
}

// 统一内部模型调用入口；options 打上 SKIP 标记 + ALS 上下文，避免撞回自身 handler
async function llmCall(ctx, system, userText) {
  if (!ctx || !ctx.llm || typeof ctx.llm.stream !== 'function') return null;
  const options = {
    provider: 'deepseek-official',
    model: 'deepseek-chat',
    reasoningEffort: 'off',
    system,
    messages: [{
      role: 'user',
      content: [{ type: 'text', text: userText }],
      source: { kind: 'user' },
    }],
    [SKIP]: true,
  };
  let raw = '';
  try {
    const run = () => ctx.llm.stream(options);
    const stream = ALS ? await ALS.run(true, run) : await run();
    for await (const chunk of stream) {
      if (!chunk || typeof chunk !== 'object') continue;
      if (chunk.type === 'text-delta') raw += chunk.text || '';
      else if (chunk.type === 'block-end' && chunk.block && chunk.block.type === 'text') raw += chunk.block.text || '';
    }
  } catch (e) {
    return null;
  }
  const out = (raw || '').trim();
  return out || null;
}

async function llmRewrite(ctx, text) {
  const raw = await llmCall(ctx, REWRITE_SYSTEM, `原文：\n${text}`);
  if (!raw) return null;
  let r = raw;
  if ((r.startsWith('"') && r.endsWith('"')) || (r.startsWith('「') && r.endsWith('」')) || (r.startsWith('“') && r.endsWith('”'))) {
    r = r.slice(1, -1).trim();
  }
  return r || null;
}

async function llmAudit(ctx, text) {
  const raw = await llmCall(ctx, AUDIT_SYSTEM, `原文：\n${text}`);
  if (!raw) return null;
  try {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) return null;
    const obj = JSON.parse(raw.slice(start, end + 1));
    if (obj && obj.verdict === 'rewrite' && typeof obj.rewrite === 'string' && obj.rewrite.trim()) {
      return { verdict: 'rewrite', rewrite: obj.rewrite.trim() };
    }
    return { verdict: 'pass' };
  } catch (e) {
    return null;
  }
}

// 返回 null = 通过（原样放行）；返回字符串 = 用改写文本替换
async function processText(ctx, text) {
  try {
    const trimmed = (text || '').trim();
    if (!trimmed) return null;
    // 防递归：绝不处理像我们自己审核输出那样的 JSON 片段
    if (/^\s*\{/.test(trimmed) && /"verdict"\s*:/.test(trimmed)) return null;

    const det = scanForbidden(trimmed);

    if (det.length > 0) {
      const out = deterministicRewrite(trimmed);
      const safe = (out !== trimmed && scanForbidden(out).length === 0) ? out : null;

      // 短消息：确定性改写已足够，不再调模型（快）
      if (safe && trimmed.length <= SHORT_LEN) return safe;

      // 长/复杂消息：优先让模型给出自然、合规且保留事实的改写
      let llmOut = null;
      if (trimmed.length <= MAX_AUDIT_LEN) {
        llmOut = await llmRewrite(ctx, trimmed);
      }
      if (llmOut && verifyRewrite(trimmed, llmOut)) return llmOut;
      if (safe) return safe;

      // 兜底：确定性没清干净时再试一次语义审核改写
      if (trimmed.length <= MAX_AUDIT_LEN) {
        const audit = await llmAudit(ctx, trimmed);
        if (audit && audit.verdict === 'rewrite' && audit.rewrite && verifyRewrite(trimmed, audit.rewrite)) {
          return audit.rewrite;
        }
      }
      return out !== trimmed ? out : null;
    }

    // 确定性规则没命中：对带高信号标记的文本做一次语义审核（捕捉“无精确边界”的消极表达）
    if (trimmed.length > MAX_AUDIT_LEN || !AUDIT_MARKERS.test(trimmed)) return null;
    const audit = await llmAudit(ctx, trimmed);
    if (audit && audit.verdict === 'rewrite' && audit.rewrite && audit.rewrite !== trimmed && verifyRewrite(trimmed, audit.rewrite)) {
      return audit.rewrite;
    }
    return null;
  } catch (e) {
    return null;
  }
}

return {
  name: 'a2-service-forbidden-filter',
  inject: ['llm'],
  apply(ctx) {
    ctx.on('llm/stream', (options, next) => {
      // 防递归：我们自己的内部模型调用直接放行
      if (options && options[SKIP]) return next();
      if (ALS && ALS.getStore()) return next();

      let upstream;
      try { upstream = next(); } catch (e) { throw e; }

      return (async function* () {
        const u = (upstream && typeof upstream.then === 'function') ? await upstream : upstream;
        const buffers = new Map(); // index -> { deltas, text }

        try {
          for await (const chunk of u) {
            if (!chunk || typeof chunk !== 'object') { yield chunk; continue; }

            if (chunk.type === 'text-delta') {
              const index = chunk.index ?? 0;
              let buf = buffers.get(index);
              if (!buf) { buf = { deltas: [], text: '' }; buffers.set(index, buf); }
              buf.deltas.push(chunk);
              buf.text += chunk.text || '';
              continue;
            }

            if (chunk.type === 'block-end' && chunk.block && chunk.block.type === 'text') {
              const index = chunk.index ?? 0;
              const buf = buffers.get(index);
              if (buf) buffers.delete(index);
              const fullText = buf ? buf.text : (chunk.block.text || '');

              let rewritten = null;
              try { rewritten = await processText(ctx, fullText); } catch (e) { rewritten = null; }

              if (rewritten && rewritten !== fullText) {
                // 合成的 chunk 必须带原 index
                yield { ...chunk, type: 'text-delta', text: rewritten };
                yield { ...chunk, block: { ...(chunk.block || {}), type: 'text', text: rewritten } };
              } else {
                if (buf) for (const d of buf.deltas) yield d;
                yield chunk;
              }
              continue;
            }

            // 其它 chunk（工具调用、block-start 等）：先冲刷同 index 已缓冲的文本，保证顺序
            const idx = chunk.index;
            if (idx != null && buffers.has(idx)) {
              const buf = buffers.get(idx);
              buffers.delete(idx);
              for (const d of buf.deltas) yield d;
            }
            yield chunk;
          }
        } finally {
          // 流异常/提前结束时，把未收尾的文本块原样冲刷出去，绝不丢内容
          for (const [, buf] of buffers) {
            for (const d of buf.deltas) yield d;
          }
          buffers.clear();
        }
      })();
    });
  }
};
