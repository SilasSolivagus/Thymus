const INTERNAL_MARK = '__a2_service_forbidden_words_internal__';

const FORBIDDEN_PHRASES = [
  '不可能', '做不到', '没办法', '没有办法', '无法做到', '无法解决', '办不到', '办不了',
  '帮不了', '帮不了你', '无能为力',
  '这不是我的责任', '不是我的责任', '不归我管', '不归我们管', '跟我没关系', '跟我们没关系',
  '与我无关', '与我们无关', '别找我', '你找别人', '你去找别人',
  '系统崩了', '系统出bug了', '系统出bug', '系统出问题了', '系统故障', '系统崩溃', '系统挂了',
  '系统坏了', '系统异常', '服务器崩了', '服务器挂了', '服务器出问题了', '平台崩了', '平台出bug了',
  '网站崩了', '网站出bug了',
  '你听不懂吗', '你听不明白吗', '听不懂吗', '听不明白吗', '我说得不够清楚吗', '你怎么还不明白',
  '你理解能力有问题', '你烦不烦', '别问了', '别再问了', '你爱信不信', '随便你',
  '我们也没办法', '我也没办法', '谁都没办法', '我不管'
];

const FORBIDDEN_REGEX = [
  /你.{0,8}(?:听不懂|不明白|不理解|听不明白).{0,6}吗/,
  /(?:系统|服务器|平台|网站|网络|设备).{0,5}(?:崩了|挂了|坏了|出bug|出Bug|出故障|故障了|崩溃|异常|出问题)/,
  /(?:这|那|这都).{0,4}(?:不是|不归|不关).{0,4}(?:我的责任|我管|我们管|我们的事|我的事)/,
  /(?:怪|赖)(?:我们|我|系统|别人|他们)/
];

const REPLACEMENTS = {
  '不可能': '目前暂时无法实现，我们会尽力协助您',
  '做不到': '目前暂时无法做到，我们会帮您想办法',
  '没办法': '我们一起想办法解决',
  '没有办法': '我们一起想办法解决',
  '无法做到': '我们会尽力协助您',
  '无法解决': '我们会尽力协助您',
  '办不到': '目前暂时无法办理，我们会帮您协调',
  '办不了': '目前暂时无法办理，我们会帮您协调',
  '帮不了': '我会尽力协助您',
  '帮不了你': '我会尽力协助您',
  '无能为力': '我会尽力协助您',
  '这不是我的责任': '我理解您的情况，我来帮您协调处理',
  '不是我的责任': '我理解您的情况，我来帮您协调处理',
  '不归我管': '我帮您转接给负责的同事处理',
  '不归我们管': '我帮您转接给负责的同事处理',
  '跟我没关系': '我来帮您核实处理',
  '跟我们没关系': '我们来帮您核实处理',
  '与我无关': '我来帮您核实处理',
  '与我们无关': '我们来帮您核实处理',
  '别找我': '我来帮您处理',
  '系统崩了': '系统暂时出现异常',
  '系统出bug了': '系统暂时出现异常',
  '系统出bug': '系统暂时出现异常',
  '系统出问题了': '系统暂时出现异常',
  '系统故障': '系统暂时出现异常',
  '系统崩溃': '系统暂时出现异常',
  '系统挂了': '系统暂时出现异常',
  '系统坏了': '系统暂时出现异常',
  '系统异常': '系统暂时出现异常',
  '服务器崩了': '服务器暂时出现异常',
  '服务器挂了': '服务器暂时出现异常',
  '服务器出问题了': '服务器暂时出现异常',
  '平台崩了': '平台暂时出现异常',
  '平台出bug了': '平台暂时出现异常',
  '网站崩了': '网站暂时出现异常',
  '网站出bug了': '网站暂时出现异常',
  '你听不懂吗': '我再为您详细说明一下',
  '你听不明白吗': '我再为您详细说明一下',
  '听不懂吗': '我再为您详细说明一下',
  '听不明白吗': '我再为您详细说明一下',
  '我说得不够清楚吗': '我换一种方式再为您说明',
  '你怎么还不明白': '我换一种方式再为您说明',
  '你理解能力有问题': '我换一种方式为您解释',
  '我们也没办法': '我们会尽力为您协调',
  '我也没办法': '我会尽力为您协调',
  '谁都没办法': '我们会尽力为您协调',
  '我不管': '我来帮您处理'
};

const JUDGE_SYSTEM = `你是校园网客服话术的合规审查员。你的任务是判断一段客服发给用户的话是否合规。
不合规的情况包括：
1. 态度消极：如「不可能」「做不到」「没办法」等放弃、消极的表达；
2. 强势质问：如「你听不懂吗」「你怎么还不明白」等质疑、指责用户的表达；
3. 甩锅推诿：如「这不是我的责任」「系统崩了」「系统出bug了」等推卸责任的表达。

只判断，不要改写。只输出 JSON 对象，格式为 {"has_issue": true} 或 {"has_issue": false}，不要输出任何其他内容。`;

const REWRITE_SYSTEM = `你是校园网客服话术改写助手。你需要把一段客服发给用户的话改写得更合规。
要求：
1. 去掉态度消极、强势质问、甩锅推诿等表达，改为积极、负责、有帮助的语气；
2. 事实信息（金额、日期、账期、需要用户提供的材料、业务规则、账号等）必须原样保留，不能丢失、不能改变、不能新增；
3. 金额、日期、数字一律保持阿拉伯数字和原格式，不得改成中文数字；
4. 如果原文要求用户提供材料或信息（如证件、证明、材料、账号等），必须保留这些要求，不能删除或改变；
5. 不要编造原文没有的信息或承诺；
6. 只输出改写后的完整话术，不要任何解释、前缀或后缀。`;

function detectHeuristic(text) {
  const hits = new Set();
  for (const p of FORBIDDEN_PHRASES) {
    if (text.includes(p)) hits.add(p);
  }
  for (const re of FORBIDDEN_REGEX) {
    const m = text.match(re);
    if (m) hits.add(m[0]);
  }
  return Array.from(hits);
}

function looksSuspicious(text) {
  if (/(?:不可能|做不到|没办法|没有办法|无法|办不到|办不了|帮不了|无能为力|没法|没辙|不行|不能)/.test(text)) return true;
  if (/(?:责任|不归我|不归我们|跟我没关系|与我们无关|不是我的|别找我|找别人|推卸|甩锅|怪我|赖我|赖我们|系统|服务器|平台|网站|崩|挂|坏|bug|Bug|故障|异常|出问题)/.test(text)) return true;
  if (/(?:听不懂|不明白|理解能力|还不懂|烦不烦|别问|别再问|爱信不信|随便你|说几遍|听清楚|明白吗|懂吗)/.test(text)) return true;
  if (/[?？]/.test(text) && /(?:不|没|懂|明白|理解|为什么|怎么|凭什么)/.test(text)) return true;
  return false;
}

function normalizeFact(s) {
  return String(s).replace(/\s+/g, '').replace(/(^|\D)0+(\d)/g, '$1$2');
}

function extractFacts(text) {
  const strong = new Set();
  const all = new Set();
  const patterns = [
    { re: /\d{4}\s*年\s*\d{1,2}\s*月(?:\s*\d{1,2}\s*日)?/g, strong: true },
    { re: /\d{1,2}\s*月\s*\d{1,2}\s*日/g, strong: true },
    { re: /\d+(?:\.\d+)?\s*(?:元|块钱|块|毛|角|分|折|GB|G|MB|M|兆|天|日|小时|分钟|年|月|周|号)/gi, strong: true },
    { re: /\d{3,}(?:\.\d+)?/g, strong: false },
    { re: /\d+\.\d+/g, strong: false }
  ];
  for (const { re, strong: isStrong } of patterns) {
    let m;
    while ((m = re.exec(text))) {
      const t = normalizeFact(m[0]);
      all.add(t);
      if (isStrong) strong.add(t);
    }
  }
  return { strong: Array.from(strong), all: Array.from(all) };
}

function factsPreserved(original, rewritten) {
  const { all } = extractFacts(original);
  if (all.length === 0) return true;
  const norm = normalizeFact(rewritten);
  for (const f of all) {
    if (norm.indexOf(f) < 0) return false;
  }
  return true;
}

function splitText(text, parts) {
  if (parts <= 1) return [text];
  const res = [];
  const len = text.length;
  let start = 0;
  for (let i = 0; i < parts; i++) {
    const end = i === parts - 1 ? len : Math.round(len * (i + 1) / parts);
    res.push(text.slice(start, end));
    start = end;
  }
  return res;
}

function replaceHits(text, hits) {
  let out = text;
  const sorted = Array.from(new Set(hits)).sort((a, b) => b.length - a.length);
  for (const h of sorted) {
    const rep = REPLACEMENTS[h];
    if (rep) out = out.split(h).join(rep);
  }
  return out;
}

function parseJsonLoose(text) {
  if (!text) return null;
  let t = String(text).replace(/```(?:json)?/gi, '').trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(t.slice(start, end + 1));
    } catch (e) { /* ignore */ }
  }
  return null;
}

async function callLLM(ctx, system, userText) {
  if (!ctx.llm || typeof ctx.llm.stream !== 'function') return null;
  const opts = {
    provider: 'deepseek-official',
    model: 'deepseek-chat',
    reasoningEffort: 'off',
    system,
    messages: [{
      role: 'user',
      content: [{ type: 'text', text: userText }],
      source: { kind: 'user' }
    }]
  };
  opts[INTERNAL_MARK] = true;
  try {
    const stream = ctx.llm.stream(opts);
    let out = '';
    for await (const chunk of stream) {
      if (chunk.type === 'text-delta') out += chunk.text || '';
      else if (chunk.type === 'block-end' && chunk.block && chunk.block.type === 'text') out += chunk.block.text || '';
    }
    return out.trim();
  } catch (e) {
    return null;
  }
}

async function judge(ctx, text) {
  const user = `待判断的客服话术：\n"""\n${text}\n"""`;
  const out = await callLLM(ctx, JUDGE_SYSTEM, user);
  if (out == null) return false;
  const obj = parseJsonLoose(out);
  if (obj && typeof obj.has_issue === 'boolean') return obj.has_issue;
  if (/true/i.test(out)) return true;
  if (/false/i.test(out)) return false;
  return false;
}

async function rewrite(ctx, text, facts, extraNote) {
  let user = `原文话术：\n"""\n${text}\n"""`;
  if (facts && facts.length) {
    user += `\n\n改写时必须原样保留以下事实：${facts.join('、')}`;
  }
  if (extraNote) {
    user += `\n\n${extraNote}`;
  }
  return await callLLM(ctx, REWRITE_SYSTEM, user);
}

async function checkAndFix(ctx, text) {
  if (!text || !text.trim()) return text;

  const hits = detectHeuristic(text);
  let needsRewrite = hits.length > 0;
  if (!needsRewrite && looksSuspicious(text)) {
    needsRewrite = await judge(ctx, text);
  }
  if (!needsRewrite) return text;

  const facts = extractFacts(text);
  const factsForPrompt = facts.strong.length ? facts.strong : facts.all;
  const extraNote = hits.length
    ? `特别注意：原文中的「${hits[0]}」${hits.length > 1 ? '等' : ''}表达属于禁语，必须改写替换掉，不能保留。`
    : '';

  const stillHasHits = (rw) => rw != null && hits.some(h => rw.includes(h));
  const acceptable = (rw) => rw != null && rw !== text && !stillHasHits(rw) && factsPreserved(text, rw);

  let rewritten = await rewrite(ctx, text, factsForPrompt, extraNote);
  if (acceptable(rewritten)) return rewritten;

  rewritten = await rewrite(ctx, text, factsForPrompt, extraNote + ' 上一版改写不合格（仍含禁语，或丢失/改变了事实信息），请务必逐字保留所有数字、日期、金额和材料信息，并彻底去掉消极、质问、甩锅类表达。');
  if (acceptable(rewritten)) return rewritten;

  if (hits.length > 0) {
    const patched = replaceHits(text, hits);
    if (patched !== text && !stillHasHits(patched) && factsPreserved(text, patched)) return patched;
  }
  return text;
}

async function processChunks(ctx, chunks) {
  const groups = new Map();
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    if (c.type === 'text-delta') {
      const key = c.index;
      if (!groups.has(key)) groups.set(key, { deltas: [], blockEnd: -1 });
      groups.get(key).deltas.push(i);
    } else if (c.type === 'block-end' && c.block && c.block.type === 'text') {
      const key = c.index;
      if (!groups.has(key)) groups.set(key, { deltas: [], blockEnd: -1 });
      groups.get(key).blockEnd = i;
    }
  }
  if (groups.size === 0) return chunks;

  const replacements = new Map();
  for (const [, group] of groups) {
    let blockText = '';
    if (group.blockEnd >= 0) {
      blockText = (chunks[group.blockEnd].block && chunks[group.blockEnd].block.text) || '';
    } else {
      blockText = group.deltas.map(i => chunks[i].text || '').join('');
    }
    if (!blockText || !blockText.trim()) continue;

    let fixed = blockText;
    try {
      fixed = await checkAndFix(ctx, blockText);
    } catch (e) {
      fixed = blockText;
    }
    if (fixed === blockText) continue;

    const n = Math.max(1, group.deltas.length);
    const parts = splitText(fixed, n);
    group.deltas.forEach((pos, k) => {
      replacements.set(pos, { ...chunks[pos], text: parts[k] || '' });
    });
    if (group.blockEnd >= 0) {
      const orig = chunks[group.blockEnd];
      replacements.set(group.blockEnd, {
        ...orig,
        block: { ...(orig.block || {}), type: 'text', text: fixed }
      });
    }
  }

  if (replacements.size === 0) return chunks;
  const out = [];
  for (let i = 0; i < chunks.length; i++) {
    out.push(replacements.has(i) ? replacements.get(i) : chunks[i]);
  }
  return out;
}

return {
  name: 'a2-service-forbidden-words-guard',
  inject: ['llm'],
  apply(ctx) {
    ctx.on('llm/stream', (options, next) => {
      if (options && options[INTERNAL_MARK]) {
        return next();
      }
      const upstream = next();
      if (!upstream) {
        return (async function* () { /* empty */ })();
      }
      return (async function* () {
        const chunks = [];
        for await (const chunk of upstream) {
          chunks.push(chunk);
        }
        const out = await processChunks(ctx, chunks);
        yield* out;
      })();
    });
  }
};
