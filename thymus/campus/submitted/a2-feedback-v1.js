return {
  name: 'a2-forbidden-phrase-filter',
  inject: ['llm'],
  apply(ctx) {
    const INTERNAL = Symbol('a2.internal');
    let internalDepth = 0;

    // 禁语检测：SOP 列举的示例 + 常见语义消极/质问/推诿表达（无精确边界，尽量覆盖）
    const FORBIDDEN_PATTERNS = [
      /不可能/, /做不到/, /没办法/, /无能为力/,
      /这不是我的责任/, /不是我的责任/, /不归我(管|负责)/,
      /系统(崩了|崩溃|出bug|出故障|出问题|出异常)/, /系统bug/,
      /你听不懂吗/, /听不懂(吗|就算了)?/, /怎么(说|讲)你才明白/,
      /我说了(多少遍|很多遍|无数遍)了/, /自己(看|查|想办法)/,
      /随便你/, /爱信不信/, /我不管/, /我(也)?没办法/,
      /搞不了/, /办不到/, /无法(处理|解决|满足|做到)/,
      /你(怎么|为什么)还不明白/, /烦不烦/, /别烦(我|我们)/,
      /你(是|是不是)(傻|笨|有问题)/, /不关我(的)?事/,
      /跟我(没|无)关/, /不想(管|理|回答|跟你)/,
      /别(来|再)(烦|找)(我|我们)/, /你爱怎么(想|说)就怎么(想|说)/,
      /别(跟|和)我说(这个|这些)/, /不要(再|来)(问|烦)(我|我们)/,
      /(这个|这)事(情)?(别|不要)找我/, /爱咋咋地/, /拉倒吧/
    ];

    function needsRewrite(text) {
      if (!text) return false;
      return FORBIDDEN_PATTERNS.some((re) => re.test(text));
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
      const system = '你是校园网客服的合规改写助手。只负责改写客服话术，不改动任何事实。';
      const prompt = [
        '请改写下面这段客服话术。要求：',
        '1. 如果话术中包含态度消极、强势质问、甩锅推诿类的禁语（例如「不可能」「做不到」「没办法」「这不是我的责任」「系统崩了」「系统出bug了」「你听不懂吗」等），把它们改成中立、礼貌、有帮助的说法，保持原意。',
        '2. 必须原样保留所有事实信息：账期、金额、日期、账号、材料、办理步骤、业务规则等。任何一个数字、日期、专有名词都不能改动或丢失。',
        '3. 如果话术没有禁语，直接原样输出，不要做任何改动。',
        '4. 只输出改写后的话术本身，不要任何解释、前缀、引号。',
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

    // 兜底：LLM 改写失败/丢事实时，只对已知禁语做定向替换，保证事实原样保留
    function fallbackReplace(text) {
      const replacements = [
        [/不可能/g, '可能暂时无法满足'],
        [/做不到/g, '暂时无法完成'],
        [/没办法/g, '暂时没有其他办法'],
        [/无能为力/g, '暂时没有更好的办法'],
        [/这不是我的责任/g, '这个问题我来帮您一起处理'],
        [/不是我的责任/g, '这个问题我来帮您一起处理'],
        [/不归我管/g, '我帮您转给相关同事处理'],
        [/不归我负责/g, '我帮您转给相关同事处理'],
        [/系统崩了/g, '系统暂时出现异常'],
        [/系统崩溃/g, '系统暂时出现异常'],
        [/系统出bug了/g, '系统暂时出现异常'],
        [/系统出故障/g, '系统暂时出现异常'],
        [/系统出问题/g, '系统暂时出现异常'],
        [/系统出异常/g, '系统暂时出现异常'],
        [/你听不懂吗/g, '我再为您解释一遍'],
        [/听不懂就算了/g, '我换一种方式再为您解释'],
        [/怎么讲你才明白/g, '我再为您解释一遍'],
        [/怎么说你才明白/g, '我再为您解释一遍'],
        [/自己看/g, '您可以查看'],
        [/自己查/g, '您可以查询'],
        [/自己想办法/g, '我建议您尝试'],
        [/随便你/g, '您看这样是否可以'],
        [/爱信不信/g, '以上信息供您参考'],
        [/我不管/g, '我帮您看看如何处理'],
        [/我没办法/g, '我暂时没有其他办法'],
        [/搞不了/g, '暂时无法完成'],
        [/办不到/g, '暂时无法完成'],
        [/不关我的事/g, '这个问题我来帮您处理'],
        [/跟我无关/g, '这个问题我来帮您处理'],
        [/别烦我/g, '请问还有什么可以帮您'],
        [/别找我/g, '我帮您转给相关同事处理'],
        [/烦不烦/g, '请不要着急'],
        [/你傻吗/g, '我可能没有解释清楚'],
        [/你怎么还不明白/g, '我再为您解释一遍'],
        [/你爱信不信/g, '以上信息供您参考'],
        [/拉倒吧/g, '那我们先这样处理'],
        [/爱咋咋地/g, '您看这样是否可以']
      ];
      let out = text;
      for (const [re, rep] of replacements) out = out.replace(re, rep);
      return out;
    }

    // 抽取事实 token（数字、金额、日期等），用于校验改写后事实未丢失
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
      if (!needsRewrite(text)) return text; // 正常话术原样通过，绝不破坏
      try {
        let rewritten = ((await callLLM(text)) || '').trim();
        rewritten = rewritten.replace(/^["'“”「」『』]+|["'“”「」『』]+$/g, '').trim();
        if (!rewritten) return fallbackReplace(text);
        if (!factsPreserved(text, rewritten)) return fallbackReplace(text);
        return rewritten;
      } catch (e) {
        return fallbackReplace(text);
      }
    }

    ctx.on('llm/stream', (options, next) => {
      // 防递归：插件自己发起的内部 LLM 调用直接放行
      if (options && (options[INTERNAL] === true || internalDepth > 0)) {
        return next(options);
      }

      const upstream = next(options);

      return (async function* () {
        // 先缓冲整个流，按 index 聚合文本块
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

        // 改写每个文本块
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
