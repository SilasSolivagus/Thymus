return {
  name: 'out-of-scope-guard',
  apply(ctx) {
    let outOfScopeSchool = null;
    let anyNetworkChecked = false;

    // 非运营学校：query_network 返回查无/未覆盖时记录该校
    ctx.on('tools/post-execute', function (exec, result, next) {
      if (exec && exec.name === 'query_network') {
        const text = (result && result.content && result.content[0] && result.content[0].text) || '';
        if (/not_found|unknown|未覆盖|非运营|不在服务范围|暂不支持|查无此校|无此学校/i.test(text)) {
          outOfScopeSchool = (exec.arguments && exec.arguments.school) || '该校';
        } else if (text) {
          anyNetworkChecked = true;
        }
      }
      return next();
    });

    const topicPatterns = [
      /退费/, /退款/, /注销账号/, /注销/, /过户/, /改套餐/, /换套餐/, /办理宽带/, /新装/, /移机/,
      /国际漫游/, /境外/, /政企/, /单位报销/, /报销/, /开发票/, /发票/, /盖章/, /投诉/, /举报/,
      /法律援助/, /公安/, /警察/, /司法/, /校外/, /访客/, /商业合作/, /校园代理/, /校外人员/
    ];
    const promisePatterns = [
      /可以办/, /没问题/, /马上为您办/, /保证/, /承诺/, /一定/, /包在我身上/, /放心/, /肯定/,
      /能办/, /我来处理/, /帮您办/, /帮您处理/, /没有问题/, /完全可以/, /妥妥的/
    ];
    const redirect = '非常抱歉，这个问题超出了我们的服务范围和权限。建议您联系学校相关部门（例如信息化办公室或运营商）处理，我也可以帮您记录转交。';

    function hasNetworkStatus(text) {
      const hasCtx = /网络|学校|该校|校区|校园网|宽带/.test(text);
      const hasStatus = /正常|故障|断网|恢复|维修|维护|上网|信号|修复|没问题/.test(text);
      return hasCtx && hasStatus;
    }

    function shouldRedirect(text) {
      if (!text) return false;
      // 非运营学校：一旦确认该校超范围，任何对该校网络状态的硬答都拦截
      if (outOfScopeSchool) {
        const mentionsSchool = text.indexOf(outOfScopeSchool) !== -1 || /该校|该学校/.test(text);
        if (mentionsSchool && hasNetworkStatus(text)) return true;
      }
      // 未查过网络却声称网络状态，属于硬答
      if (hasNetworkStatus(text) && !anyNetworkChecked) return true;
      // 超出权限话题 + 承诺/硬答措辞
      const hasTopic = topicPatterns.some(function (re) { return re.test(text); });
      const hasPromise = promisePatterns.some(function (re) { return re.test(text); });
      return hasTopic && hasPromise;
    }

    ctx.on('llm/stream', function (options, next) {
      const upstream = next();
      return (async function* () {
        let pending = '';
        for await (const chunk of upstream) {
          if (!chunk) continue;
          if (chunk.type === 'text-delta') {
            pending += chunk.text || '';
          } else if (chunk.type === 'block-end' && chunk.block && chunk.block.type === 'text') {
            const full = (chunk.block.text != null && chunk.block.text !== '') ? chunk.block.text : pending;
            pending = '';
            if (shouldRedirect(full)) {
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
          yield { type: 'text-delta', text: shouldRedirect(full) ? redirect : full };
        }
      })();
    });
  }
};