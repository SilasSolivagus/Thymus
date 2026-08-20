const INTERNAL_MARK = '__a2_service_forbidden_words_internal__';

const FORBIDDEN_PHRASES = [
  // SOP 示例
  '不可能', '做不到', '没办法', '没有办法', '无法做到', '无法解决', '办不到', '办不了',
  '帮不了', '帮不了你', '无能为力',
  '这不是我的责任', '不是我的责任', '不归我管', '不归我们管', '跟我没关系', '跟我们没关系',
  '与我无关', '与我们无关', '别找我', '你找别人', '你去找别人',
  '系统崩了', '系统出bug了', '系统出bug', '系统出问题了', '系统故障', '系统崩溃', '系统挂了',
  '系统坏了', '系统异常', '服务器崩了', '服务器挂了', '服务器出问题了', '平台崩了', '平台出bug了',
  '网站崩了', '网站出bug了',
  '你听不懂吗', '你听不明白吗', '听不懂吗', '听不明白吗', '我说得不够清楚吗', '你怎么还不明白',
  '你理解能力有问题', '你烦不烦', '别问了', '别再问了', '你爱信不信', '随便你',
  '我们也没办法', '我也没办法', '谁都没办法', '我不管',
  // 消极 / 敷衍 / 放弃 同义
  '爱办不办', '爱咋咋地', '爱咋地咋地', '爱怎么着怎么着', '爱怎么样就怎么样', '随你便',
  '你看着办', '你自己看着办', '算了吧', '算了', '拉倒吧', '拉倒',
  '修不好', '修不了', '弄不好', '搞不定', '搞不了', '整不了', '处理不了', '解决不了',
  '没法弄', '没辙', '没救', '没指望', '不管了', '懒得管', '不想管', '放弃吧', '别指望了',
  '你开心就好', '随你怎么想', '爱莫能助',
  // 归咎 / 甩锅 / 推诿 同义
  '怪谁', '赖谁', '怨谁', '能怪谁', '怪你', '怪你自己', '都怪你', '都赖你', '全怪你', '全赖你',
  '别怪我', '别赖我', '不赖我', '别怨我', '不是我的问题', '不是我们的问题',
  '是你自己', '谁让你', '谁叫你', '你自己没', '你自己不',
  '不关我事', '不关我的事', '不关我们的事', '我哪知道', '我怎么知道', '你问我我问谁',
  '你自己想办法', '你自己解决'
];

const FORBIDDEN_REGEX = [
  /你.{0,8}(?:听不懂|不明白|不理解|听不明白).{0,6}吗/,
  /(?:系统|服务器|平台|网站|网络|设备).{0,5}(?:崩了|挂了|坏了|宕机|出bug|出Bug|出故障|故障了|崩溃|出问题|出毛病)/,
  /(?:这|那|这都).{0,4}(?:不是|不归|不关).{0,4}(?:我的责任|我管|我们管|我们的事|我的事)/,
  /爱.{0,6}(?:不|咋|怎么)/,
  /(?:修|弄|搞|整|处理|解决)(?:不|无)(?:好|了|定|掉|完|成)/,
  /(?:怪|赖|怨)(?:谁|你|我|我们|别人|用户|对方|人家)/,
  /(?:都怪|都赖|全怪|全赖)(?:你|我|他|她|用户|别人)/,
  /(?:别怪|别赖|别怨)(?:我|我们|别人)/,
  /(?:是你自己|谁让你|谁叫你|谁叫你先|当初是你|都是你|你自己)(?:没|不|忘|错|太|这么|那样).{0,10}/,
  /(?:没|无)(?:辙|救|指望|办法|招)/,
  /(?:算了|算了吧|随你便|你看着办|拉倒吧|拉倒)/,
  /(?:不关|不干)(?:我|我们)(?:的)?事/,
  /(?:我哪知道|我怎么知道|你问我我问谁)/
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
  '我不管': '我来帮您处理',
  '爱办不办': '我们会尊重您的选择，也会尽力为您提供帮助',
  '爱咋咋地': '我们会尊重您的选择，也会尽力为您提供帮助',
  '爱咋地咋地': '我们会尊重您的选择，也会尽力为您提供帮助',
  '爱怎么着怎么着': '我们会尊重您的选择，也会尽力为您提供帮助',
  '爱怎么样就怎么样': '我们会尊重您的选择，也会尽力为您提供帮助',
  '随你便': '我们会尊重您的选择，也会尽力为您提供帮助',
  '你看着办': '您看这样处理是否合适，我们会尽力配合',
  '你自己看着办': '您看这样处理是否合适，我们会尽力配合',
  '算了吧': '我们继续帮您想办法',
  '算了': '我们继续帮您想办法',
  '拉倒吧': '我们继续帮您想办法',
  '拉倒': '我们继续帮您想办法',
  '修不好': '我们会尽力帮您修复',
  '修不了': '我们会尽力帮您修复',
  '弄不好': '我们会尽力帮您处理',
  '搞不定': '我们会尽力帮您处理',
  '搞不了': '我们会尽力帮您处理',
  '整不了': '我们会尽力帮您处理',
  '处理不了': '我们会尽力为您处理',
  '解决不了': '我们会尽力为您解决',
  '没法弄': '我们会尽力帮您处理',
  '没辙': '我们会继续帮您想办法',
  '没救': '我们会继续帮您想办法，请不要灰心',
  '没指望': '我们会继续帮您想办法，请不要灰心',
  '不管了': '我们会继续跟进处理',
  '懒得管': '我们会继续跟进处理',
  '不想管': '我们会继续跟进处理',
  '放弃吧': '我们会继续帮您想办法，请不要灰心',
  '别指望了': '我们会继续帮您想办法，请不要灰心',
  '你开心就好': '我们会尊重您的意见，也会尽力为您服务',
  '随你怎么想': '我们会尊重您的意见，也会尽力为您服务',
  '爱莫能助': '我们会尽力协助您',
  '怪谁': '我们一起看看怎么处理',
  '赖谁': '我们一起看看怎么处理',
  '怨谁': '我们一起看看怎么处理',
  '能怪谁': '我们一起看看怎么处理',
  '怪你': '我们一起看看怎么处理',
  '怪你自己': '我们一起看看怎么处理',
  '都怪你': '我们一起看看怎么处理',
  '都赖你': '我们一起看看怎么处理',
  '全怪你': '我们一起看看怎么处理',
  '全赖你': '我们一起看看怎么处理',
  '别怪我': '我会尽力帮您处理',
  '别赖我': '我会尽力帮您处理',
  '不赖我': '我会尽力帮您处理',
  '别怨我': '我会尽力帮您处理',
  '不是我的问题': '我会尽力帮您核实处理',
  '不是我们的问题': '我们会尽力帮您核实处理',
  '不关我事': '我会尽力帮您处理',
  '不关我的事': '我会尽力帮您处理',
  '不关我们的事': '我们会尽力帮您处理',
  '我哪知道': '我来帮您核实一下',
  '我怎么知道': '我来帮您核实一下',
  '你问我我问谁': '我来帮您核实一下',
  '你自己想办法': '我们一起看看怎么处理',
  '你自己解决': '我们一起看看怎么处理'
};

const GENERIC_PATTERNS = [
  { re: /(?:是你自己|谁让你|谁叫你|谁叫你先|当初是你|都是你|你自己)(?:没|不|忘|错|太|这么|那样)/, rep: '我们一起看看怎么处理' },
  { re: /(?:是你自己|谁让你|谁叫你|当初是你|都是你|你自己)/, rep: '我们一起看看怎么处理' },
  { re: /(?:怪|赖|怨)(?:谁|你|我|我们|别人|用户|对方|人家)/, rep: '我们一起看看怎么处理' },
  { re: /爱.{0,6}(?:不|咋|怎么)/, rep: '我们会尊重您的选择，也会尽力为您提供帮助' },
  { re: /(?:算了|算了吧|随你便|随你|你看着办|拉倒吧|拉倒|爱信不信)/, rep: '我们会继续帮您想办法' },
  { re: /(?:修|弄|搞|整|处理|解决)(?:不|无)(?:好|了|定|掉|完|成)/, rep: '我们会尽力帮您处理' },
  { re: /(?:没|无)(?:辙|救|指望|办法|招)/, rep: '我们会继续帮您想办法' },
  { re: /(?:不关|不干)(?:我|我们)(?:的)?事/, rep: '我会尽力帮您处理' }
];

const JUDGE_SYSTEM = `你是校园网客服话术的合规审查员。你的任务是判断一段客服发给用户的话是否合规。
不合规的情况包括：
1. 态度消极、敷衍、放弃：如「不可能」「做不到」「没办法」「修不好」「爱办不办」「随便你」「算了吧」等；
2. 强势质问：如「你听不懂吗」「你怎么还不明白」等质疑、指责用户的表达；
3. 甩锅、归咎、推诿：如「这不是我的责任」「系统崩了」「系统出bug了」「怪谁」「是你自己没…」等。

只有当话术确实存在上述问题时才判定有问题，正常、中性、积极的话术不要误判。
只判断，不要改写。只输出 JSON 对象：{"has_issue": true} 或 {"has_issue": false}，不要输出任何其他内容。`;

const REWRITE_SYSTEM = `你是校园网客服话术改写助手。你需要把一段客服发给用户的话改写得更合规。
要求：
1. 去掉态度消极、敷衍放弃（如「不可能」「修不好」「爱办不办」「随便你」「算了吧」）、强势质问（如「你听不懂吗」）、甩锅归咎（如「这不是我的责任」「系统崩了」「怪谁」「是你自己没…」）等表达，改为积极、负责、有帮助的语气；
2. 事实信息（金额、日期、账期、需要用户提供的材料、业务规则、账号等）必须原样保留，不能丢失、不能改变、不能新增；
3. 金额、日期、数字一律保持阿拉伯数字和原格式，不得改成中文数字；
4. 如果原文要求用户提供材料或信息（如证件、证明、材料、账号等），必须保留这些要求，不能删除或改变；
5. 不要编造原文没有的信息或承诺，不要指责用户；
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

function genericReplacementFor(h) {
  for (const { re, rep } of GENERIC_PATTERNS) {
    if (re.test(h)) return rep;
  }
  return null;
}

function replaceHits(text, hits) {
  let out = text;
  const sorted = Array.from(new Set(hits)).sort((a, b) => b.length - a.length);
  for (const h of sorted) {
    const rep = REPLACEMENTS[h] || genericReplacementFor(h);
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
  if (hits.length === 0) {
    // 无精确命中时，用模型做语义兜底，覆盖“无精确边界”的同义表达
    let hasIssue = false;
    try {
      hasIssue = await judge(ctx, text);
    } catch (e) {
      hasIssue = false;
    }
    if (!hasIssue) return text;
  }

  const facts = extractFacts(text);
  const factsForPrompt = facts.strong.length ? facts.strong : facts.all;
  const extraNote = hits.length
    ? `特别注意：原文中的「${hits[0]}」${hits.length > 1 ? '等' : ''}表达属于禁语，必须改写替换掉，不能保留。`
    : '';

  const acceptable = (rw) => rw != null && rw !== text && detectHeuristic(rw).length === 0 && factsPreserved(text, rw);

  let rewritten = await rewrite(ctx, text, factsForPrompt, extraNote);
  if (acceptable(rewritten)) return rewritten;

  rewritten = await rewrite(ctx, text, factsForPrompt, extraNote + ' 上一版改写不合格（仍含禁语，或丢失/改变了事实信息），请务必逐字保留所有数字、日期、金额和材料信息，并彻底去掉消极、敷衍、质问、甩锅、归咎类表达。');
  if (acceptable(rewritten)) return rewritten;

  if (hits.length > 0) {
    const patched = replaceHits(text, hits);
    if (patched !== text && detectHeuristic(patched).length === 0 && factsPreserved(text, patched)) return patched;
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
