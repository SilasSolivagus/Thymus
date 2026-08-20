// A2 服务禁语过滤插件
// 拦截 llm/stream，缓冲完整文本块，检测并改写态度消极/强势质问/甩锅推诿类表达，
// 同时原样保留账期、金额、日期、材料要求等事实信息。

const INTERNAL_MARK = '__a2Internal';

// ---- 禁语检测（SOP 示例 + 常见变体） ----
const FORBIDDEN_PHRASES = [
  // 甩锅推诿
  '这不是我的责任', '不是我的责任', '这不是我的事', '不是我的事',
  '这不是我们的事', '不是我们的事', '不归我管', '不归我们管', '不该我管', '不该我们管',
  '不关我的事', '不关我事', '跟我没关系', '这事跟我没关系', '跟我无关',
  '别找我', '你去找别人', '这是你的问题', '这是你们的问题',
  // 系统/技术推诿
  '系统出bug了', '系统崩了', '系统出问题了', '系统故障', '系统坏了', '服务器崩了',
  // 强势质问
  '你听不懂吗', '你听不明白吗', '听不明白吗', '你听懂了吗', '你明白了吗', '你懂了吗',
  '我不是说了吗', '我已经说过了', '你怎么还不懂', '你到底懂不懂',
  // 消极态度
  '随便你', '爱信不信', '你自己看着办', '我不管了', '别烦我', '烦不烦',
  '自己想办法', '你自己处理', '我处理不了', '我们处理不了', '办不了', '我解决不了',
  // SOP 明确例子
  '不可能', '做不到', '没办法', '我们也没办法', '我也没有办法'
];

// 确定性替换表（保底：只替换禁语，其余原文不动，事实天然保留）
const REPLACEMENTS = [
  ['这不是我的责任', '我来帮您联系相关部门处理'],
  ['这不是我们的事', '我来帮您联系相关部门处理'],
  ['不是我的责任', '我来帮您协调处理'],
  ['不是我的事', '我来帮您处理'],
  ['不是我们的事', '我来帮您协调处理'],
  ['不归我管', '我来帮您联系相关部门处理'],
  ['不归我们管', '我来帮您联系相关部门处理'],
  ['不该我管', '我来帮您处理'],
  ['不该我们管', '我来帮您处理'],
  ['这是你的问题', '我来协助您解决'],
  ['这是你们的问题', '我们来协助您解决'],
  ['系统出bug了', '系统正在排查处理中'],
  ['系统出问题了', '系统正在排查处理中'],
  ['系统崩了', '系统正在处理中'],
  ['系统故障', '系统正在处理中'],
  ['系统坏了', '系统正在处理中'],
  ['服务器崩了', '服务器正在处理中'],
  ['你听不懂吗', '我再为您详细说明一下'],
  ['你听不明白吗', '我再为您详细说明一下'],
  ['你听懂了吗', '我再为您说明一下'],
  ['你明白了吗', '我再为您说明一下'],
  ['你懂了吗', '我再为您说明一下'],
  ['听不明白吗', '我再为您说明一下'],
  ['我不是说了吗', '我再为您说明一次'],
  ['我已经说过了', '我再为您说明一次'],
  ['你怎么还不懂', '我换个方式为您解释'],
  ['你到底懂不懂', '我换个方式为您解释'],
  ['不关我的事', '我来帮您处理'],
  ['不关我事', '我来帮您处理'],
  ['跟我没关系', '我来帮您处理'],
  ['这事跟我没关系', '我来帮您处理'],
  ['跟我无关', '我来帮您处理'],
  ['别找我', '我来帮您处理'],
  ['你去找别人', '我来帮您处理'],
  ['随便你', '您看这样可以吗'],
  ['爱信不信', '这是目前的实际情况'],
  ['你自己看着办', '我们帮您处理'],
  ['我不管了', '我继续为您跟进'],
  ['别烦我', '请问还有什么可以帮您'],
  ['烦不烦', '我理解您的心情'],
  ['自己想办法', '我们一起想办法'],
  ['你自己处理', '我们来帮您处理'],
  ['我处理不了', '我们帮您想办法'],
  ['我们处理不了', '我们帮您想办法'],
  ['办不了', '我们再想想其他办法'],
  ['我解决不了', '我们帮您想办法'],
  ['我们也没办法', '我们可以尝试其他方式'],
  ['我也没有办法', '我们可以尝试其他方式'],
  ['不可能', '我们需要进一步核实'],
  ['做不到', '我们可以一起想办法'],
  ['没办法', '我们可以尝试其他方式']
];
REPLACEMENTS.sort((a, b) => b[0].length - a[0].length);

// 语义可疑信号：命中但不在禁语表里时，交给模型做语义判断
const SUSPICIOUS_RE = /(没办法|做不到|不可能|无法|系统崩|出bug|故障|坏了|责任|不关|听不懂|管不了|处理不了|办不了|找别人|爱信不信|随便你|看着办|我不管|别烦|烦不烦|你自己|推诿)/;

const MAX_MODEL_LENGTH = 2000;

const VERDICT_SYSTEM =
  '你是校园网客服话术的合规审查员。用户会发给你一段“客服对用户说的话”。\n' +
  '请判断这段话是否包含态度消极、强势质问、甩锅推诿类的禁语，例如：' +
  '「不可能」「做不到」「没办法」「这不是我的责任」「系统崩了」「系统出bug了」「你听不懂吗」等。\n' +
  '只输出一个 JSON 对象，不要输出任何其他内容：\n' +
  '若包含禁语，输出 {"violation": true, "rewritten": "改写后的合规文本"}；' +
  '改写时必须原样保留所有事实信息（账期、金额、日期、需要用户提供的材料/证件名称、办理时限、联系方式等），不得丢失、篡改或新增事实。\n' +
  '若不包含禁语，输出 {"violation": false, "rewritten": ""}。';

function hasForbidden(text) {
  if (!text) return false;
  return FORBIDDEN_PHRASES.some((p) => text.includes(p));
}

function looksSuspicious(text) {
  if (!text) return false;
  return SUSPICIOUS_RE.test(text);
}

function cleanup(text) {
  let result = text || '';
  for (const [phrase, replacement] of REPLACEMENTS) {
    if (result.includes(phrase)) {
      result = result.split(phrase).join(replacement);
    }
  }
  return result;
}

// 提取事实信息：数字、金额、日期、百分比、邮箱、手机号等
function extractFacts(text) {
  const facts = new Set();
  const patterns = [
    /\d{4}\s*年\s*\d{1,2}\s*月(?:\s*\d{1,2}\s*日)?/g,
    /\d{1,2}\s*月\s*\d{1,2}\s*日/g,
    /\d{1,2}\s*月/g,
    /\d{1,2}\s*日/g,
    /[￥¥]\s*\d+(?:\.\d+)?/g,
    /\d+(?:\.\d+)?\s*元/g,
    /\d+(?:\.\d+)?%/g,
    /\b\d+(?:\.\d+)?\b/g,
    /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
    /1[3-9]\d{9}/g
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(text)) !== null) {
      const f = m[0].replace(/\s+/g, '');
      if (f) facts.add(f);
    }
  }
  return facts;
}

function factsPreserved(original, rewritten) {
  const facts = extractFacts(original);
  const rw = (rewritten || '').replace(/\s+/g, '');
  for (const f of facts) {
    if (f.length <= 1) continue;
    if (!rw.includes(f)) return false;
  }
  return true;
}

function normalizeModelOutput(s) {
  let t = (s || '').trim();
  const fence = t.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/);
  if (fence) t = fence[1].trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith('“') && t.endsWith('”'))) {
    t = t.slice(1, -1).trim();
  }
  return t;
}

function extractJson(s) {
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start !== -1 && end > start) return s.slice(start, end + 1);
  return s;
}

async function collectTextFromStream(iterable) {
  let text = '';
  for await (const chunk of iterable) {
    if (!chunk || typeof chunk !== 'object') continue;
    if (chunk.type === 'text-delta') {
      if (typeof chunk.text === 'string') text += chunk.text;
    } else if (chunk.type === 'block-end' && chunk.block && chunk.block.type === 'text') {
      if (typeof chunk.block.text === 'string' && chunk.block.text) {
        text = chunk.block.text;
      }
    }
  }
  return text;
}

// 内部模型调用：带标记，避免撞回本 handler 造成无限递归
async function callModelVerdict(text, ctx) {
  const options = {
    provider: 'deepseek-official',
    model: 'deepseek-chat',
    reasoningEffort: 'off',
    system: VERDICT_SYSTEM,
    messages: [
      { role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }
    ]
  };
  options[INTERNAL_MARK] = true;
  const stream = ctx.llm.stream(options);
  const raw = await collectTextFromStream(stream);
  const out = extractJson(normalizeModelOutput(raw));
  try {
    const parsed = JSON.parse(out);
    if (parsed && typeof parsed === 'object') return parsed;
  } catch (e) {
    // 解析失败则视为无法判断
  }
  return null;
}

async function rewriteText(original, ctx) {
  if (!original) return original;
  const patternHit = hasForbidden(original);
  const suspicious = !patternHit && looksSuspicious(original);
  if (!patternHit && !suspicious) return original;

  const cleanedOriginal = cleanup(original);

  let model = null;
  if (original.length <= MAX_MODEL_LENGTH) {
    try {
      model = await callModelVerdict(original, ctx);
    } catch (e) {
      model = null;
    }
  }

  let modelRewrite = null;
  if (model && model.violation === true && typeof model.rewritten === 'string' && model.rewritten.trim()) {
    modelRewrite = cleanup(model.rewritten.trim());
  }

  if (patternHit) {
    // 已知禁语必须清除：优先用模型改写（事实保留且无已知禁语），否则用确定性替换兜底
    if (modelRewrite && factsPreserved(original, modelRewrite) && !hasForbidden(modelRewrite)) {
      return modelRewrite;
    }
    return cleanedOriginal;
  }

  // 纯语义可疑：只有模型明确判定违规且事实保留才改写，否则保持原文，避免破坏合规话术
  if (modelRewrite && factsPreserved(original, modelRewrite)) {
    return modelRewrite;
  }
  return original;
}

function splitText(text, size) {
  const s = size || 24;
  if (!text) return [''];
  const pieces = [];
  for (let i = 0; i < text.length; i += s) {
    pieces.push(text.slice(i, i + s));
  }
  return pieces.length ? pieces : [''];
}

async function* transform(upstream, ctx) {
  // 1) 缓冲全部 chunk，保证顺序
  const chunks = [];
  for await (const chunk of upstream) {
    chunks.push(chunk);
  }

  // 2) 按 index 聚合文本块（text-delta + text block-end）
  const blocks = new Map();
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    if (!c || typeof c !== 'object') continue;
    if (c.type === 'text-delta') {
      let b = blocks.get(c.index);
      if (!b) {
        b = { deltas: [], endPos: -1, text: '' };
        blocks.set(c.index, b);
      }
      b.deltas.push(i);
      if (typeof c.text === 'string') b.text += c.text;
    } else if (c.type === 'block-end' && c.block && c.block.type === 'text') {
      let b = blocks.get(c.index);
      if (!b) {
        b = { deltas: [], endPos: -1, text: '' };
        blocks.set(c.index, b);
      }
      b.endPos = i;
      if (typeof c.block.text === 'string' && c.block.text) b.text = c.block.text;
    }
  }

  // 3) 逐块改写
  const newTexts = new Map();
  for (const [index, b] of blocks) {
    if (!b.text) {
      newTexts.set(index, b.text);
      continue;
    }
    try {
      newTexts.set(index, await rewriteText(b.text, ctx));
    } catch (e) {
      newTexts.set(index, b.text);
    }
  }

  // 4) 按原顺序输出，替换文本块内容；合成 chunk 必须带原 index
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    if (!c || typeof c !== 'object') {
      if (c !== undefined && c !== null) yield c;
      continue;
    }
    if (c.type === 'text-delta') {
      const b = blocks.get(c.index);
      if (b && b.deltas.includes(i)) {
        if (b.deltas[0] === i) {
          const nt = newTexts.get(c.index);
          if (nt === b.text) {
            // 未改写：原样回放该块 delta
            for (const pos of b.deltas) {
              yield chunks[pos];
            }
          } else {
            // 改写：用原 index 合成新 delta
            for (const piece of splitText(nt)) {
              yield { type: 'text-delta', index: c.index, text: piece };
            }
          }
        }
        continue;
      }
      yield c;
    } else if (c.type === 'block-end' && c.block && c.block.type === 'text') {
      const b = blocks.get(c.index);
      if (b && newTexts.has(c.index)) {
        const nt = newTexts.get(c.index);
        if (nt !== b.text) {
          yield { ...c, block: { ...c.block, text: nt } };
          continue;
        }
      }
      yield c;
    } else {
      yield c;
    }
  }
}

return {
  name: 'a2-forbidden-language-filter',
  inject: ['llm'],
  apply(ctx) {
    ctx.on('llm/stream', (options, next) => {
      // 本插件自己发起的模型调用：直接放行，防止无限递归
      if (options && options[INTERNAL_MARK]) {
        delete options[INTERNAL_MARK];
        return next(options);
      }
      const upstream = next(options);
      if (upstream && typeof upstream[Symbol.asyncIterator] === 'function') {
        return transform(upstream, ctx);
      }
      return upstream;
    });
  }
};
