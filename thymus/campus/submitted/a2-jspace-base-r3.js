/**
 * A2 服务禁语合规守卫
 * 挂载 llm/stream：对 agent 直接输出（非工具调用）的文本块做禁语检测与改写。
 * 合规文本原样透传；违规文本通过内部模型改写，并强制保留账期/金额/材料等事实信息。
 * 内部模型调用通过 INTERNAL 标记 + WeakSet 精确防递归（不影响其它并发请求）。
 */
const INTERNAL = Symbol('a2.internal.call');

const FORBIDDEN_KEYWORDS = [
  '不可能', '做不到', '没办法',
  '这不是我的责任', '不是我的责任', '不关我事', '不关我的事', '跟我没关系', '与我没关系',
  '系统崩了', '系统崩溃', '系统出bug了', '系统出bug', '系统出故障', '系统故障', '系统出问题了',
  '你听不懂吗', '听不懂吗', '你没听懂', '你理解能力有问题',
  '爱办不办', '随你便', '你爱咋咋地', '随便你怎么想', '你爱信不信',
  '我怎么知道', '别问我', '别来问我',
  '你到底想怎样', '你到底要干嘛',
  '我已经说过了', '我不是说过了吗', '我说了多少遍了',
  '你自己看着办',
];

const FALLBACK_REPLACEMENTS = [
  ['系统出bug了', '系统出现临时异常'],
  ['系统出bug', '系统出现临时异常'],
  ['系统出问题了', '系统出现临时异常'],
  ['系统崩了', '系统出现临时异常，正在处理'],
  ['系统崩溃', '系统出现临时异常，正在处理'],
  ['系统故障', '系统出现临时异常，正在处理'],
  ['这不是我的责任', '我帮您反馈并跟进处理'],
  ['不是我的责任', '我帮您反馈并跟进处理'],
  ['不关我事', '我帮您反馈并跟进处理'],
  ['不关我的事', '我帮您反馈并跟进处理'],
  ['跟我没关系', '我帮您反馈并跟进处理'],
  ['与我没关系', '我帮您反馈并跟进处理'],
  ['你听不懂吗', '我重新为您说明一下'],
  ['听不懂吗', '我重新为您说明一下'],
  ['你没听懂', '我重新为您说明一下'],
  ['做不到', '目前暂时无法办理'],
  ['没办法', '暂时没有更好的办法'],
  ['不可能', '暂时无法确认'],
  ['爱办不办', '您可以考虑后决定'],
  ['随你便', '您可以根据需要选择'],
  ['你爱咋咋地', '您可以根据需要选择'],
  ['我怎么知道', '我帮您查询确认'],
  ['别问我', '我帮您查询确认'],
  ['别来问我', '我帮您查询确认'],
];

function containsForbiddenKeyword(text) {
  if (!text) return false;
  for (const kw of FORBIDDEN_KEYWORDS) {
    if (text.includes(kw)) return true;
  }
  return /你.{0,4}(听不懂|不明白|没听懂).{0,3}(吗|么)/.test(text);
}

function sanitizeFallback(text) {
  let out = text || '';
  for (const [from, to] of FALLBACK_REPLACEMENTS) {
    out = out.split(from).join(to);
  }
  return out;
}

function splitText(text, size) {
  const s = size || 40;
  if (!text) return [''];
  const pieces = [];
  for (let i = 0; i < text.length; i += s) {
    pieces.push(text.slice(i, i + s));
  }
  return pieces.length ? pieces : [''];
}

function extractJson(text) {
  if (!text) return null;
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fence) t = fence[1].trim();
  try { return JSON.parse(t); } catch (e) {}
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(t.slice(start, end + 1)); } catch (e) {}
  }
  if (/true/i.test(t)) return { violation: true };
  if (/false/i.test(t)) return { violation: false };
  return null;
}

function getUserText(options) {
  const messages = (options && options.messages) || [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || m.role !== 'user') continue;
    const content = m.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      const parts = content
        .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
        .map((c) => c.text);
      if (parts.length) return parts.join(' ');
    }
  }
  return '';
}

function extractFactTokens(text) {
  const facts = new Set();
  const patterns = [
    /\d{4}年\d{1,2}月\d{1,2}日/g,
    /\d{1,2}月\d{1,2}日/g,
    /\d{4}年/g,
    /\d+(?:\.\d+)?\s*(?:GB|MB|Mbps|G|兆|元|块|角|分|％|%|月|日|号|点|小时|分钟|天|个|次|年)/g,
    /\d{4,}/g,
  ];
  for (const re of patterns) {
    const matches = text.match(re);
    if (matches) matches.forEach((m) => facts.add(m));
  }
  return Array.from(facts);
}

function factsPreserved(original, rewritten) {
  const facts = extractFactTokens(original);
  if (!facts.length) return true;
  return facts.every((f) => (rewritten || '').includes(f));
}

return {
  name: 'a2-service-forbidden-words-guard',
  inject: ['llm'],
  apply(ctx) {
    const internalOptions = new WeakSet();

    async function callLLM(system, userText, extra) {
      const options = Object.assign({
        provider: 'deepseek-official',
        model: 'deepseek-chat',
        reasoningEffort: 'off',
        system,
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: userText }],
            source: { kind: 'user' },
          },
        ],
      }, extra || {});
      options[INTERNAL] = true;
      internalOptions.add(options);
      try {
        const stream = ctx.llm.stream(options);
        let text = '';
        let lastBlockText = '';
        for await (const chunk of stream) {
          if (!chunk) continue;
          if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
            text += chunk.text;
          } else if (chunk.type === 'block-end' && chunk.block && chunk.block.type === 'text' && typeof chunk.block.text === 'string') {
            lastBlockText = chunk.block.text;
          }
        }
        if (!text && lastBlockText) text = lastBlockText;
        return text;
      } finally {
        internalOptions.delete(options);
      }
    }

    async function judge(text) {
      const system = [
        '你是校园网客服话术合规审查员。',
        '判断给定的客服回复是否包含"服务禁语"：态度消极、强势质问、甩锅推诿等负面表达。',
        '典型例子：「不可能」「做不到」「没办法」「这不是我的责任」「系统崩了」「系统出bug了」「你听不懂吗」等。',
        '只判断是否违规，不要改写。',
        '输出严格 JSON：{"violation": true或false, "reason": "简要原因"}。',
        '没有明显违规时 violation 必须为 false，reason 写"合规"。',
      ].join('');
      const out = await callLLM(system, '请审查以下客服回复：\n\n' + text);
      const parsed = extractJson(out);
      return parsed ? !!parsed.violation : false;
    }

    async function rewrite(text, options, mustPreserve, forceChange) {
      const system = [
        '你是校园网客服话术合规改写助手。',
        '把客服回复改写为积极、负责、礼貌的表达，消除态度消极、强势质问、甩锅推诿等禁语',
        '（如「不可能」「做不到」「没办法」「这不是我的责任」「系统崩了」「系统出bug了」「你听不懂吗」等）。',
        '必须原样保留所有事实信息：账期、金额、办理流程、需要用户提供的材料、时间节点等，',
        '不得增删或篡改任何事实，只能调整语气和措辞。',
        '直接输出改写后的完整回复文本，不要使用引号或 Markdown 代码块包裹，不要任何解释、前缀或 JSON 包装。',
      ].join('');
      const userContext = getUserText(options);
      let prompt = '请改写以下客服回复：\n\n' + text;
      if (userContext) {
        const ctxText = userContext.length > 1000 ? userContext.slice(0, 1000) + '…' : userContext;
        prompt = '用户的问题背景：\n' + ctxText + '\n\n' + prompt;
      }
      if (mustPreserve && mustPreserve.length) {
        prompt += '\n\n特别注意：以下事实信息必须原样保留在改写结果中：' + mustPreserve.join('、');
      }
      if (forceChange) {
        prompt += '\n\n该回复确认包含禁语，你必须调整措辞，不得原样返回。';
      }
      const out = await callLLM(system, prompt);
      const trimmed = (out || '').trim();
      return trimmed || null;
    }

    async function doRewriteWithVerification(text, options) {
      let r = await rewrite(text, options);
      if (r && r === text) {
        const facts = extractFactTokens(text);
        const r2 = await rewrite(text, options, facts, true);
        if (r2) r = r2;
      } else if (r && !factsPreserved(text, r)) {
        const facts = extractFactTokens(text);
        const r2 = await rewrite(text, options, facts);
        if (r2) r = r2;
      }
      return r;
    }

    async function checkAndRewrite(text, options) {
      try {
        const hasKeyword = containsForbiddenKeyword(text);
        if (hasKeyword) {
          const r = await doRewriteWithVerification(text, options);
          if (r) {
            return containsForbiddenKeyword(r) ? sanitizeFallback(r) : r;
          }
          return sanitizeFallback(text);
        }
        const violation = await judge(text);
        if (violation) {
          const r = await doRewriteWithVerification(text, options);
          if (r) {
            return containsForbiddenKeyword(r) ? sanitizeFallback(r) : r;
          }
          return sanitizeFallback(text);
        }
        return null; // 合规，原样透传
      } catch (err) {
        try {
          return containsForbiddenKeyword(text) ? sanitizeFallback(text) : null;
        } catch (e) {
          return null;
        }
      }
    }

    function wrapStream(options, next) {
      return (async function* () {
        const chunks = [];
        const deltaGroups = new Map();
        const blockEndTexts = new Map();
        const textIndices = new Set();

        // 先完整收集上游 chunk，避免把违规文本提前漏给下游
        try {
          for await (const chunk of next()) {
            chunks.push(chunk);
            if (!chunk) continue;
            if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
              if (!deltaGroups.has(chunk.index)) deltaGroups.set(chunk.index, []);
              deltaGroups.get(chunk.index).push(chunk.text);
              textIndices.add(chunk.index);
            } else if (chunk.type === 'block-end' && chunk.block && chunk.block.type === 'text' && typeof chunk.block.text === 'string') {
              blockEndTexts.set(chunk.index, chunk.block.text);
              textIndices.add(chunk.index);
            }
          }
        } catch (err) {
          // 上游异常：为避免丢内容，把已收集的原始 chunk 原样吐出
          for (const chunk of chunks) yield chunk;
          return;
        }

        // 逐文本块做检测/改写
        const rewriteMap = new Map();
        for (const index of textIndices) {
          let fullText;
          if (blockEndTexts.has(index)) {
            fullText = blockEndTexts.get(index);
          } else if (deltaGroups.has(index)) {
            fullText = deltaGroups.get(index).join('');
          } else {
            continue;
          }
          if (!fullText || !fullText.trim()) continue;
          const rewritten = await checkAndRewrite(fullText, options);
          if (rewritten !== null) {
            rewriteMap.set(index, rewritten);
          }
        }

        // 重放：重写的块替换为带原 index 的合成 chunk；其余原样透传
        const emitted = new Set();
        for (const chunk of chunks) {
          if (!chunk) continue;
          const isTextDelta = chunk.type === 'text-delta';
          const isTextBlockEnd = chunk.type === 'block-end' && chunk.block && chunk.block.type === 'text';
          if (!isTextDelta && !isTextBlockEnd) {
            yield chunk;
            continue;
          }
          const index = chunk.index;
          if (!rewriteMap.has(index)) {
            yield chunk;
            continue;
          }
          if (!emitted.has(index)) {
            emitted.add(index);
            const rewritten = rewriteMap.get(index);
            const pieces = splitText(rewritten);
            for (const piece of pieces) {
              const syn = { ...chunk, type: 'text-delta', text: piece };
              delete syn.block;
              yield syn;
            }
          }
          if (isTextBlockEnd) {
            yield { ...chunk, block: { ...chunk.block, text: rewriteMap.get(index) } };
          }
        }
      })();
    }

    ctx.on('llm/stream', (options, next) => {
      // 自己发起的内部调用：直接透传，防止无限递归
      if (options && (options[INTERNAL] || internalOptions.has(options))) {
        return next();
      }
      return wrapStream(options, next);
    });
  },
};