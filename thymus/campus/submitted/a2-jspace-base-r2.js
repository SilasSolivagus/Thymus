return {
  name: 'a2-service-forbidden-phrase-guard',
  inject: ['llm'],
  apply(ctx) {
    // 内部自调用标记：Symbol 属性 + system 内的唯一标记（后者在 options 被深拷贝时仍能识别）
    const INTERNAL = Symbol('a2.internal');
    const MARKER = 'A2G-7F3A9C';

    // 无歧义的 SOP 禁语，命中直接判定违规（快路径，不依赖模型）
    const HARD_FORBIDDEN = [
      /不可能/, /做不到/, /没办法/, /无能为力/, /处理不了/, /解决不了/,
      /这不是我的责任/, /不是我的责任/,
      /你听不懂吗/, /听不懂吗/, /你怎么还不明白/, /这都不懂/, /别问了/,
      /爱信不信/, /随便你/, /你爱怎样就怎样/,
      /系统崩了/, /系统出\s*bug/i
    ];

    // 短语级保底替换：只替换禁语本身，周围事实一字不动
    const PHRASE_FIXES = [
      { re: /不可能/g, to: '很抱歉，暂时无法满足' },
      { re: /做不到/g, to: '很抱歉，目前无法为您办理' },
      { re: /没办法/g, to: '很抱歉，目前没有其他方案' },
      { re: /无能为力/g, to: '很抱歉，暂时无法处理' },
      { re: /处理不了/g, to: '正在为您协调处理' },
      { re: /解决不了/g, to: '正在为您协调处理' },
      { re: /这不是我的责任/g, to: '这个问题我会帮您反馈给相关部门跟进' },
      { re: /不是我的责任/g, to: '这个问题我会帮您反馈给相关部门跟进' },
      { re: /你听不懂吗/g, to: '我重新为您解释一下' },
      { re: /听不懂吗/g, to: '我重新为您解释一下' },
      { re: /你怎么还不明白/g, to: '我再为您详细说明一下' },
      { re: /这都不懂/g, to: '我为您详细说明一下' },
      { re: /别问了/g, to: '请您先听我说明' },
      { re: /爱信不信/g, to: '请您放心' },
      { re: /随便你/g, to: '您可以根据自己的需要选择' },
      { re: /你爱怎样就怎样/g, to: '您看这样处理可以吗' },
      { re: /系统崩了/g, to: '系统当前正在紧急处理中' },
      { re: /系统出\s*bug/gi, to: '系统当前正在紧急处理中' }
    ];

    function hasHardForbidden(text) {
      return HARD_FORBIDDEN.some((re) => re.test(text));
    }

    // 内部模型调用（带递归防护：options 带 INTERNAL 标记 + system 带 MARKER）
    async function askModel(system, userText) {
      if (!ctx.llm || typeof ctx.llm.stream !== 'function') {
        throw new Error('llm unavailable');
      }
      const options = {
        provider: 'deepseek-official',
        model: 'deepseek-chat',
        reasoningEffort: 'off',
        system: system + '\n\n[内部系统标记 ' + MARKER + '，仅用于路由识别，请忽略，不要输出此标记]',
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: userText }],
            source: { kind: 'user' }
          }
        ],
        [INTERNAL]: true
      };
      let out = '';
      const stream = await ctx.llm.stream(options);
      for await (const chunk of stream) {
        if (!chunk) continue;
        if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
          out += chunk.text;
        } else if (chunk.type === 'block-end' && chunk.block && chunk.block.type === 'text') {
          out = chunk.block.text != null ? chunk.block.text : out;
        }
      }
      return out.split(MARKER).join('').trim();
    }

    const DETECT_SYSTEM = [
      '你是一个严格的审核员，负责判断一段客服 agent 对用户说的话是否包含「服务禁语」。',
      '「服务禁语」指态度消极、强势质问、甩锅推诿等负面表达，例如：「不可能」「做不到」「没办法」「这不是我的责任」「系统崩了」「系统出bug了」「你听不懂吗」等，以及语义相近但措辞不同的变体。',
      '注意：如果文本只是在客观陈述用户已反馈的问题（如“我们已经记录您反馈的系统故障问题”），不算禁语。',
      '如果包含禁语，只回答 yes；如果不包含，只回答 no。不要输出任何其他内容。'
    ].join('\n');

    const REWRITE_SYSTEM = [
      '你是一个校园网客服话术优化器。用户会给出一段客服 agent 对用户说的话，其中包含「服务禁语」（态度消极、强势质问、甩锅推诿等负面表达）。',
      '请把这段文本改写为礼貌、积极、负责任的服务话术。',
      '改写要求：',
      '1. 只消除消极、质问、推诿的语气，不改变句子的正常语义。',
      '2. 事实信息必须一字不差地原样保留，不得丢失或改变：包括但不限于金额、账期、日期、办理条件、时间节点、用户需要提供的材料名称等所有客观事实。',
      '3. 不要添加原文没有的事实，不要编造信息。',
      '4. 只输出改写后的完整文本，不要输出任何解释、前后缀或多余内容。'
    ].join('\n');

    async function detectViolation(text) {
      if (hasHardForbidden(text)) return true;
      try {
        const answer = await askModel(DETECT_SYSTEM, text);
        const ans = answer.trim().toLowerCase().replace(/[^a-z]/g, '');
        return ans === 'yes';
      } catch (e) {
        return false;
      }
    }

    // 抽取事实性数字信息（金额、日期、账期、证件号等）
    function numericFacts(text) {
      const set = new Set();
      const patterns = [
        /\d+(?:\.\d+)?\s*(?:元|块|角|分)/g,
        /\d{4}\s*年\s*\d{1,2}\s*月(?:\s*\d{1,2}\s*(?:日|号))?/g,
        /\d{1,2}\s*月\s*\d{1,2}\s*(?:日|号)/g,
        /\d{1,2}\s*月/g,
        /\d+\s*日/g,
        /\d+\s*号/g,
        /\d{4}-\d{1,2}-\d{1,2}/g,
        /\d+\s*期/g,
        /\d{7,}/g,
        /\d+(?:\.\d+)?\s*(?:GB|G|MB|M|T)/gi,
        /\d+(?:\.\d+)?%/g
      ];
      for (const p of patterns) {
        const matches = text.match(p);
        if (matches) for (const m of matches) set.add(m);
      }
      return Array.from(set);
    }

    function factsPreserved(original, rewritten) {
      const facts = numericFacts(original);
      if (facts.length === 0) return true;
      const norm = (s) => s.replace(/\s+/g, '');
      const r = norm(rewritten);
      return facts.every((f) => r.indexOf(norm(f)) >= 0);
    }

    function phraseFix(text) {
      let result = text;
      for (const { re, to } of PHRASE_FIXES) {
        result = result.replace(re, () => to);
      }
      return result;
    }

    async function rewriteText(text) {
      try {
        let system = REWRITE_SYSTEM;
        const facts = numericFacts(text);
        if (facts.length > 0) {
          system += '\n\n原文中的以下事实信息必须一字不差地保留：' + facts.join('、');
        }
        const rewritten = await askModel(system, text);
        const cleaned = rewritten.trim();
        if (cleaned && cleaned !== text && !hasHardForbidden(cleaned) && factsPreserved(text, cleaned)) {
          return cleaned;
        }
      } catch (e) {
        // 模型不可用或失败，走短语保底
      }
      const fixed = phraseFix(text);
      if (fixed !== text && factsPreserved(text, fixed)) return fixed;
      return text;
    }

    ctx.on('llm/stream', (options, next) => {
      // 递归防护：我们自己发起的内部模型调用直接放行
      const isInternal =
        options &&
        (options[INTERNAL] ||
          (typeof options.system === 'string' && options.system.indexOf(MARKER) >= 0));
      if (isInternal) return next();

      return (async function* () {
        // 1) 先把上游整段读出来（保证能跨 chunk 识别禁语，且不改写合规文本）
        const chunks = [];
        const upstream = await next();
        for await (const chunk of upstream) {
          chunks.push(chunk);
        }

        // 2) 按连续文本块切段，保留顺序；非文本 chunk 原样透传
        const segments = [];
        let current = null;
        for (const chunk of chunks) {
          const isText =
            (chunk && chunk.type === 'text-delta' && typeof chunk.text === 'string') ||
            (chunk && chunk.type === 'block-end' && chunk.block && chunk.block.type === 'text');
          if (isText) {
            if (!current) {
              current = { chunks: [], text: '' };
              segments.push(current);
            }
            current.chunks.push(chunk);
            if (chunk.type === 'text-delta') {
              current.text += chunk.text != null ? chunk.text : '';
            } else {
              current.text = chunk.block.text != null ? chunk.block.text : current.text;
            }
          } else {
            current = null;
            segments.push({ other: true, chunks: [chunk] });
          }
        }

        // 3) 逐段检测与改写
        for (const seg of segments) {
          if (seg.other || seg.text == null || seg.text === '') {
            for (const c of seg.chunks) yield c;
            continue;
          }

          const originalText = seg.text;
          let finalText = originalText;
          let changed = false;

          if (await detectViolation(originalText)) {
            const rewritten = await rewriteText(originalText);
            if (rewritten && rewritten !== originalText) {
              finalText = rewritten;
              changed = true;
            }
          }

          // 合规文本：原样透传，绝不改动
          if (!changed) {
            for (const c of seg.chunks) yield c;
            continue;
          }

          // 4) 用原 chunk 的 index 合成新 chunk（漏了 index 会被下游当成新块）
          const blockEnd = seg.chunks.find(
            (c) => c.type === 'block-end' && c.block && c.block.type === 'text'
          );
          let lastDeltaChunk = null;
          for (let i = seg.chunks.length - 1; i >= 0; i--) {
            if (seg.chunks[i].type === 'text-delta') {
              lastDeltaChunk = seg.chunks[i];
              break;
            }
          }
          const index =
            blockEnd && blockEnd.index != null
              ? blockEnd.index
              : lastDeltaChunk && lastDeltaChunk.index != null
                ? lastDeltaChunk.index
                : 0;
          const deltaBase = lastDeltaChunk ? { ...lastDeltaChunk } : {};

          yield { ...deltaBase, type: 'text-delta', text: finalText, index };

          if (blockEnd) {
            yield {
              ...blockEnd,
              block: { ...(blockEnd.block || {}), type: 'text', text: finalText },
              index
            };
          }
        }
      })();
    });
  }
};
