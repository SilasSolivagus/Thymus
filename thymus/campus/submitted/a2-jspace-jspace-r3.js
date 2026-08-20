// A2 服务禁语约束：拦截 agent 流式输出，改写态度消极/强势质问/甩锅推诿表达，并保证事实信息原样保留。
const INTERNAL = Symbol('jspace.a2.internal');
const SENTINEL = '[jspace-a2-internal]';
let internalActive = false;

// 本地确定性替换（SOP 明确举例的禁语，保底处理，不依赖模型）
const REPLACEMENTS = [
  [/不可能/g, '我们尽量帮您协调'],
  [/做不到/g, '我们可以尝试其他方式'],
  [/没办法/g, '我们可以一起想办法'],
  [/没法子/g, '我们可以一起想办法'],
  [/这不是我的责任/g, '我来帮您联系相关同事处理'],
  [/这不是我的问题/g, '我来帮您协调处理'],
  [/不关我的事/g, '我来帮您协调处理'],
  [/这跟我没关系/g, '我帮您转给相关同事'],
  [/这跟我无关/g, '我帮您转给相关同事'],
  [/不归我管/g, '我来帮您联系相关同事'],
  [/不归我们管/g, '我来帮您联系相关部门'],
  [/系统(?:崩了|崩溃|瘫了|挂掉了|出\s*bug了|出\s*bug|出故障了|出问题了)/gi, '系统暂时出现异常，我们正在处理'],
  [/你听不懂吗/g, '我换一种方式为您说明'],
  [/你听不明白吗/g, '我换一种方式为您说明'],
  [/你(?:是不是)?(?:听|看)(?:不|没)(?:懂|明白)/g, '我再为您解释一遍'],
  [/爱信不信/g, '以上信息供您参考'],
  [/别烦我/g, '我们尽快为您解决'],
  [/你怎么这么笨/g, '我来帮您理清'],
  [/我说了多少遍(?:了)?/g, '我再次为您说明'],
  [/你自己(?:看着办|想办法)/g, '您可以参考以下建议'],
  [/关我什么事/g, '我来帮您协调处理'],
  [/关你什么事/g, '我来说明一下'],
  [/你烦不烦/g, '我尽快为您说明'],
];

// 语义疑点：命中则调用内部模型做语义级检查/改写（无精确边界的那部分）
const SUSPICION = /不可能|做不到|没办法|没法子|没辙|无能为力|爱莫能助|帮不了|处理不了|解决不了|管不了|做不了|搞不了|没戏|没门|休想|想得美|白搭|拉倒|一边去|少废话|(?:无法|不能|没法|很难)(?:帮您|帮你们|处理|解决|满足|做到|办理)|不是我的(?:责任|问题)|不关我(?:的)?事|跟我没关系|跟我无关|不归我管|不归我们管|随便你(?:们)?|爱信不信|自己(?:看着办|想办法|去|联系|找)|听不懂|听不明白|还不够清楚|听清楚了没|明白了没|别烦|我不管|关我什么事|关你什么事|你烦不烦|别再来|不要再来|真麻烦|很麻烦|系统(?:崩了|崩溃|瘫了|挂掉|出\s*bug|出\s*bug了|出问题|故障)|负不了责|嫌麻烦|不耐烦|顾不上|找别人|去找|我哪知道|我怎么知道|你问我我问谁|谁知道|爱怎么|爱咋|随你/i;

// 事实信息关键词（账期、金额、材料等，改写后必须原样保留）
const FACT_KEYWORDS = ['身份证','学号','校园卡','缴费凭证','订单号','工单号','手机号','银行卡','账户','账号','姓名','密码','验证码','邮箱','材料','证明','截图','账单','账期','金额','余额','套餐','宽带','学籍','宿舍','楼栋'];

const SYSTEM_PROMPT = [
  '你是校园网客服的合规审核助手。下面是一段客服 agent 即将发送给用户的回复文本。',
  '任务：检查其中是否存在「态度消极、强势质问、甩锅推诿」类的表达，例如：不可能、做不到、没办法、这不是我的责任、系统崩了、系统出bug了、你听不懂吗，以及类似的推卸责任、质问用户、消极应付的表述。',
  '规则：',
  '1. 如果不存在上述违规表达：必须原样输出这段文本，一个字都不要改。',
  '2. 如果存在：只把违规的部分改写为积极、负责、礼貌、愿意协助的表达；其余内容尽量保持原样。',
  '3. 所有事实信息必须原样保留，不得丢失或改变：包括账期、日期、金额、费用、用户需要提供的材料、办理时限、政策条款、单号等。',
  '4. 不得新增原文没有的事实、承诺或政策。',
  '5. 直接输出改写后的完整文本，不要任何解释、前缀、后缀或 Markdown 代码块。',
  SENTINEL,
].join('\n');

function localFix(text) {
  let out = text;
  for (const [re, to] of REPLACEMENTS) {
    out = out.replace(re, to);
  }
  return out;
}

function looksSuspicious(text) {
  return SUSPICION.test(text);
}

function extractFactTokens(text) {
  const tokens = new Set();
  const patterns = [
    /(?:￥|¥|RMB)?\s*\d+(?:\.\d+)?\s*(?:元|块钱|人民币|万元)/g,
    /\d{4}\s*年\s*\d{1,2}\s*月(?:\s*\d{1,2}\s*日)?/g,
    /\d{1,2}\s*月\s*\d{1,2}\s*日/g,
    /\d{4}[-/]\d{1,2}[-/]\d{1,2}/g,
    /\d{6,}/g,
  ];
  for (const p of patterns) {
    for (const m of text.matchAll(p)) {
      tokens.add(m[0].replace(/\s+/g, ''));
    }
  }
  for (const kw of FACT_KEYWORDS) {
    if (text.includes(kw)) tokens.add(kw);
  }
  return [...tokens];
}

// 事实信息必须原样保留：原文中的数字/日期/金额/材料关键词必须全部出现在改写结果里
function preserveFacts(orig, cand) {
  return extractFactTokens(orig).every((t) => cand.includes(t));
}

// 防止内部模型返回退化结果（过短、过长、与原文毫无关联）
function isPlausibleRewrite(orig, cand) {
  if (typeof cand !== 'string' || cand.length === 0) return false;
  const minLen = Math.min(8, Math.max(2, Math.floor(orig.length * 0.5)));
  if (cand.length < minLen) return false;
  const maxLen = Math.max(orig.length * 3 + 300, 500);
  if (cand.length > maxLen) return false;
  const os = new Set(orig.replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, ''));
  if (os.size === 0) return true;
  const cs = cand.replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '');
  for (const ch of cs) {
    if (os.has(ch)) return true;
  }
  return false;
}

// 内部模型调用：走 ctx.llm.stream，同样会撞回本 handler，必须防递归
async function callLLM(text, ctx) {
  const options = {
    provider: 'deepseek-official',
    model: 'deepseek-chat',
    reasoningEffort: 'off',
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }],
  };
  options[INTERNAL] = true; // 标记：本 handler 看到后直接放行
  let out = '';
  internalActive = true; // 双保险：即使 options 被克隆/重建丢标记也能防递归
  try {
    const stream = await ctx.llm.stream(options);
    for await (const chunk of stream) {
      if (!chunk || typeof chunk !== 'object') continue;
      if (chunk.type === 'text-delta') out += (chunk.text || '');
      else if (chunk.type === 'block-end' && chunk.block && chunk.block.type === 'text') out += (chunk.block.text || '');
    }
  } finally {
    internalActive = false;
  }
  return out.trim();
}

async function sanitize(text, ctx) {
  const fixed = localFix(text);
  const canLLM = !!(ctx && ctx.llm && typeof ctx.llm.stream === 'function');
  const needLLM = canLLM && (fixed !== text || looksSuspicious(fixed));
  if (!needLLM) return fixed;
  try {
    const rewritten = await callLLM(text, ctx);
    if (typeof rewritten === 'string' && rewritten.length > 0) {
      const candidate = localFix(rewritten);
      if (preserveFacts(text, candidate) && isPlausibleRewrite(text, candidate)) {
        return candidate;
      }
    }
  } catch (e) {
    // 内部模型调用失败时退回本地替换结果
  }
  return fixed;
}

// 合成 chunk 必须带上原 chunk 的 index，否则下游会当成新的一块
function* emitRewritten(pending, newText) {
  const first = pending.find((c) => c && c.type === 'text-delta');
  const last = pending[pending.length - 1];
  const idx = (first && typeof first.index !== 'undefined')
    ? first.index
    : (last && typeof last.index !== 'undefined' ? last.index : 0);
  yield { type: 'text-delta', index: idx, text: newText };
  if (last && last.type === 'block-end') {
    yield { ...last, block: { ...(last.block || {}), type: 'text', text: newText } };
  }
}

async function computeFlush(pending, buffer, ctx) {
  const inputText = buffer;
  let result;
  try {
    result = await sanitize(inputText, ctx);
  } catch (e) {
    result = inputText;
  }
  if (result === inputText) return pending.slice();
  return [...emitRewritten(pending, result)];
}

async function* transformStream(upstream, ctx) {
  if (!upstream) return;
  let buffer = '';
  let pending = [];

  try {
    for await (const chunk of upstream) {
      if (!chunk || typeof chunk !== 'object') {
        yield chunk;
        continue;
      }
      if (chunk.type === 'text-delta') {
        buffer += (chunk.text || '');
        pending.push(chunk);
      } else if (chunk.type === 'block-end' && chunk.block && chunk.block.type === 'text') {
        const blockText = chunk.block.text || '';
        if (blockText) {
          if (buffer && blockText.includes(buffer) && blockText.length >= buffer.length) {
            buffer = blockText; // block.text 是完整文本
          } else if (buffer && buffer.includes(blockText)) {
            // block.text 只是片段，已包含在 buffer 中
          } else {
            buffer += blockText;
          }
        }
        pending.push(chunk);
        const out = await computeFlush(pending, buffer, ctx);
        for (const c of out) yield c;
        buffer = '';
        pending = [];
      } else {
        // 非文本 chunk 原样透传；若中间夹着已缓冲的文本，先处理以保持顺序
        if (pending.length || buffer) {
          const out = await computeFlush(pending, buffer, ctx);
          for (const c of out) yield c;
          buffer = '';
          pending = [];
        }
        yield chunk;
      }
    }
    // 流结束仍未遇到 block-end 时，冲刷剩余文本
    if (pending.length || buffer) {
      const out = await computeFlush(pending, buffer, ctx);
      for (const c of out) yield c;
    }
  } catch (e) {
    if (pending.length || buffer) {
      try {
        const out = await computeFlush(pending, buffer, ctx);
        for (const c of out) yield c;
      } catch (_) {
        for (const c of pending) yield c;
      }
    }
    throw e;
  }
}

return {
  name: 'j-space-a2-forbidden-speech',
  inject: ['llm'],
  apply(ctx) {
    ctx.on('llm/stream', (options, next) => {
      const isInternal = internalActive || (options && typeof options === 'object' &&
        (options[INTERNAL] || (typeof options.system === 'string' && options.system.includes(SENTINEL))));
      if (isInternal) {
        // 内部模型调用：直接放行，不套用本插件的改写逻辑，避免无限递归
        return typeof next === 'function' ? next(options) : next;
      }
      const upstream = typeof next === 'function' ? next(options) : next;
      return transformStream(upstream, ctx);
    });
  },
};