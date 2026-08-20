return {
  name: 'a2-forbidden-phrase-filter',
  inject: ['llm'],
  apply(ctx) {
    const INTERNAL = Symbol('a2.internal');
    let internalDepth = 0;

    // 强禁语：SOP 明确示例 + 已发现的同义表达（消极/质问/甩锅/驱赶/归咎），命中即必须处理
    const STRONG_PATTERNS = [
      /不可能/, /做不到/, /没办法/, /无能为力/,
      /这不是我的责任/, /不是我的责任/, /不归我(管|负责)/,
      /系统(崩了|崩溃|出bug|出故障|出问题|出异常)/, /系统bug/,
      /你听不懂吗/, /听明白没有/, /听明白了没/, /听懂没有/, /听懂了没/,
      /明白没有/, /你到底(懂|明白|听懂)(吗|没有)/, /还要我说(几遍|多少遍|多少次)/,
      /你是不是听不懂/, /怎么(说|讲)你才明白/, /我说了(多少遍|很多遍|无数遍)了/,
      /管不了/, /管不着/, /办不到/, /搞不了/, /搞不定/, /修不好/, /修不了/,
      /帮不了/, /帮不上/, /救不了/, /爱莫能助/, /没(什么|啥)希望/, /白搭/, /没戏/,
      /爱办不办/, /爱咋(办|地)咋(办|地)/, /爱信不信/, /拉倒吧/,
      /别再问了/, /别问了/, /不要再问了/, /不要问了/, /别烦(我|我们)/,
      /别打扰(我|我们)/, /你走吧/, /请(你)?(离开|出去)/, /不要(再)?来(问|烦)(我|我们)/,
      /没事(就)?(别|不要)来/,
      /不关我(的)?事/, /跟(我|我们)(没|无)关/, /别找我/, /找(我|我们)(也)?没(用|办法)/,
      /这不是我的事/, /我有什么办法/, /这事(别|不要)找我/, /(您|你)去找别人/,
      /怪谁/, /怪你自己/, /都怪你/, /(都|就)怪你/, /怨谁/, /怨你自己/, /谁让你/, /是你自己/,
      /你(是|是不是)(傻|笨|蠢|有问题)/
    ];

    // 弱禁语：语义偏消极，主要交给 LLM 判断，避免误伤正常话术
    const SOFT_PATTERNS = [
      /随便你/, /随你便/, /你爱怎么(想|说|办)就怎么(想|说|办)/,
      /明白没(?!有)/, /懂了吗/, /明白了吗/, /自己(看|查|想办法|解决)/,
      /我不管/, /不想(管|理|回答|说)/, /懒得(管|理|说)/, /烦不烦/, /有病吧/,
      /放弃吧/, /别(跟|和)我说(这个|这些)/, /这事我(管|负责)?不了/
    ];

    const ALL_PATTERNS = STRONG_PATTERNS.concat(SOFT_PATTERNS);

    function matchesAny(text, patterns) {
      if (!text) return false;
      return patterns.some((re) => re.test(text));
    }

    async function collectText(iter) {
      let text = '';
      for await (const chunk of iter) {
        if (!chunk || typeof chunk !== 'object') continue;
        if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
          text += chunk.text;
        } else if (chunk.type === 'block-end' && chunk.block && chunk.block.type === 'text' && typeof chunk.block.text === 'string') {
          text = chunk.block.text;
        }
      }
      return text;
    }

    async function callLLM(text) {
      const system = '你是校园网客服的合规审查助手。你负责判断客服话术是否包含态度消极、强势质问、甩锅推诿、驱赶用户、归咎用户等禁语，并在必要时做中立化改写。改写时必须原样保留所有事实信息。';
      const prompt = [
        '请对下面这段客服话术做合规检查，并严格只输出一行 JSON（不要输出任何其他内容）：',
        '{"needRewrite": true/false, "text": "..."}',
        '',
        '判断标准：出现以下任一类表达都算违规（含同义说法）：',
        '1. 消极/否定：不可能、做不到、没办法、管不了、修不好、爱办不办、没戏、无能为力、帮不了等；',
        '2. 强势质问：你听不懂吗、听明白没有、你到底懂不懂、还要我说几遍、明白没等；',
        '3. 甩锅推诿：这不是我的责任、不关我事、别找我、不归我管、系统崩了、系统出bug了等；',
        '4. 驱赶用户：别再问了、别烦我、你走吧、不要再来问等；',
        '5. 归咎用户：怪谁、怪你自己、都怪你、谁让你、怨你自己等。',
        '',
        '如果违规：请改写成中立、礼貌、有帮助的说法，且必须原样保留所有事实信息（账期、金额、日期、账号、材料、办理步骤、业务规则等），任何一个数字、日期、专有名词都不能改动或丢失，needRewrite 设为 true。',
        '如果不违规：text 字段原样输出原话，不要做任何改动，needRewrite 设为 false。',
        '',
        '原话：',
        text
      ].join('\n');

      internalDepth++;
      try {
        const options = {
          provider: 'deepseek-official',
          model: 'deepseek-chat',
          reasoningEffort: 'off',
          system,
          messages: [
            {
              role: 'user',
              content: [{ type: 'text', text: prompt }],
              source: { kind: 'user' }
            }
          ]
        };
        options[INTERNAL] = true; // 标记内部调用，防止撞回本 handler 无限递归
        const iter = ctx.llm.stream(options);
        return await collectText(iter);
      } finally {
        internalDepth--;
      }
    }

    function isTrue(v) {
      return v === true || v === 'true' || v === '是' || v === 1 || v === '1';
    }

    function parseLLMResult(raw, original) {
      if (!raw || typeof raw !== 'string') return { needRewrite: null, text: original };
      const cleaned = raw.trim();
      const m = cleaned.match(/\{[\s\S]*\}/);
      if (m) {
        try {
          const obj = JSON.parse(m[0]);
          if (obj && typeof obj === 'object') {
            const need = isTrue(obj.needRewrite);
            const t = (typeof obj.text === 'string' ? obj.text : (typeof obj.rewritten === 'string' ? obj.rewritten : '')).trim();
            return { needRewrite: need, text: t || original };
          }
        } catch (e) { /* fall through */ }
      }
      const stripped = cleaned.replace(/^["'“”「」『』`]+|["'“”「」『』`]+$/g, '').trim();
      if (stripped === original) return { needRewrite: false, text: original };
      return { needRewrite: null, text: stripped || original };
    }

    // 兜底定向替换：只替换明确的禁语短语，其余文字逐字保留，保证事实不丢
    const REPLACEMENTS = [
      [/你到底(是)?(听明白|听懂|明白)(了)?没有/g, '我再为您说明一遍'],
      [/你(是)?(听明白|听懂|明白)(了)?没有/g, '我再为您说明一遍'],
      [/还要我说(几遍|多少遍|多少次)/g, '我再为您说明一遍'],
      [/怎么(说|讲)你才明白/g, '我再为您说明一遍'],
      [/你是不是听不懂/g, '我再为您说明一遍'],
      [/你听不懂吗/g, '我再为您说明一遍'],
      [/听明白没有/g, '我再为您说明一遍'],
      [/听明白了没/g, '我再为您说明一遍'],
      [/听懂没有/g, '我再为您说明一遍'],
      [/听懂了没/g, '我再为您说明一遍'],
      [/明白没有/g, '我再为您说明一遍'],
      [/明白没(?!有)/g, '我再为您说明一遍'],
      [/懂了吗/g, '我再为您说明一遍'],
      [/明白了吗/g, '我再为您说明一遍'],
      [/我说了(多少遍|很多遍|无数遍)了/g, '我再为您说明一遍'],
      [/这事(我|我们)?(管不了|办不到|没办法|搞不了)/g, '这件事我会帮您跟进处理'],
      [/这件事(我|我们)?(管不了|办不到|没办法|搞不了)/g, '这件事我会帮您跟进处理'],
      [/(我|我们)(管不了|管不着)/g, '我会帮您跟进处理'],
      [/这不是我的责任/g, '这个问题我来帮您一起处理'],
      [/不是我的责任/g, '这个问题我来帮您一起处理'],
      [/这不是我的事/g, '这个问题我来帮您一起处理'],
      [/不归我(管|负责)/g, '我帮您转给相关同事处理'],
      [/不关我(的)?事/g, '这个问题我来帮您一起处理'],
      [/跟(我|我们)(没|无)关/g, '这个问题我来帮您一起处理'],
      [/找(我|我们)(也)?没(用|办法)/g, '我帮您转给相关同事处理'],
      [/(您|你)去找别人(吧)?/g, '我帮您转给相关同事处理'],
      [/找别人(吧)?/g, '我帮您转给相关同事处理'],
      [/这事(别|不要)找我/g, '我帮您转给相关同事处理'],
      [/别找我/g, '我帮您转给相关同事处理'],
      [/我有什么办法/g, '我帮您看看如何处理'],
      [/爱办不办/g, '建议您考虑其他处理方式'],
      [/爱咋(办|地)咋(办|地)/g, '建议您考虑其他处理方式'],
      [/爱信不信/g, '以上信息供您参考'],
      [/拉倒吧/g, '那我们先这样处理'],
      [/不可能/g, '可能暂时无法满足'],
      [/做不到/g, '暂时无法完成'],
      [/没办法/g, '暂时没有其他办法'],
      [/无能为力/g, '暂时没有更好的办法'],
      [/办不到/g, '暂时无法完成'],
      [/搞不了/g, '暂时无法完成'],
      [/搞不定/g, '暂时无法完成'],
      [/修不好/g, '暂时无法修复'],
      [/修不了/g, '暂时无法修复'],
      [/帮不了/g, '暂时无法协助'],
      [/帮不上/g, '暂时无法协助'],
      [/救不了/g, '暂时没有更好的办法'],
      [/爱莫能助/g, '暂时没有更好的办法'],
      [/没(什么|啥)希望/g, '暂时没有可行的方案'],
      [/没戏/g, '暂时没有可行的方案'],
      [/白搭/g, '暂时没有效果'],
      [/放弃吧/g, '建议您考虑其他方案'],
      [/随便你/g, '您看这样是否可以'],
      [/随你便/g, '您看这样是否可以'],
      [/我不管/g, '我帮您看看如何处理'],
      [/不想(管|理|回答|说)/g, '我帮您看看如何处理'],
      [/懒得(管|理|说)/g, '我帮您看看如何处理'],
      [/烦不烦/g, '请不要着急'],
      [/你(是|是不是)(傻|笨|蠢|有问题)/g, '我可能没有解释清楚'],
      [/有病吧/g, '我可能没有解释清楚'],
      [/你爱怎么(想|说|办)就怎么(想|说|办)/g, '您看这样是否可以'],
      [/自己(看|查|想办法|解决)/g, '您可以查看'],
      [/别再问了/g, '我继续为您说明'],
      [/不要再问了/g, '我继续为您说明'],
      [/不要问了/g, '我继续为您说明'],
      [/别问了/g, '我继续为您说明'],
      [/不要(再)?来(问|烦)(我|我们)/g, '请问还有什么可以帮您'],
      [/别烦(我|我们)/g, '请问还有什么可以帮您'],
      [/别打扰(我|我们)/g, '请问还有什么可以帮您'],
      [/没事(就)?(别|不要)来/g, '请问还有什么可以帮您'],
      [/你走吧/g, '请问还有什么可以帮您'],
      [/请(你)?(离开|出去)/g, '请问还有什么可以帮您'],
      [/别(跟|和)我说(这个|这些)/g, '我继续为您说明'],
      [/是你自己(没|不|搞|弄)/g, '没有及时'],
      [/怪你自己/g, '我们一起核实一下原因'],
      [/都怪你/g, '我们一起核实一下原因'],
      [/(都|就)怪你/g, '我们一起核实一下原因'],
      [/怪谁/g, '我们一起核实一下原因'],
      [/怨你自己/g, '我们一起核实一下原因'],
      [/怨谁/g, '我们一起核实一下原因'],
      [/谁让你/g, '当时的情况我们一起来核实'],
      [/是你自己/g, '我们一起来核实一下情况'],
      [/你自己的(问题|责任)/g, '我们一起来核实一下情况']
    ];

    function fallbackReplace(text) {
      let out = text;
      for (const [re, rep] of REPLACEMENTS) out = out.replace(re, rep);
      return out;
    }

    function extractFactTokens(text) {
      const tokens = new Set();
      const patterns = [
        /\d+(?:\.\d+)?/g,
        /\d{4}\s*[-/年]\s*\d{1,2}(?:\s*[-/月]\s*\d{1,2})?/g,
        /\d{1,2}\s*月\s*\d{1,2}\s*日/g,
        /\d{1,2}\s*月/g,
        /\d{1,2}\s*日/g
      ];
      for (const p of patterns) {
        const m = text.match(p);
        if (m) for (const t of m) tokens.add(t.replace(/\s+/g, ''));
      }
      return tokens;
    }

    function factsPreserved(original, rewritten) {
      const facts = extractFactTokens(original);
      for (const f of facts) {
        if (f.length >= 2 && !rewritten.includes(f)) return false;
      }
      return true;
    }

    async function rewriteBlock(text) {
      let raw;
      try {
        raw = await callLLM(text);
      } catch (e) {
        return fallbackReplace(text);
      }
      const parsed = parseLLMResult(raw, text);

      if (parsed.needRewrite === true) {
        const r = parsed.text && parsed.text !== text ? parsed.text : null;
        if (r && factsPreserved(text, r) && !matchesAny(r, STRONG_PATTERNS)) return r;
        return fallbackReplace(text);
      }
      if (parsed.needRewrite === false) {
        // 信任 LLM 的语义判断；但若强禁语仍明确存在（例如模型漏判/回显），强制兜底改写
        if (matchesAny(text, STRONG_PATTERNS)) return fallbackReplace(text);
        return text;
      }
      // LLM 输出无法解析：用规则兜底
      if (matchesAny(text, ALL_PATTERNS)) return fallbackReplace(text);
      return text;
    }

    ctx.on('llm/stream', (options, next) => {
      // 防递归：插件自己发起的内部 LLM 调用直接放行
      if (options && (options[INTERNAL] === true || internalDepth > 0)) {
        return next(options);
      }

      const upstream = next(options);

      return (async function* () {
        // 缓冲整个流，按 index 聚合文本块
        const chunks = [];
        const blocks = new Map();
        const blockOrder = [];

        for await (const chunk of upstream) {
          chunks.push(chunk);
          if (!chunk || typeof chunk !== 'object') continue;
          const idx = chunk.index;
          const isTextDelta = chunk.type === 'text-delta' && typeof chunk.text === 'string';
          const isTextEnd = chunk.type === 'block-end' && chunk.block && chunk.block.type === 'text' && typeof chunk.block.text === 'string';
          if ((isTextDelta || isTextEnd) && idx != null) {
            if (!blocks.has(idx)) {
              blocks.set(idx, { text: '' });
              blockOrder.push(idx);
            }
            if (isTextDelta) blocks.get(idx).text += chunk.text;
            if (isTextEnd) blocks.get(idx).text = chunk.block.text;
          }
        }

        // 去掉空块
        for (const idx of blockOrder) {
          if (!blocks.get(idx).text) blocks.delete(idx);
        }
        const validOrder = blockOrder.filter((idx) => blocks.has(idx));

        // 逐块改写
        const rewritten = new Map();
        for (const idx of validOrder) {
          rewritten.set(idx, await rewriteBlock(blocks.get(idx).text));
        }

        // 按原顺序重放：文本块的 text-delta 用改写后的单条 delta 代替，block-end 同步改写文本
        const emitted = new Set();
        for (const chunk of chunks) {
          if (!chunk || typeof chunk !== 'object') {
            yield chunk;
            continue;
          }
          const idx = chunk.index;
          if (idx != null && blocks.has(idx)) {
            if (chunk.type === 'text-delta') {
              continue;
            }
            if (chunk.type === 'block-end' && chunk.block && chunk.block.type === 'text') {
              if (!emitted.has(idx)) {
                yield { type: 'text-delta', index: idx, text: rewritten.get(idx) };
                emitted.add(idx);
              }
              yield { ...chunk, block: { ...chunk.block, text: rewritten.get(idx) } };
              continue;
            }
          }
          yield chunk;
        }

        // 兜底：某文本块只有 delta 没有 block-end 时补发
        for (const idx of validOrder) {
          if (!emitted.has(idx)) {
            yield { type: 'text-delta', index: idx, text: rewritten.get(idx) };
            yield { type: 'block-end', index: idx, block: { type: 'text', text: rewritten.get(idx) } };
          }
        }
      })();
    });
  }
};
