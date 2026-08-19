return {
  name: 'forbidden-service-phrases-filter',
  apply(ctx) {
    const entries = [
      // A1 精确内部术语（先长后短，避免子串误替换）
      { phrase: 'BAS系统', re: /BAS系统/g, to: '认证系统' },
      { phrase: 'BOSS系统', re: /BOSS系统/g, to: '计费系统' },
      { phrase: '工单退回', re: /工单退回/g, to: '申请被退回' },
      { phrase: 'portal', re: /portal/gi, to: '认证门户' },
      { phrase: 'BAS', re: /BAS/gi, to: '认证系统' },
      { phrase: 'BOSS', re: /BOSS/gi, to: '计费系统' },
      // A2 语义消极/强势质问/甩锅
      { phrase: '这不是我的责任', re: /这不是我的责任/g, to: '我会帮您转交相关部门处理' },
      { phrase: '不是我的责任', re: /不是我的责任/g, to: '我会帮您转交相关部门处理' },
      { phrase: '不归我管', re: /不归我管/g, to: '我帮您转交相关部门处理' },
      { phrase: '不归我负责', re: /不归我负责/g, to: '我帮您转交相关部门处理' },
      { phrase: '不是我的问题', re: /不是我的问题/g, to: '我会帮您转交相关部门处理' },
      { phrase: '跟我没关系', re: /跟我没关系/g, to: '我帮您转交相关部门处理' },
      { phrase: '你找别人吧', re: /你找别人吧/g, to: '我帮您转交相关部门处理' },
      { phrase: '你去找领导', re: /你去找领导/g, to: '我帮您转交相关部门处理' },
      { phrase: '系统崩了', re: /系统崩了/g, to: '系统暂时出现波动' },
      { phrase: '系统出bug了', re: /系统出bug了/g, to: '系统暂时出现异常' },
      { phrase: '出bug了', re: /出bug了/g, to: '系统暂时出现异常' },
      { phrase: '宕机了', re: /宕机了/g, to: '系统暂时出现波动' },
      { phrase: '你听不懂吗', re: /你听不懂吗/g, to: '我再为您详细解释' },
      { phrase: '听不明白吗', re: /听不明白吗/g, to: '我再为您详细解释' },
      { phrase: '听明白了吗', re: /听明白了吗/g, to: '您看这样理解是否正确' },
      { phrase: '你懂不懂', re: /你懂不懂/g, to: '我为您解释一下' },
      { phrase: '你怎么还不明白', re: /你怎么还不明白/g, to: '我再为您说明' },
      { phrase: '我说了多少遍', re: /我说了多少遍/g, to: '我再为您说明' },
      { phrase: '别问了', re: /别问了/g, to: '我继续为您处理' },
      { phrase: '不要再问了', re: /不要再问了/g, to: '我继续为您处理' },
      { phrase: '你烦不烦', re: /你烦不烦/g, to: '我继续为您服务' },
      { phrase: '你到底想怎样', re: /你到底想怎样/g, to: '请问还有什么可以帮您' },
      { phrase: '不可能', re: /不可能/g, to: '我可以帮您进一步确认' },
      { phrase: '做不到', re: /做不到/g, to: '我可以帮您进一步确认' },
      { phrase: '没办法', re: /没办法/g, to: '我可以帮您进一步确认' },
      { phrase: '办不了', re: /办不了/g, to: '我可以帮您进一步确认' },
      { phrase: '解决不了', re: /解决不了/g, to: '我可以帮您进一步确认' },
      { phrase: '处理不了', re: /处理不了/g, to: '我可以帮您进一步确认' }
    ];
    const maxLen = Math.max.apply(null, entries.map(function (e) { return e.phrase.length; }));

    function sanitizeFull(text) {
      let out = text;
      for (let i = 0; i < entries.length; i++) {
        out = out.replace(entries[i].re, entries[i].to);
      }
      return out;
    }

    ctx.on('llm/stream', function (options, next) {
      const upstream = next();
      return (async function* () {
        let pending = '';
        for await (const chunk of upstream) {
          if (!chunk) continue;
          if (chunk.type === 'text-delta') {
            pending += chunk.text || '';
            let out = '';
            let guard = 0;
            while (pending.length > 0 && guard++ < 500) {
              let idx = -1;
              let hit = null;
              for (let i = 0; i < entries.length; i++) {
                const e = entries[i];
                e.re.lastIndex = 0;
                const m = e.re.exec(pending);
                if (m && (idx === -1 || m.index < idx)) {
                  idx = m.index;
                  hit = e;
                }
              }
              if (idx === -1) {
                const hold = Math.min(maxLen - 1, pending.length);
                out += pending.slice(0, pending.length - hold);
                pending = pending.slice(pending.length - hold);
                break;
              }
              if (idx > 0) {
                out += pending.slice(0, idx);
                pending = pending.slice(idx);
                continue;
              }
              hit.re.lastIndex = 0;
              const m = hit.re.exec(pending);
              const matched = m ? m[0] : hit.phrase;
              out += hit.to;
              pending = pending.slice(matched.length);
            }
            if (out) yield { ...chunk, text: out };
          } else if (chunk.type === 'block-end' && chunk.block && chunk.block.type === 'text') {
            const full = sanitizeFull(chunk.block.text || '');
            yield { ...chunk, block: { ...chunk.block, text: full } };
            pending = '';
          } else {
            yield chunk;
          }
        }
        if (pending.length) {
          yield { type: 'text-delta', text: sanitizeFull(pending) };
        }
      })();
    });
  }
};