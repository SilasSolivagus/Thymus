return {
  name: 'identity-prerequisite-guard',
  apply(ctx) {
    let authenticated = false;

    // 认人成功标记：lookup_account 返回真实用户才算成功
    ctx.on('tools/post-execute', function (exec, result, next) {
      if (exec && exec.name === 'lookup_account') {
        const text = (result && result.content && result.content[0] && result.content[0].text) || '';
        if (text && !/not_found|查无此人|未找到|未查询到/i.test(text)) {
          authenticated = true;
        } else {
          authenticated = false;
        }
      }
      return next();
    });

    // 工具层兜底：未认人前禁止查询账期/费用
    ctx.on('tools/pre-execute', function (exec, next) {
      if (exec && exec.name === 'query_bill' && !authenticated) {
        return { kind: 'deny', reason: '未完成身份核实：涉及账期/费用/账号详情的问题，必须先成功调用 lookup_account 获取用户身份。' };
      }
      return next();
    });

    const accountPatterns = [
      /账期/, /费用/, /余额/, /欠费/, /账单/, /月租/, /套餐/, /停机/, /账号/, /认证状态/, /已认证/, /未认证/, /应缴/, /缴费/, /扣费/
    ];
    const redirect = '请先提供您的学号和手机号，我为您核实身份后，再帮您查询相关信息。';

    // 说话层兜底：未认人却输出账号相关内容时整段改为要求核实身份
    ctx.on('llm/stream', function (options, next) {
      const upstream = next();
      return (async function* () {
        if (authenticated) {
          yield* upstream;
          return;
        }
        let pending = '';
        for await (const chunk of upstream) {
          if (!chunk) continue;
          if (chunk.type === 'text-delta') {
            pending += chunk.text || '';
          } else if (chunk.type === 'block-end' && chunk.block && chunk.block.type === 'text') {
            const full = (chunk.block.text != null && chunk.block.text !== '') ? chunk.block.text : pending;
            pending = '';
            if (accountPatterns.some(function (re) { return re.test(full); })) {
              yield { type: 'text-delta', text: redirect };
              yield { ...chunk, block: { ...chunk.block, text: redirect } };
            } else {
              if (full) yield { type: 'text-delta', text: full };
              yield chunk;
            }
          } else {
            yield chunk;
          }
        }
        if (pending.length) {
          const full = pending;
          const bad = accountPatterns.some(function (re) { return re.test(full); });
          yield { type: 'text-delta', text: bad ? redirect : full };
        }
      })();
    });
  }
};