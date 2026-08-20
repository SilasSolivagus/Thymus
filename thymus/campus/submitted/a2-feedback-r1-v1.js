return {
  name: 'a2-forbidden-language-guard',
  inject: ['llm'],
  apply(ctx) {
    const INTERNAL_TAG = '[A2-INTERNAL]';
    const INTERNAL_SYM = Symbol('a2-internal');

    // SOP 例子 + 常见变体的启发式禁语检测（快速通道；语义兜底走模型）
    const FORBIDDEN_PATTERNS = [
      /不可能/, /做不到/, /没办法/, /没法子/,
      /无法(处理|解决|办理|满足|提供)/,
      /这不是我的责任/, /不是我的责任/, /不关我(的)?事/,
      /别找我/, /找我也没用/,
      /系统崩了/, /系统瘫了/,
      /系统(出|有|遇到)(bug|问题|故障|错误|异常)/i,
      /你听不懂吗/, /你听不明白吗/, /你怎么(就)?不明白/,
      /我说了多少遍/, /还要我说几遍/,
      /你自己看着办/, /爱办不办/, /随便你(怎么|吧)/,
      /别烦我/, /我很忙/, /没空(理|管)你/
    ];

    // 用于事实保真校验的常见材料词
    const MATERIAL_WORDS = [
      '身份证','学生证','校园卡','银行卡','录取通知书','发票','截图','证件',
      '复印件','原件','学号','手机号','账号','密码','订单号','合同','材料'
    ];

    const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, '');

    // 提取原文中的事实（数字/日期/材料词），检查改写后是否丢失
    function missingFacts(original, rewritten) {
      const o = norm(original);
      const r = norm(rewritten);
      const facts = new Set();
      const numRe = /\d+(?:\.\d+)?/g;
      let m;
      while ((m = numRe.exec(o)) !== null) facts.add(m[0]);
      const dateRes = [
        /\d{4}年\d{1,2}月\d{1,2}日/g,
        /\d{1,2}月\d{1,2}日/g,
        /\d{4}[-/]\d{1,2}[-/]\d{1,2}/g,
        /\d{4}年\d{1,2}月/g
      ];
      for (const re of dateRes) {
        while ((m = re.exec(o)) !== null) facts.add(m[0]);
      }
      for (const w of MATERIAL_WORDS) {
        if (o.includes(w)) facts.add(w);
      }
      return Array.from(facts).filter((f) => !r.includes(f));
    }

    // 把改写后的文本按原 text-delta 长度比例切回各 chunk，保证拼接结果一致
    function distributeText(text, lengths) {
      if (!lengths.length) return [];
      const total = lengths.reduce((a, b) => a + b, 0);
      if (total <= 0) return [text];
      const pieces = [];
      let pos = 0;
      for (let i = 0; i < lengths.length; i++) {
        if (i === lengths.length - 1) {
          pieces.push(text.slice(pos));
        } else {
          const end = Math.min(text.length, Math.round((text.length * (pos + lengths[i])) / total));
          pieces.push(text.slice(pos, end));
          pos = end;
        }
      }
      return pieces;
    }

    // 攒流：text-delta 累加；block-end(text) 视为整块权威文本（若更长则采用）
    async function collectText(iterable) {
      const chunks = [];
      let deltaText = '';
      let blockText = '';
      for await (const chunk of iterable) {
        chunks.push(chunk);
        if (chunk && chunk.type === 'text-delta' && typeof chunk.text === 'string') {
          deltaText += chunk.text;
        } else if (chunk && chunk.type === 'block-end' && chunk.block && chunk.block.type === 'text' && typeof chunk.block.text === 'string') {
          blockText += chunk.block.text;
        }
      }
      let fullText = deltaText;
      if (blockText && (!fullText || blockText.length > fullText.length)) {
        fullText = blockText;
      }
      return { chunks, fullText };
    }

    // 内部模型调用；system 里带 INTERNAL_TAG 用于防递归
    async function callLLM(system, userText) {
      if (!ctx.llm || typeof ctx.llm.stream !== 'function') {
        throw new Error('llm inject unavailable');
      }
      const options = {
        provider: 'deepseek-official',
        model: 'deepseek-chat',
        reasoningEffort: 'off',
        system: system + ' ' + INTERNAL_TAG,
        messages: [{
          role: 'user',
          content: [{ type: 'text', text: userText }],
          source: { kind: 'user' }
        }]
      };
      try { options[INTERNAL_SYM] = true; } catch (_) {}
      const { fullText } = await collectText(await ctx.llm.stream(options));
      return String(fullText || '').trim();
    }

    const SYSTEM_JUDGE_REWRITE = [
      "You are a compliance reviewer for a campus-network customer-service agent's outgoing replies.",
      "RULE A2: the reply must NOT contain negative attitude, aggressive questioning, blame-shifting, or dismissive expressions (examples: 不可能, 做不到, 没办法, 这不是我的责任, 系统崩了, 系统出bug了, 你听不懂吗).",
      "Given the agent's reply:",
      "- If it is FULLY compliant with A2, output exactly the single token PASS and nothing else.",
      "- If it VIOLATES A2, rewrite it so that: (1) every negative/aggressive/blaming/dismissive expression is replaced with positive, polite, cooperative, responsible phrasing; (2) ALL factual information is preserved EXACTLY and VERBATIM, including billing periods, dates, amounts, fees, deadlines, required materials/documents, account/order numbers, and any other concrete facts — do not change, omit, or add any fact; (3) the rest of the wording stays as close to the original as possible.",
      "Output ONLY the single token PASS or the rewritten reply."
    ].join('\n');

    const SYSTEM_REWRITE_ONLY = [
      "You are fixing a campus-network customer-service reply that contains a forbidden expression (negative attitude / aggressive questioning / blame-shifting / dismissive, e.g. 不可能, 做不到, 没办法, 这不是我的责任, 系统崩了, 系统出bug了, 你听不懂吗).",
      "Rewrite the reply so that: (1) every forbidden expression is replaced with positive, polite, cooperative, responsible phrasing; (2) ALL factual information is preserved EXACTLY and VERBATIM, including billing periods, dates, amounts, fees, deadlines, required materials/documents, account/order numbers, and any other concrete facts — do not change, omit, or add any fact; (3) the rest of the wording stays as close to the original as possible.",
      "Output ONLY the rewritten reply."
    ].join('\n');

    const SYSTEM_CONFIRM = [
      "Does the following campus-network customer-service reply contain ANY negative attitude, aggressive questioning, blame-shifting, or dismissive expression (examples: 不可能, 做不到, 没办法, 这不是我的责任, 系统崩了, 系统出bug了, 你听不懂吗)?",
      "Reply with exactly YES or NO."
    ].join('\n');

    // 最后兜底：确定性地替换已知禁语（不改动任何其他字符，天然保真）
    const DETERMINISTIC_REPLACEMENTS = [
      ['不可能', '目前暂时无法实现，我们会尽力协助您'],
      ['做不到', '目前暂时无法办理，我们会尽力协助您'],
      ['没办法', '非常抱歉，我们可以尝试其他方式'],
      ['这不是我的责任', '非常抱歉给您带来困扰，我来帮您核实处理'],
      ['不是我的责任', '非常抱歉，我来帮您核实处理'],
      ['不关我的事', '我来帮您处理'],
      ['系统崩了', '系统目前出现异常，正在紧急处理'],
      ['系统出bug了', '系统目前出现异常，正在排查修复'],
      ['系统出问题了', '系统目前出现异常，正在处理'],
      ['系统出故障了', '系统目前出现异常，正在处理'],
      ['你听不懂吗', '我换个方式为您说明'],
      ['你听不明白吗', '我换个方式为您说明'],
      ['你怎么不明白', '我为您再解释一遍'],
      ['我说了多少遍', '我再为您详细说明'],
      ['还要我说几遍', '我再为您详细说明']
    ];

    function sanitizeDeterministic(text) {
      let t = text;
      for (const [from, to] of DETERMINISTIC_REPLACEMENTS) {
        t = t.split(from).join(to);
      }
      return t;
    }

    const isPassOut = (s) => /^PASS[.\s]*$/i.test(String(s || '').trim());
    const isYes = (s) => /^YES[.\s]*$/i.test(String(s || '').trim());

    // 核心：判断 + 改写 + 事实保真校验
    async function enforce(fullText) {
      const definitelyViolates = FORBIDDEN_PATTERNS.some((re) => re.test(fullText));
      let out;
      if (definitelyViolates) {
        out = await callLLM(SYSTEM_REWRITE_ONLY, fullText);
      } else {
        out = await callLLM(SYSTEM_JUDGE_REWRITE, fullText);
        if (isPassOut(out)) return { action: 'pass' };
        // 模型疑似判定违规时，再确认一次，避免误伤合规话术
        const confirm = await callLLM(SYSTEM_CONFIRM, fullText);
        if (!isYes(confirm)) return { action: 'pass' };
      }
      if (!norm(out)) return { action: 'pass' };

      let missing = missingFacts(fullText, out);
      let stillForbidden = FORBIDDEN_PATTERNS.some((re) => re.test(out));
      if (missing.length || stillForbidden) {
        const retrySys = SYSTEM_REWRITE_ONLY + '\nSTRICT requirements for your output:' +
          (stillForbidden ? '\n- It must NOT contain any forbidden expression (negative attitude / aggressive questioning / blame-shifting / dismissive).' : '') +
          (missing.length ? '\n- These facts from the original MUST appear VERBATIM: ' + missing.join('、') + '.' : '') +
          '\nOutput ONLY the rewritten reply.';
        const retried = await callLLM(retrySys, fullText);
        if (norm(retried)) {
          out = retried;
          missing = missingFacts(fullText, out);
          stillForbidden = FORBIDDEN_PATTERNS.some((re) => re.test(out));
        }
      }

      if (missing.length || stillForbidden) {
        const safe = sanitizeDeterministic(fullText);
        if (safe !== fullText && !missingFacts(fullText, safe).length && !FORBIDDEN_PATTERNS.some((re) => re.test(safe))) {
          return { action: 'rewrite', text: safe };
        }
        return { action: 'pass' };
      }

      return { action: 'rewrite', text: out };
    }

    async function* transformUpstream(options, next) {
      const collected = await collectText(await next());
      const chunks = collected.chunks;
      const fullText = collected.fullText;

      if (!fullText || chunks.length === 0) {
        yield* chunks;
        return;
      }

      let result;
      try {
        result = await enforce(fullText);
      } catch (_) {
        // 模型调用失败时，退化为确定性替换，至少清掉已知禁语
        const safe = sanitizeDeterministic(fullText);
        result = safe !== fullText ? { action: 'rewrite', text: safe } : { action: 'pass' };
      }

      if (result.action === 'pass' || result.text === fullText) {
        yield* chunks;
        return;
      }

      const finalText = result.text;
      const deltaIdx = [];
      let blockEndIdx = -1;
      chunks.forEach((chunk, i) => {
        if (chunk && chunk.type === 'text-delta' && typeof chunk.text === 'string') deltaIdx.push(i);
        if (chunk && chunk.type === 'block-end' && chunk.block && chunk.block.type === 'text') blockEndIdx = i;
      });

      // 改写后按原 chunk 结构/顺序/index 重发，block-end 写整段新文本
      if (deltaIdx.length) {
        const pieces = distributeText(finalText, deltaIdx.map((i) => chunks[i].text.length));
        let p = 0;
        for (let i = 0; i < chunks.length; i++) {
          const chunk = chunks[i];
          if (chunk && chunk.type === 'text-delta' && typeof chunk.text === 'string') {
            yield { ...chunk, text: pieces[p++] };
          } else if (chunk && i === blockEndIdx && chunk.type === 'block-end') {
            yield { ...chunk, block: { ...(chunk.block || {}), text: finalText } };
          } else {
            yield chunk;
          }
        }
      } else if (blockEndIdx >= 0) {
        for (let i = 0; i < chunks.length; i++) {
          const chunk = chunks[i];
          if (chunk && i === blockEndIdx && chunk.type === 'block-end') {
            yield { ...chunk, block: { ...(chunk.block || {}), text: finalText } };
          } else {
            yield chunk;
          }
        }
      } else {
        yield* chunks;
      }
    }

    ctx.on('llm/stream', (options, next) => {
      const isInternal = !!(options && (
        options[INTERNAL_SYM] === true ||
        (typeof options.system === 'string' && options.system.indexOf(INTERNAL_TAG) >= 0)
      ));
      if (isInternal) return next();
      return transformUpstream(options, next);
    });
  }
};
