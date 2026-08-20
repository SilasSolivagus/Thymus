// A2 服务禁语（语义消极表达）过滤插件
// 拦截 llm/stream，缓冲完整回复后做合规检测与改写，重放时保留原 chunk.index。
// 内部模型调用通过 INTERNAL 标记 + internalOptions WeakSet + internalDepth 防止递归。

const INTERNAL = Symbol('llm.internal');

// 已知禁语 -> 合规替换（本地兜底，保证事实不被改写破坏）
const BANNED_REPLACEMENTS = [
  [/不可能/g, '暂时无法确认'],
  [/做不到/g, '暂时无法做到，我们会尽力协助您'],
  [/没办法/g, '目前暂时没有更优的方案，我们会尽力为您协调'],
  [/这不是我的责任/g, '这个环节由负责的同事处理，我帮您转达'],
  [/这不是我的事/g, '这个环节由负责的同事处理，我帮您转达'],
  [/不关我事/g, '这个环节由负责的同事处理，我帮您协调'],
  [/系统崩了/g, '系统当前出现临时异常，我们正在加紧处理'],
  [/系统出bug了/g, '系统当前出现临时异常，我们正在加紧修复'],
  [/系统出故障了/g, '系统当前出现临时异常，我们正在加紧处理'],
  [/你听不懂吗/g, '可能我刚才没有表达清楚，我再为您说明一下'],
  [/听不懂吗/g, '我重新为您说明一下'],
  [/我不管/g, '这部分需要相关同事协助，我帮您反馈'],
  [/别问我/g, '这个问题由专门的同事负责，我帮您转接'],
  [/爱办不办/g, '如果您方便的话，建议您尽快办理'],
  [/随便你/g, '您看怎么方便怎么来'],
  [/解决不了/g, '暂时无法直接解决，我们会尽快为您反馈处理'],
  [/无法处理/g, '暂时无法直接处理，我们会协助您'],
  [/没办法解决/g, '目前暂时无法直接解决，我们会尽力协助您']
];

function hasLocalViolation(text) {
  return BANNED_REPLACEMENTS.some(function (pair) {
    pair[0].lastIndex = 0;
    return pair[0].test(text);
  });
}

function applyLocalReplacements(text) {
  let out = text;
  for (let i = 0; i < BANNED_REPLACEMENTS.length; i++) {
    out = out.replace(BANNED_REPLACEMENTS[i][0], BANNED_REPLACEMENTS[i][1]);
  }
  return out;
}

function numericValues(text) {
  const set = new Set();
  const re = /\d+(?:\.\d+)?/g;
  let m;
  while ((m = re.exec(text)) !== null) set.add(parseFloat(m[0]));
  return set;
}

function termValues(text) {
  const set = new Set();
  const re = /(身份证|学生证|校园卡|一卡通|学号|工号|订单号|工单号|账号|卡号|手机号|电话号码|邮箱|地址|姓名|截图|发票|账单|账期|缴费|金额|材料|证件|密码|套餐|月租)/g;
  let m;
  while ((m = re.exec(text)) !== null) set.add(m[0]);
  return set;
}

// 事实保留校验：数字按数值比较（兼容 05 与 5、2024-05-01 与 2024年5月1日），关键材料词按子串比较
function factsPreserved(original, rewritten) {
  const origNums = numericValues(original);
  const newNums = numericValues(rewritten);
  for (const v of origNums) {
    if (!newNums.has(v)) return false;
  }
  const origTerms = termValues(original);
  for (const t of origTerms) {
    if (!rewritten.includes(t)) return false;
  }
  return true;
}

function missingFacts(original, rewritten) {
  const origNums = numericValues(original);
  const newNums = numericValues(rewritten);
  const missing = [];
  for (const v of origNums) {
    if (!newNums.has(v)) missing.push(String(v));
  }
  const origTerms = termValues(original);
  for (const t of origTerms) {
    if (!rewritten.includes(t)) missing.push(t);
  }
  return missing.join('、');
}

// 归一化比较：忽略空白与末尾标点，用于判断改写是否实质改变文本
function normalizeComparable(s) {
  return String(s || '').replace(/\s+/g, '').replace(/[。．.!！?？，,；;：:、]+$/g, '');
}

// 按原始长度比例把 total 个字符分给各段，保证总和等于 total
function distribute(total, lengths) {
  const n = lengths.length;
  if (n === 0) return [];
  const sum = lengths.reduce(function (a, b) { return a + b; }, 0);
  const result = new Array(n);
  if (sum <= 0) {
    const base = Math.floor(total / n);
    const rem = total % n;
    for (let i = 0; i < n; i++) result[i] = base + (i < rem ? 1 : 0);
    return result;
  }
  let allocated = 0;
  for (let i = 0; i < n - 1; i++) {
    const v = Math.floor((lengths[i] * total) / sum);
    result[i] = v;
    allocated += v;
  }
  result[n - 1] = Math.max(0, total - allocated);
  return result;
}

// 用改写后的全文按原 chunk 结构重放，保留每个 chunk 的 index
function* replayWithText(chunks, newText) {
  const blocks = new Map();
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const idx = chunk.index;
    if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
      let b = blocks.get(idx);
      if (!b) { b = { deltas: [], blockEnd: null, len: 0 }; blocks.set(idx, b); }
      b.deltas.push(chunk);
      b.len += chunk.text.length;
    } else if (chunk.type === 'block-end' && chunk.block && chunk.block.type === 'text') {
      let b = blocks.get(idx);
      if (!b) { b = { deltas: [], blockEnd: null, len: 0 }; blocks.set(idx, b); }
      b.blockEnd = chunk;
      if (b.deltas.length === 0 && typeof chunk.block.text === 'string') {
        b.len += chunk.block.text.length;
      }
    }
  }

  const entries = Array.from(blocks.entries());
  const newBlockLens = distribute(newText.length, entries.map(function (e) { return e[1].len; }));
  const newBlockTexts = new Map();
  let cursor = 0;
  for (let i = 0; i < entries.length; i++) {
    const idx = entries[i][0];
    newBlockTexts.set(idx, newText.slice(cursor, cursor + newBlockLens[i]));
    cursor += newBlockLens[i];
  }

  const it = blocks.entries();
  let be;
  while ((be = it.next()) && !be.done) {
    const idx = be.value[0];
    const b = be.value[1];
    const blockNewText = newBlockTexts.get(idx) || '';
    b.newDeltaTexts = [];
    if (b.deltas.length > 0) {
      const deltaLens = b.deltas.map(function (d) { return d.text.length; });
      const newDeltaLens = distribute(blockNewText.length, deltaLens);
      let c = 0;
      b.newDeltaTexts = newDeltaLens.map(function (n) {
        const s = blockNewText.slice(c, c + n);
        c += n;
        return s;
      });
    }
  }

  const deltaPos = new Map();
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
      const b = blocks.get(chunk.index);
      const pos = deltaPos.get(chunk.index) || 0;
      const part = b && b.newDeltaTexts[pos] !== undefined ? b.newDeltaTexts[pos] : '';
      deltaPos.set(chunk.index, pos + 1);
      yield { ...chunk, text: part };
    } else if (chunk.type === 'block-end' && chunk.block && chunk.block.type === 'text') {
      const t = newBlockTexts.get(chunk.index);
      yield { ...chunk, block: { ...chunk.block, text: t !== undefined ? t : chunk.block.text } };
    } else {
      yield chunk;
    }
  }
}

return {
  name: 'a2-no-negative-expression',
  inject: ['llm'],
  apply(ctx) {
    let internalDepth = 0;
    const internalOptions = new WeakSet();

    // 内部模型调用；同样会走 llm/stream，必须防递归
    async function callLLM(system, userText) {
      const options = {
        provider: 'deepseek-official',
        model: 'deepseek-chat',
        reasoningEffort: 'off',
        system: system,
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: userText }],
            source: { kind: 'user' }
          }
        ],
        [INTERNAL]: true
      };
      internalOptions.add(options);
      internalDepth++;
      try {
        const stream = ctx.llm.stream(options);
        let result = '';
        for await (const chunk of stream) {
          if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
            result += chunk.text;
          } else if (chunk.type === 'block-end' && chunk.block && chunk.block.type === 'text' && typeof chunk.block.text === 'string') {
            if (!result) result += chunk.block.text;
          }
        }
        return result;
      } finally {
        internalDepth--;
      }
    }

    // 语义合规判定（无精确边界，交给模型）
    async function judge(text) {
      const out = await callLLM(
        '你是校园网客服话术合规审查员，只输出 JSON。',
        '请判断以下客服回复是否含有态度消极、强势质问、甩锅推诿等语义消极表达（例如「不可能」「做不到」「没办法」「这不是我的责任」「系统崩了」「系统出bug了」「你听不懂吗」等）。\n\n' +
        '只输出一个 JSON 对象，格式严格为 {"violation": true} 或 {"violation": false}，不要输出其他任何内容。\n\n' +
        '客服回复：\n"""\n' + text + '\n"""'
      );
      const jm = out.match(/["']?violation["']?\s*[:：]\s*(true|false)/i);
      if (jm) return jm[1].toLowerCase() === 'true';
      const hasTrue = /true/i.test(out);
      const hasFalse = /false/i.test(out);
      if (hasTrue && !hasFalse) return true;
      return false;
    }

    // 合规改写：保留事实，去掉消极表达；合规文本逐字原样输出
    async function rewrite(text, missingHint) {
      let instruction =
        '请改写以下客服回复，使其符合客服服务规范：\n' +
        '1. 去除态度消极、强势质问、甩锅推诿等表达，改为专业、积极、负责、有温度的语气。\n' +
        '2. 必须逐字保留所有事实信息，一个都不能丢失或改变：账期、金额、日期、时间、数字、编号/单号/账号、姓名、联系方式，以及用户需要提供的材料（如身份证、学生证、校园卡、截图等）。\n' +
        '3. 保持原意和结构，不要增加原回复没有的事实，不要改变原回复的信息。\n' +
        '4. 如果原回复本身已完全合规，则必须逐字原样输出，不得做任何改动。\n' +
        '5. 只输出改写后的回复文本本身，不要任何解释、前缀或引号。';
      if (missingHint) {
        instruction += '\n6. 注意：上一版改写丢失了以下事实信息，本次必须原样保留：' + missingHint;
      }
      const out = await callLLM(
        '你是校园网客服话术合规改写助手。',
        instruction + '\n\n待改写的客服回复：\n"""\n' + text + '\n"""'
      );
      return out.trim();
    }

    async function checkAndRewrite(text) {
      try {
        const localHit = hasLocalViolation(text);
        let needRewrite = localHit;
        if (!needRewrite) {
          try {
            needRewrite = await judge(text);
          } catch (e) {
            needRewrite = false;
          }
        }
        if (!needRewrite) return text;

        let rewritten = '';
        try {
          rewritten = await rewrite(text);
        } catch (e) {
          rewritten = '';
        }

        function unchanged(s) {
          return s && normalizeComparable(s) === normalizeComparable(text);
        }

        if (rewritten && !unchanged(rewritten) && factsPreserved(text, rewritten)) {
          return rewritten;
        }

        if (rewritten && !unchanged(rewritten)) {
          const missing = missingFacts(text, rewritten);
          try {
            const retry = await rewrite(text, missing);
            if (retry && !unchanged(retry) && factsPreserved(text, retry)) {
              return retry;
            }
            if (retry && !unchanged(retry)) {
              rewritten = retry;
            }
          } catch (e) {}
        }

        // 本地替换兜底：只替换已知禁语，事实绝对不变
        const localFixed = applyLocalReplacements(text);
        if (localFixed !== text) return localFixed;

        if (rewritten && !unchanged(rewritten) && factsPreserved(text, rewritten)) {
          return rewritten;
        }

        return text;
      } catch (e) {
        return applyLocalReplacements(text);
      }
    }

    async function* processStream(options, next) {
      const chunks = [];
      let fullText = '';
      const deltaByIndex = new Map();

      const upstream = typeof next === 'function' ? next() : next;
      for await (const chunk of upstream) {
        chunks.push(chunk);
        if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
          fullText += chunk.text;
          const idx = chunk.index;
          deltaByIndex.set(idx, (deltaByIndex.get(idx) || 0) + chunk.text.length);
        }
      }

      // 只有没有 text-delta 的 text 块才用 block-end 的文本（避免与 delta 重复计数）
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        if (chunk.type === 'block-end' && chunk.block && chunk.block.type === 'text' && typeof chunk.block.text === 'string') {
          const idx = chunk.index;
          if (!deltaByIndex.has(idx) || (deltaByIndex.get(idx) || 0) === 0) {
            fullText += chunk.block.text;
          }
        }
      }

      if (!fullText.trim()) {
        yield* chunks;
        return;
      }

      let newText;
      try {
        newText = await checkAndRewrite(fullText);
      } catch (e) {
        newText = fullText;
      }

      if (newText === fullText) {
        yield* chunks;
        return;
      }

      yield* replayWithText(chunks, newText);
    }

    ctx.on('llm/stream', function (options, next) {
      // 自己发起的内部调用直接透传，防止无限递归
      if (options && (options[INTERNAL] || internalOptions.has(options))) {
        return typeof next === 'function' ? next() : next;
      }
      if (internalDepth > 0) {
        return typeof next === 'function' ? next() : next;
      }
      return processStream(options, next);
    });
  }
};
