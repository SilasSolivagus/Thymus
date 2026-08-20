return {
  name: 'a2-forbidden-language-guard',
  inject: ['llm'],
  apply(ctx) {
    const INTERNAL_TAG = '[A2-INTERNAL]';
    const INTERNAL_SYM = Symbol('a2-internal');

    // 词表/正则只作为「辅助信号」和「确定性兜底」，不再是是否调用模型的闸门。
    const FORBIDDEN_PATTERNS = [
      // —— 态度消极 / 拒绝推诿 ——
      /不可能/, /做不到/, /没办法/, /没法子/, /解决不了/, /处理不了/, /办不了/,
      /无法(处理|解决|办理|满足|提供)/,
      /管不了/, /管不着/, /没法管/, /管不过来/,
      /不归(我|我们)(管|负责)/, /不是(我|我们)的责任/,
      /这不是我的责任/, /不是我的责任/, /不关(我|我们)(的)?事/,
      /不关你(的)?事/, /跟你(没|无)关系/, /与你无关/,
      /(你|您)去找别人/, /找别人(吧|去)?/, /去找别人/,
      /别(再)?找(我|我们)/, /找(我|我们)也没用/,
      /跟(我|我们)没关系/, /与(我|我们)无关/,
      // —— 强势质问 ——
      /你听不懂吗/, /你听不懂么/, /听不明白吗/, /听不明白么/,
      /听明白没有/, /听懂没有/, /听没听明白/, /明白没有/,
      /你到底(听|懂|明白|想)/, /你(是)?不是(傻|聋|瞎|笨)/,
      /这(都|也)(不|没)?懂/, /这都理解不了/,
      /还用我(再)?说/, /非要我(再)?(说|重复)/,
      /难道(你)?不知道/, /你不知道(吗|么)/,
      /你怎么(还|就)不明白/, /还没听懂/, /还听不明白/,
      /我说了多少遍/, /还要我说几遍/,
      // —— 驱赶 / 敷衍 ——
      /别再问(了)?/, /别问(了|我|我们)?/, /不要再问/, /不要问(了)?/,
      /别老(是)?问/, /别一直问/, /别来(问|烦|打扰)/,
      /这个情况就这样/, /这事就这样/, /到此为止/,
      /不用再(说|问|联系)/, /别(再)?(联系|来)/,
      /自己(想办法|解决)(吧|去)?/, /自己去(办|处理|解决)/,
      /爱找谁找谁/, /爱咋咋地/, /随便你(怎么|吧|去哪)/, /你爱怎么(样|办)/,
      /你自己看着办/, /爱办不办/, /别烦(我|我们)/, /我很忙/, /没空(理|管)你/,
      // —— 归咎用户 ——
      /怪谁/, /怨谁/, /都怪你/, /怪你自己/, /怨你自己/,
      /这能怪(谁|你|我|我们)/, /怪不到(我|我们)/, /怪就怪(你|你自己)/,
      /谁让你不/, /谁叫你不/, /是你自己(没|不|弄|搞|交|填)/,
      /当初是你自己/, /是(你|您)自己(的)?(问题|原因|错)/, /怨不得/
    ];

    const MATERIAL_WORDS = [
      '身份证','学生证','校园卡','银行卡','录取通知书','发票','截图','证件',
      '复印件','原件','学号','手机号','账号','密码','订单号','合同','材料'
    ];

    const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, '');

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

    const A2_RULE_DESC =
      'A2 forbidden expressions include, but are not limited to: ' +
      'refusing/dodging (不可能, 做不到, 没办法, 管不了, 管不着, 不归我管, 你去找别人, 这不是我的责任, 跟我没关系, 系统崩了, 系统出bug了); ' +
      'aggressive questioning (你听不懂吗, 你到底听明白没有, 听懂没有, 明白没有, 还要我说几遍); ' +
      'dismissive/driving away (别再问了, 别问了, 就这样吧, 自己解决); ' +
      'blaming the user (怪谁, 是你自己没交费, 都怪你, 谁让你不...). ' +
      'Any sentence with a negative, reproachful, blame-shifting, or dismissive tone toward the user is a violation, even if not listed verbatim.';

    const SYSTEM_JUDGE_REWRITE = [
      "You are a compliance reviewer for a campus-network customer-service agent's outgoing replies.",
      "RULE A2: the reply must NOT contain negative attitude, aggressive questioning, blame-shifting, dismissive, or user-blaming expressions.",
      A2_RULE_DESC,
      "Given the agent's reply, judge whether it violates RULE A2.",
      "- If it is FULLY compliant, output exactly the single token PASS and nothing else.",
      "- If it VIOLATES A2, output ONLY a rewritten reply that: (1) replaces every negative/aggressive/blaming/dismissive expression with positive, polite, cooperative, responsible phrasing; (2) preserves ALL factual information EXACTLY and VERBATIM, including billing periods, dates, amounts, fees, deadlines, required materials/documents, account/order numbers, and any other concrete facts — do not change, omit, or add any fact; (3) keeps the rest of the wording as close to the original as possible.",
      "Output ONLY the single token PASS or the rewritten reply. Do not output explanations, quotes, or extra text."
    ].join('\n');

    const SYSTEM_REWRITE_ONLY = [
      "You are fixing a campus-network customer-service reply that contains A2 forbidden expressions (negative attitude / aggressive questioning / blame-shifting / dismissive / user-blaming).",
      A2_RULE_DESC,
      "Rewrite the reply so that: (1) every forbidden expression is replaced with positive, polite, cooperative, responsible phrasing; (2) ALL factual information is preserved EXACTLY and VERBATIM, including billing periods, dates, amounts, fees, deadlines, required materials/documents, account/order numbers, and any other concrete facts — do not change, omit, or add any fact; (3) the rest of the wording stays as close to the original as possible.",
      "Output ONLY the rewritten reply. Do not output explanations, quotes, or extra text."
    ].join('\n');

    const SYSTEM_CONFIRM = [
      "Does the following campus-network customer-service reply contain ANY negative attitude, aggressive questioning, blame-shifting, dismissive, or user-blaming expression?",
      A2_RULE_DESC,
      "Reply with exactly YES or NO."
    ].join('\n');

    const DETERMINISTIC_REPLACEMENTS = [
      ['这事我管不了', '这事我来帮您跟进处理'],
      ['这事我管不着', '这事我来帮您协调处理'],
      ['我管不了', '我来帮您跟进处理'],
      ['我管不着', '我来帮您协调处理'],
      ['管不了', '我们来帮您跟进处理'],
      ['管不着', '我们来帮您协调处理'],
      ['不归我管', '我来帮您转给负责的同事'],
      ['不归我们管', '我们帮您转给负责的同事'],
      ['不归我负责', '我来帮您转给负责的同事'],
      ['不归我们负责', '我们帮您转给负责的同事'],
      ['不是我的责任', '非常抱歉给您带来困扰，我来帮您核实处理'],
      ['不是我们的责任', '非常抱歉给您带来困扰，我们来帮您核实处理'],
      ['跟我没关系', '我来帮您核实处理'],
      ['跟我们没关系', '我们来帮您核实处理'],
      ['与我无关', '我来帮您核实处理'],
      ['与我们无关', '我们来帮您核实处理'],
      ['不关我的事', '我来帮您处理'],
      ['不关我们的事', '我们来帮您处理'],
      ['不关你的事', '非常抱歉，这事我来帮您处理'],
      ['跟你没关系', '非常抱歉，这事我来帮您核实'],
      ['与你无关', '非常抱歉，这事我来帮您核实'],
      ['您去找别人吧', '我来帮您处理'],
      ['你去找别人吧', '我来帮您处理'],
      ['您去找别人', '我来帮您联系相关部门处理'],
      ['你去找别人', '我来帮您联系相关部门处理'],
      ['找别人吧', '我来帮您处理'],
      ['找别人', '帮您转给相关部门'],
      ['别找我', '我来帮您处理'],
      ['别找我们', '我们来帮您处理'],
      ['找我也没用', '我来帮您想办法处理'],
      ['找我们也没用', '我们来帮您想办法处理'],
      ['你到底听明白没有', '我换个方式为您说明'],
      ['你到底听懂没有', '我换个方式为您说明'],
      ['你听明白没有', '我换个方式为您说明'],
      ['你听懂没有', '我换个方式为您说明'],
      ['听明白没有', '我换个方式为您说明'],
      ['听懂没有', '我换个方式为您说明'],
      ['听没听明白', '我换个方式为您说明'],
      ['明白没有', '我再为您说明一下'],
      ['你到底想怎样', '我来帮您解决问题'],
      ['你到底想怎么样', '我来帮您解决问题'],
      ['你听不懂吗', '我换个方式为您说明'],
      ['你听不懂么', '我换个方式为您说明'],
      ['听不明白吗', '我换个方式为您说明'],
      ['听不明白么', '我换个方式为您说明'],
      ['还不明白吗', '我换个方式为您说明'],
      ['你怎么还不明白', '我为您再解释一遍'],
      ['怎么还不明白', '我为您再解释一遍'],
      ['还用我说吗', '我再为您说明一下'],
      ['还用我说么', '我再为您说明一下'],
      ['非要我说几遍', '我再为您详细说明'],
      ['我说了多少遍', '我再为您详细说明'],
      ['还要我说几遍', '我再为您详细说明'],
      ['别再问了', '如果还有其他疑问，我继续为您解答'],
      ['不要再问了', '如果还有其他疑问，我继续为您解答'],
      ['不要问了', '如果还有其他疑问，我继续为您解答'],
      ['别问了', '如果还有其他疑问，我继续为您解答'],
      ['别老问', '如果还有其他疑问，我继续为您解答'],
      ['别一直问', '如果还有其他疑问，我继续为您解答'],
      ['别来问了', '如果还有其他疑问，我继续为您解答'],
      ['不用再问了', '如果还有其他疑问，我继续为您解答'],
      ['这个情况就这样', '这个情况我们会继续跟进'],
      ['这事就这样', '这事我们会继续跟进'],
      ['到此为止', '我们帮您做后续安排'],
      ['不用再联系', '有进展我们会主动联系您'],
      ['别来烦我', '非常抱歉给您带来困扰，我来帮您处理'],
      ['自己想办法', '我帮您想办法'],
      ['自己解决', '我帮您协调处理'],
      ['爱找谁找谁', '我来帮您处理'],
      ['爱咋咋地', '我来帮您处理'],
      ['随便你吧', '我帮您确认一下'],
      ['随便你怎么', '我帮您确认一下'],
      ['你自己看着办', '我来帮您确认处理'],
      ['爱办不办', '我来帮您处理'],
      ['是你自己没', '因为没'],
      ['是你自己不', '因为不'],
      ['谁让你不', '因为没'],
      ['谁叫你不', '因为没'],
      ['怪谁', '我来帮您处理'],
      ['怨谁', '我来帮您处理'],
      ['都怪你', '我来帮您处理'],
      ['怪你自己', '我来帮您处理'],
      ['怨你自己', '我来帮您处理'],
      ['这能怪谁', '我来帮您处理'],
      ['这能怪你', '我来帮您处理'],
      ['怪不到我们', '我们来帮您处理'],
      ['怪不到我', '我来帮您处理'],
      ['怪就怪你', '我来帮您处理'],
      ['怪就怪你自己', '我来帮您处理'],
      ['当初是你自己', '非常抱歉给您带来不便，我来帮您处理'],
      ['是你自己的问题', '非常抱歉，我来帮您核实处理'],
      ['是你自己的原因', '非常抱歉，我来帮您核实处理'],
      ['怨不得', '非常抱歉，我来帮您处理']
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

    async function safeCallLLM(system, userText, fallback) {
      try {
        const out = await callLLM(system, userText);
        return out;
      } catch (_) {
        return fallback;
      }
    }

    // 语义判定主闸：无条件先问模型，词表只是辅助信号（用于覆盖模型漏判），不是调用模型的门槛。
    async function enforce(fullText) {
      const definitelyViolates = FORBIDDEN_PATTERNS.some((re) => re.test(fullText));

      let out = await safeCallLLM(SYSTEM_JUDGE_REWRITE, fullText, '');
      const judgeSaysPass = isPassOut(out);

      if (judgeSaysPass && !definitelyViolates) {
        return { action: 'pass' };
      }
      if (judgeSaysPass && definitelyViolates) {
        // 词表明确命中、模型却漏判 → 强制用改写专用提示重问
        out = await safeCallLLM(SYSTEM_REWRITE_ONLY, fullText, '');
      } else if (!judgeSaysPass && !definitelyViolates) {
        // 模型判违规、词表未命中：这是纯语义判定命中的情况，二次确认防误伤合规话术
        let confirm = await safeCallLLM(SYSTEM_CONFIRM, fullText, 'YES');
        if (!isYes(confirm)) return { action: 'pass' };
      }
      // 词表命中且模型已给出改写 → 双信号一致，直接采用

      if (!norm(out)) {
        const safe = sanitizeDeterministic(fullText);
        return safe !== fullText ? { action: 'rewrite', text: safe } : { action: 'pass' };
      }

      let missing = missingFacts(fullText, out);
      let stillForbidden = FORBIDDEN_PATTERNS.some((re) => re.test(out));
      if (missing.length || stillForbidden) {
        const retrySys = SYSTEM_REWRITE_ONLY + '\nSTRICT requirements for your output:' +
          (stillForbidden ? '\n- It must NOT contain any forbidden expression (negative attitude / aggressive questioning / blame-shifting / dismissive / user-blaming).' : '') +
          (missing.length ? '\n- These facts from the original MUST appear VERBATIM: ' + missing.join('、') + '.' : '') +
          '\nOutput ONLY the rewritten reply.';
        const retried = await safeCallLLM(retrySys, fullText, '');
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
