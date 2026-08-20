// ============================================================
// j-space · A2 服务禁语约束插件
// 约束：agent 对用户说的话不得出现态度消极 / 强势质问 / 甩锅推诿类表达；
//       合规话术与事实信息（账期、金额、用户需提供的材料等）必须原样保留。
// 挂载：llm/stream。每个 text block 缓冲完整文本：
//       - 无违规 -> 原样透传（逐 chunk 保真）；
//       - 有违规 -> LLM 判定 + 最小片段（span）改写，span 之外原文一字不改；
//       - LLM 不可用/失败 -> 确定性短语表兜底。
// 防递归：内部模型调用通过 WeakSet + Symbol + system 哨兵三重标记，命中则直接 next()。
// ============================================================

const INTERNAL = Symbol('jspace.a2.internal');
const SENTINEL = '__JSPACE_A2_INTERNAL__';
const internalCalls = new WeakSet();

const JUDGE_SYSTEM = [
  '你是校园网客服的合规审查助手。你只输出严格 JSON，不输出任何其他内容。',
  '你的任务：判断一段客服 agent 对用户说的话是否包含"服务禁语"。',
  '服务禁语包括三类：',
  '1. 态度消极：如「不可能」「做不到」「没办法」「无能为力」等表示拒绝、无能为力、消极应付的表达；',
  '2. 强势质问：如「你听不懂吗」「你到底想怎样」等质问、不耐烦的表达；',
  '3. 甩锅推诿：如「这不是我的责任」「不关我的事」「系统崩了」「系统出bug了」「你自己弄错了吧」等推卸责任的表达。',
  '注意：礼貌地说明事实、告知办理流程、表示愿意帮助、正常询问用户需求，不属于禁语；',
  '如实告知系统暂时异常并致歉，不算是推诿。',
  '只有明确符合上述三类禁语才标记 forbidden=true；不确定时倾向于 false，不要误伤正常话术。',
  '输出格式（严格 JSON，不要多余字符）：',
  '{"forbidden": true或false, "spans": [{"text":"禁语原文字","start":0,"replacement":"礼貌中性的替代表达"}], "reason":"一句话原因"}',
  '要求：',
  '- forbidden 为 true 时，spans 列出所有违反禁语的最小片段，每个片段给出在原文中的起始下标 start（从0开始）和原文片段 text；',
  '- replacement 必须礼貌、积极、不推诿、不质问，且不得改动句子中的事实信息（账期、日期、金额、材料、账号等）；',
  '- 没有禁语时 forbidden 为 false，spans 为 []。'
].join('\n');

const REWRITE_SYSTEM = [
  '你是校园网客服的话术改写助手。下面一段客服 agent 对用户说的话包含服务禁语（态度消极、强势质问或甩锅推诿）。',
  '请改写这段话：',
  '- 只替换禁语部分，其余内容一字不改；',
  '- 所有事实信息（账期、日期、金额、用户需提供的材料、账号、办理流程等）必须原样保留；',
  '- 语气礼貌、积极、不推诿、不质问；',
  '- 只输出改写后的完整文本，不要任何解释、前缀或后缀。'
].join('\n');

const FORBIDDEN = [
  { p: '这不是我的责任', r: '我帮您核实并跟进处理' },
  { p: '这不是我的错', r: '我帮您核实并跟进处理' },
  { p: '不关我的事', r: '我帮您核实并跟进处理' },
  { p: '跟我没关系', r: '我帮您核实处理' },
  { p: '不关你的事', r: '这部分我来为您说明' },
  { p: '系统出bug了', r: '系统暂时出现异常' },
  { p: '系统出bug', r: '系统暂时出现异常' },
  { p: '系统出故障了', r: '系统暂时出现异常' },
  { p: '系统出故障', r: '系统暂时出现异常' },
  { p: '系统崩溃了', r: '系统暂时出现波动' },
  { p: '系统崩溃', r: '系统暂时出现波动' },
  { p: '系统崩了', r: '系统暂时出现波动' },
  { p: '服务器崩了', r: '服务器暂时出现波动' },
  { p: '你听不懂吗', r: '我再为您详细解释一遍' },
  { p: '你听不明白吗', r: '我再为您详细解释一遍' },
  { p: '听不明白吗', r: '我换个方式为您说明' },
  { p: '你到底想怎样', r: '请问您具体需要什么帮助呢' },
  { p: '你到底想干什么', r: '请问您具体需要什么帮助呢' },
  { p: '你自己弄错了吧', r: '我们一起核实一下情况' },
  { p: '自己看吧', r: '我为您说明一下' },
  { p: '自己查吧', r: '我为您说明一下' },
  { p: '别问我', r: '我帮您核实' },
  { p: '别烦我', r: '我为您处理' },
  { p: '别废话', r: '我为您说明' },
  { p: '爱办不办', r: '我们尽量为您处理' },
  { p: '爱信不信', r: '我为您说明情况' },
  { p: '你爱信不信', r: '我为您说明情况' },
  { p: '你爱怎么想就怎么想', r: '我为您说明情况' },
  { p: '随便你怎么投诉', r: '我们会认真处理您的反馈' },
  { p: '投诉也没用', r: '我们会认真处理您的反馈' },
  { p: '随便你', r: '我帮您确认一下' },
  { p: '随你便', r: '我帮您确认一下' },
  { p: '你看着办', r: '我帮您确认一下' },
  { p: '等着吧', r: '我们会尽快处理，请您耐心等待' },
  { p: '拉倒吧', r: '我们换个方式处理' },
  { p: '没辙', r: '我帮您想想其他办法' },
  { p: '没办法', r: '我帮您想想其他办法' },
  { p: '无能为力', r: '我帮您想想其他办法' },
  { p: '做不到', r: '我帮您看看有什么可以处理的方案' },
  { p: '办不了', r: '我帮您看看可以怎么处理' },
  { p: '处理不了', r: '我帮您看看可以怎么处理' },
  { p: '帮不了你', r: '我帮您看看其他途径' },
  { p: '这是不可能的', r: '这个情况目前还需要进一步核实' },
  { p: '不可能', r: '目前还需要进一步核实' },
  { p: '有本事你自己来', r: '我帮您处理' }
];

const { FORBIDDEN_RE, LOWERCASE_MAP } = (() => {
  const sorted = FORBIDDEN.slice().sort(function (a, b) { return b.p.length - a.p.length; });
  const map = new Map();
  for (let i = 0; i < sorted.length; i++) map.set(sorted[i].p, sorted[i].r);
  const lower = new Map();
  map.forEach(function (v, k) { lower.set(k.toLowerCase(), v); });
  const re = new RegExp(sorted.map(function (x) { return escapeRegExp(x.p); }).join('|'), 'gi');
  return { FORBIDDEN_RE: re, LOWERCASE_MAP: lower };
})();

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function applyDeterministic(text) {
  FORBIDDEN_RE.lastIndex = 0;
  let out = '';
  let last = 0;
  let changed = false;
  let m;
  while ((m = FORBIDDEN_RE.exec(text)) !== null) {
    out += text.slice(last, m.index);
    const rep = LOWERCASE_MAP.get(m[0].toLowerCase());
    out += rep || m[0];
    last = m.index + m[0].length;
    changed = true;
    if (m.index === FORBIDDEN_RE.lastIndex) FORBIDDEN_RE.lastIndex += 1;
  }
  out += text.slice(last);
  return { text: out, changed: changed };
}

function extractFacts(text) {
  const facts = new Set();
  const patterns = [
    /\d{4}\s*年\s*\d{1,2}\s*月(?:\s*\d{1,2}\s*日)?/g,
    /\d{1,2}\s*月\s*\d{1,2}\s*日/g,
    /\d{4}[-/.]\d{1,2}[-/.]\d{1,2}/g,
    /\d+(?:\.\d+)?\s*(?:元|块钱|块|角|分)/g,
    /\d{4,}/g
  ];
  for (let i = 0; i < patterns.length; i++) {
    const re = patterns[i];
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      facts.add(m[0].replace(/\s+/g, ''));
      if (m.index === re.lastIndex) re.lastIndex += 1;
    }
  }
  return facts;
}

function factsPreserved(original, candidate) {
  const facts = extractFacts(original);
  if (facts.size === 0) return true;
  const norm = String(candidate || '').replace(/\s+/g, '');
  const arr = Array.from(facts);
  for (let i = 0; i < arr.length; i++) {
    if (norm.indexOf(arr[i]) === -1) return false;
  }
  return true;
}

function matchSpan(text, s) {
  const t = s.text;
  if (typeof t !== 'string' || t.length === 0) return null;
  if (typeof s.start === 'number') {
    const start = Math.max(0, s.start);
    if (text.slice(start, start + t.length) === t) return { start: start, end: start + t.length };
  }
  let idx = text.indexOf(t);
  if (idx !== -1) return { start: idx, end: idx + t.length };
  const normText = text.replace(/\s+/g, '');
  const normT = t.replace(/\s+/g, '');
  if (normT.length === 0) return null;
  const ni = normText.indexOf(normT);
  if (ni !== -1) {
    let count = 0;
    let start = -1;
    for (let i = 0; i < text.length; i++) {
      if (/\s/.test(text[i])) continue;
      if (count === ni) { start = i; break; }
      count += 1;
    }
    if (start !== -1) {
      let end = -1;
      const target = ni + normT.length;
      count = 0;
      for (let i = start; i < text.length; i++) {
        if (/\s/.test(text[i])) continue;
        count += 1;
        if (count === target) { end = i + 1; break; }
      }
      if (end !== -1) return { start: start, end: end };
    }
  }
  return null;
}

function applySpans(text, spans) {
  const ops = [];
  for (let i = 0; i < spans.length; i++) {
    const s = spans[i];
    if (!s || typeof s.text !== 'string' || s.text.length === 0) continue;
    const match = matchSpan(text, s);
    if (!match) continue;
    ops.push({ start: match.start, end: match.end, replacement: typeof s.replacement === 'string' ? s.replacement : '' });
  }
  if (ops.length === 0) return null;
  ops.sort(function (a, b) { return a.start - b.start; });
  const clean = [];
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    const prev = clean[clean.length - 1];
    if (prev && op.start < prev.end) continue;
    clean.push(op);
  }
  let out = text;
  for (let i = clean.length - 1; i >= 0; i--) {
    const op = clean[i];
    out = out.slice(0, op.start) + op.replacement + out.slice(op.end);
  }
  return out;
}

function parseJSONLoose(text) {
  if (!text) return null;
  let s = String(text).trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start !== -1 && end > start) s = s.slice(start, end + 1);
  try { return JSON.parse(s); } catch (e) { return null; }
}

function markInternal(options) {
  if (options && typeof options === 'object') {
    try { internalCalls.add(options); } catch (e) {}
    try { options[INTERNAL] = true; } catch (e) {}
  }
}

function isInternal(options) {
  if (!options || typeof options !== 'object') return false;
  try {
    if (internalCalls.has(options)) return true;
    if (options[INTERNAL] === true) return true;
  } catch (e) {}
  if (typeof options.system === 'string' && options.system.indexOf(SENTINEL) !== -1) return true;
  return false;
}

function makeLLMOptions(system, userText) {
  const options = {
    provider: 'deepseek-official',
    model: 'deepseek-chat',
    reasoningEffort: 'off',
    system: SENTINEL + '\n' + system,
    messages: [{ role: 'user', content: [{ type: 'text', text: userText }], source: { kind: 'user' } }]
  };
  markInternal(options);
  return options;
}

async function collectText(stream) {
  let text = '';
  for await (const chunk of stream) {
    if (!chunk) continue;
    if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
      text += chunk.text;
    } else if (chunk.type === 'block-end' && chunk.block && chunk.block.type === 'text' && typeof chunk.block.text === 'string') {
      text = chunk.block.text;
    }
  }
  return text.split(SENTINEL).join('').trim();
}

function withTimeout(promise, ms) {
  if (!ms || ms <= 0) return promise;
  let timer = null;
  const timeout = new Promise(function (_, reject) {
    timer = setTimeout(function () { reject(new Error('jspace-a2 llm timeout')); }, ms);
  });
  return Promise.race([promise, timeout]).finally(function () { if (timer) clearTimeout(timer); });
}

async function askLLM(ctx, system, userText, timeoutMs) {
  const options = makeLLMOptions(system, userText);
  const stream = await ctx.llm.stream(options);
  return withTimeout(collectText(stream), timeoutMs);
}

async function judge(ctx, text) {
  const raw = await askLLM(ctx, JUDGE_SYSTEM, text, 15000);
  return parseJSONLoose(raw);
}

function stripQuotes(s) {
  const t = String(s || '').trim();
  if (t.length >= 2) {
    const first = t[0];
    const last = t[t.length - 1];
    if ((first === '"' && last === '"') ||
        (first === '\u201c' && last === '\u201d') ||
        (first === '\u2018' && last === '\u2019') ||
        (first === "'" && last === "'")) {
      return t.slice(1, -1).trim();
    }
  }
  return t;
}

async function rewrite(ctx, text) {
  const raw = await askLLM(ctx, REWRITE_SYSTEM, text, 20000);
  if (!raw) return '';
  return stripQuotes(raw.replace(/^```(?:text)?\s*/i, '').replace(/```\s*$/, ''));
}

async function processTextBlock(text, ctx, log) {
  if (!text) return { text: text, changed: false };
  const det = applyDeterministic(text);

  if (!ctx || !ctx.llm || typeof ctx.llm.stream !== 'function') {
    return det;
  }

  let verdict = null;
  try {
    verdict = await judge(ctx, text);
  } catch (e) {
    if (log) log('judge error: ' + (e && e.message));
  }

  if (verdict && verdict.forbidden === true) {
    if (Array.isArray(verdict.spans) && verdict.spans.length > 0) {
      const patched = applySpans(text, verdict.spans);
      if (patched !== null && patched !== text && factsPreserved(text, patched)) {
        const det2 = applyDeterministic(patched);
        if (log) log('span rewrite applied');
        return { text: det2.text, changed: true };
      }
    }
    try {
      const rewritten = await rewrite(ctx, text);
      if (rewritten && rewritten !== text) {
        const det3 = applyDeterministic(rewritten);
        const candidate = det3.text;
        if (factsPreserved(text, candidate)) {
          if (log) log('llm rewrite applied');
          return { text: candidate, changed: true };
        }
        if (log) log('llm rewrite dropped facts; fallback');
      }
    } catch (e) {
      if (log) log('rewrite error: ' + (e && e.message));
    }
    if (det.changed && factsPreserved(text, det.text)) return det;
    return { text: text, changed: false };
  }

  if (det.changed) return det;
  return { text: text, changed: false };
}

async function* transformStream(upstream, ctx, log) {
  let deltas = [];
  let blockIndex = null;

  async function* emitBlock(fullText, idx, endChunk) {
    let result;
    try {
      result = await processTextBlock(fullText, ctx, log);
    } catch (e) {
      if (log) log('process error: ' + (e && e.message));
      result = { text: fullText, changed: false };
    }
    if (result.changed && result.text !== fullText) {
      const base = deltas.length > 0 ? deltas[0] : { type: 'text-delta', index: idx };
      yield { ...base, type: 'text-delta', index: idx, text: result.text };
      if (endChunk) {
        const blk = endChunk.block || {};
        yield { ...endChunk, index: idx, block: { ...blk, type: 'text', text: result.text } };
      }
    } else {
      for (let i = 0; i < deltas.length; i++) yield deltas[i];
      if (endChunk) yield endChunk;
    }
    deltas = [];
    blockIndex = null;
  }

  for await (const chunk of upstream) {
    if (!chunk) continue;

    if (chunk.type === 'text-delta') {
      deltas.push(chunk);
      if (blockIndex === null) blockIndex = chunk.index;
      continue;
    }

    if (chunk.type === 'block-end' && chunk.block && chunk.block.type === 'text') {
      const fullText = typeof chunk.block.text === 'string'
        ? chunk.block.text
        : deltas.map(function (c) { return typeof c.text === 'string' ? c.text : ''; }).join('');
      const idx = chunk.index !== undefined ? chunk.index : blockIndex;
      yield* emitBlock(fullText, idx, chunk);
      continue;
    }

    if (deltas.length > 0) {
      const fullText = deltas.map(function (c) { return typeof c.text === 'string' ? c.text : ''; }).join('');
      yield* emitBlock(fullText, blockIndex, null);
    }
    yield chunk;
  }

  if (deltas.length > 0) {
    const fullText = deltas.map(function (c) { return typeof c.text === 'string' ? c.text : ''; }).join('');
    yield* emitBlock(fullText, blockIndex, null);
  }
}

function makeLogger(ctx) {
  try {
    if (ctx && ctx.logger) {
      if (typeof ctx.logger.info === 'function') {
        return function (msg) { try { ctx.logger.info('[jspace-a2] ' + msg); } catch (e) {} };
      }
      if (typeof ctx.logger.log === 'function') {
        return function (msg) { try { ctx.logger.log('[jspace-a2] ' + msg); } catch (e) {} };
      }
    }
  } catch (e) {}
  return null;
}

return {
  name: 'jspace-a2-forbidden-phrases',
  inject: ['llm'],
  apply: function (ctx) {
    const log = makeLogger(ctx);
    ctx.on('llm/stream', function (options, next) {
      if (isInternal(options)) {
        if (options && typeof options === 'object' && typeof options.system === 'string' && options.system.indexOf(SENTINEL) !== -1) {
          const cleanSystem = options.system.split(SENTINEL).join('').replace(/^\s*\n/, '');
          const cleanOptions = Object.assign({}, options, { system: cleanSystem });
          return next(cleanOptions);
        }
        return next(options);
      }
      let upstream;
      try {
        upstream = next(options);
      } catch (e) {
        if (log) log('next error: ' + (e && e.message));
        throw e;
      }
      if (!upstream) return upstream;
      const hasAsync = upstream[Symbol.asyncIterator] && typeof upstream[Symbol.asyncIterator] === 'function';
      const hasSync = upstream[Symbol.iterator] && typeof upstream[Symbol.iterator] === 'function';
      if (!hasAsync && !hasSync) return upstream;
      return transformStream(upstream, ctx, log);
    });
  }
};