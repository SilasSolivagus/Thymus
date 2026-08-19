return {
  name: 'internal-note-redactor',
  apply(ctx) {
    function stripInternalNotes(text) {
      if (typeof text !== 'string' || text === '') return text;
      // 结构化去除：递归删除 _internal_note 键
      try {
        const data = JSON.parse(text);
        const clean = (function removeKey(v) {
          if (Array.isArray(v)) return v.map(removeKey);
          if (v && typeof v === 'object') {
            const out = {};
            for (const k of Object.keys(v)) {
              if (k === '_internal_note') continue;
              out[k] = removeKey(v[k]);
            }
            return out;
          }
          return v;
        })(data);
        return JSON.stringify(clean);
      } catch (e) {
        // 非纯 JSON 文本的正则兜底
        let out = text;
        out = out.replace(/"_internal_note"\s*:\s*"[^"]*"/g, '');
        out = out.replace(/"_internal_note"\s*:\s*[^,}\]]+/g, '');
        out = out.replace(/'_internal_note'\s*:\s*'[^']*'/g, '');
        out = out.replace(/_internal_note\s*:\s*[^,\n}\]]+/g, '');
        out = out.replace(/,\s*([}\]])/g, '$1');
        out = out.replace(/,\s*,/g, ',');
        return out;
      }
    }

    // 主防线：query_bill 产出在进入模型上下文前就把内部字段抹掉
    ctx.on('tools/post-execute', function (exec, result, next) {
      if (exec && exec.name === 'query_bill' && result && result.content && result.content[0]) {
        const text = result.content[0].text || '';
        return { kind: 'accept', content: [{ type: 'text', text: stripInternalNotes(text) }] };
      }
      return next();
    });

    // 兜底防线：即便模型仍输出含内部字段的内容，也逐字清理
    ctx.on('llm/stream', function (options, next) {
      const upstream = next();
      return (async function* () {
        let pending = '';
        for await (const chunk of upstream) {
          if (!chunk) continue;
          if (chunk.type === 'text-delta') {
            pending += chunk.text || '';
            const HOLD = 30;
            if (pending.length > HOLD) {
              yield { ...chunk, text: stripInternalNotes(pending.slice(0, -HOLD)) };
              pending = pending.slice(-HOLD);
            }
          } else if (chunk.type === 'block-end' && chunk.block && chunk.block.type === 'text') {
            const full = (chunk.block.text != null && chunk.block.text !== '') ? chunk.block.text : pending;
            pending = '';
            yield { ...chunk, block: { ...chunk.block, text: stripInternalNotes(full) } };
          } else {
            yield chunk;
          }
        }
        if (pending.length) {
          yield { type: 'text-delta', text: stripInternalNotes(pending) };
        }
      })();
    });
  }
};