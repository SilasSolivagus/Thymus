// A2 服务禁语过滤插件
// 拦截 llm/stream，对 agent 直接输出的文本流做改写：
//   1) 替换态度消极、强势质问、甩锅推诿类表达（语义消极，无精确边界，按 SOP 示例及常见变体处理）；
//   2) 只做短语级替换，其余内容（账期、金额、材料等事实信息）原样保留，不丢失、不改变。
// 流式处理：text-delta 增量文本用“保留最长禁语前缀”的方式延迟输出，避免禁语被切分漏网；
// block-end 的完整文本再做一次全量改写，保证最终内容合规且完整。
// 所有合成 chunk 都携带原 chunk 的 index，避免下游把它当成新的一块。

const FORBIDDEN = [
  // ---- 态度消极 / 拒绝 ----
  { phrase: '不可能', replacement: '暂时无法' },
  { phrase: '做不到', replacement: '暂时无法做到' },
  { phrase: '办不到', replacement: '暂时无法办到' },
  { phrase: '没办法', replacement: '暂时没有更好的办法' },
  { phrase: '没法子', replacement: '暂时没有更好的办法' },
  { phrase: '没法办', replacement: '暂时无法办理' },
  { phrase: '无能为力', replacement: '会尽力为您协调处理' },
  { phrase: '爱莫能助', replacement: '会尽力为您协调处理' },
  { phrase: '解决不了', replacement: '正在想办法为您解决' },
  { phrase: '处理不了', replacement: '正在为您协调处理' },
  { phrase: '帮不了你', replacement: '我会尽量帮您想办法' },
  { phrase: '帮不了您', replacement: '我会尽量帮您想办法' },
  { phrase: '帮不上忙', replacement: '我会尽量帮您想办法' },
  { phrase: '帮不上您', replacement: '我会尽量帮您想办法' },
  { phrase: '这我没办法', replacement: '我会继续帮您跟进' },
  { phrase: '我也没办法', replacement: '我会继续帮您跟进' },
  // ---- 甩锅推诿 ----
  { phrase: '这不是我的责任', replacement: '我来帮您核实处理' },
  { phrase: '不是我的责任', replacement: '我来帮您核实处理' },
  { phrase: '这不是我的错', replacement: '我来帮您核实处理' },
  { phrase: '不是我的错', replacement: '我来帮您核实处理' },
  { phrase: '不归我管', replacement: '我帮您转达相关部门处理' },
  { phrase: '不归我负责', replacement: '我帮您转达相关部门处理' },
  { phrase: '跟我没关系', replacement: '我来帮您跟进处理' },
  { phrase: '跟我没有关系', replacement: '我来帮您跟进处理' },
  { phrase: '不关我的事', replacement: '我来帮您跟进处理' },
  { phrase: '不关我事', replacement: '我来帮您跟进处理' },
  { phrase: '别问我', replacement: '我帮您核实一下' },
  { phrase: '你找别人吧', replacement: '我帮您联系相关人员处理' },
  { phrase: '找别人去', replacement: '我帮您联系相关人员处理' },
  // ---- 系统故障类甩锅 ----
  { phrase: '系统崩了', replacement: '系统暂时出现异常' },
  { phrase: '系统挂了', replacement: '系统暂时出现异常' },
  { phrase: '系统宕机', replacement: '系统暂时出现异常' },
  { phrase: '系统出bug了', replacement: '系统暂时出现异常' },
  { phrase: '系统出bug', replacement: '系统暂时出现异常' },
  { phrase: '系统有bug', replacement: '系统暂时出现异常' },
  { phrase: '系统出故障', replacement: '系统暂时出现异常' },
  { phrase: '系统故障', replacement: '系统暂时出现异常' },
  { phrase: '服务器崩了', replacement: '服务器暂时出现异常' },
  { phrase: '服务器挂了', replacement: '服务器暂时出现异常' },
  // ---- 强势质问 / 不耐烦 / 不礼貌 ----
  { phrase: '你听不懂吗', replacement: '我再为您说明一下' },
  { phrase: '你听不明白吗', replacement: '我换一种方式为您说明' },
  { phrase: '听不懂吗', replacement: '我再为您说明一下' },
  { phrase: '听不明白吗', replacement: '我再为您说明一下' },
  { phrase: '你怎么还不明白', replacement: '我再为您详细解释一下' },
  { phrase: '还不明白吗', replacement: '我再为您详细解释一下' },
  { phrase: '我说得还不够清楚吗', replacement: '我再为您详细说明一下' },
  { phrase: '我说得不够清楚吗', replacement: '我再为您详细说明一下' },
  { phrase: '你自己不会看吗', replacement: '我帮您查一下' },
  { phrase: '你不会自己查吗', replacement: '我帮您查一下' },
  { phrase: '你爱信不信', replacement: '您可以再核实一下，我这边也帮您确认' },
  { phrase: '你自己看着办', replacement: '您看您方便怎么处理' },
  { phrase: '你自己想办法', replacement: '我帮您一起想办法' },
  { phrase: '你到底想怎样', replacement: '请问您具体需要什么帮助' },
  { phrase: '你到底想干嘛', replacement: '请问您具体需要什么帮助' },
  { phrase: '你到底想干什么', replacement: '请问您具体需要什么帮助' },
  { phrase: '你烦不烦', replacement: '我尽量帮您解决问题' },
  { phrase: '别烦我', replacement: '我尽量为您解答' },
  { phrase: '别来烦我', replacement: '我尽量为您解答' },
];

// 优先匹配更长的表达，避免短规则抢先替换长规则的一部分
FORBIDDEN.sort((a, b) => b.phrase.length - a.phrase.length);

// 在 text 的 start 位置尝试匹配 phrase，允许 phrase 内部出现空白，ASCII 忽略大小写
function matchAt(text, start, phrase) {
  let j = 0;
  let i = start;
  while (j < phrase.length) {
    while (i < text.length && /\s/.test(text[i])) i++;
    if (i >= text.length) return null;
    if (text[i].toLowerCase() !== phrase[j].toLowerCase()) return null;
    i++;
    j++;
  }
  return i;
}

// 整段文本做短语级替换；非禁语内容（数字、日期、材料等事实信息）原样保留
function replaceForbidden(text) {
  let result = '';
  let i = 0;
  while (i < text.length) {
    let matched = false;
    for (const rule of FORBIDDEN) {
      const end = matchAt(text, i, rule.phrase);
      if (end !== null) {
        result += rule.replacement;
        i = end;
        matched = true;
        break;
      }
    }
    if (!matched) {
      result += text[i];
      i++;
    }
  }
  return result;
}

// 流式切分：找出 buf 中最长的、属于某个禁语前缀的后缀（容忍内部空白、忽略 ASCII 大小写），
// 先不输出，等确认完整后再处理，避免禁语被切分到两个 chunk 漏网。
function splitSafe(buf) {
  let keep = 0;
  for (const rule of FORBIDDEN) {
    const p = rule.phrase;
    const maxK = Math.min(buf.length, p.length + 8);
    for (let k = maxK; k >= 1; k--) {
      const suffix = buf.slice(buf.length - k);
      const norm = suffix.replace(/\s+/g, '');
      if (norm.length > 0 && norm.length <= p.length &&
          p.slice(0, norm.length).toLowerCase() === norm.toLowerCase()) {
        if (k > keep) keep = k;
        break;
      }
    }
  }
  return { emit: buf.slice(0, buf.length - keep), keep: buf.slice(buf.length - keep) };
}

async function* transformStream(upstream) {
  let pending = '';
  let lastIndex;
  let lastChunk;

  for await (const chunk of upstream) {
    if (chunk && typeof chunk === 'object') {
      if (chunk.index !== undefined) lastIndex = chunk.index;
      lastChunk = chunk;
    }

    if (chunk && chunk.type === 'text-delta' && typeof chunk.text === 'string') {
      pending += chunk.text;
      const { emit, keep } = splitSafe(pending);
      pending = keep;
      if (emit.length > 0) {
        const corrected = replaceForbidden(emit);
        if (corrected.length > 0) {
          yield {
            ...chunk,
            index: chunk.index ?? lastIndex ?? 0,
            text: corrected,
          };
        }
      }
    } else if (
      chunk &&
      chunk.type === 'block-end' &&
      chunk.block &&
      chunk.block.type === 'text' &&
      typeof chunk.block.text === 'string'
    ) {
      // 文本块结束：pending 内容已包含在 block.text 的完整文本里，
      // 直接基于完整文本改写输出，保证最终内容完整、合规。
      pending = '';
      const corrected = replaceForbidden(chunk.block.text);
      yield {
        ...chunk,
        index: chunk.index ?? lastIndex ?? 0,
        block: { ...chunk.block, type: 'text', text: corrected },
      };
    } else {
      yield chunk;
    }
  }

  // 流结束时若还有未决内容（正常情况 block-end 已清空 pending），兜底输出
  if (pending.length > 0) {
    const corrected = replaceForbidden(pending);
    if (corrected.length > 0) {
      const base = lastChunk && typeof lastChunk === 'object' ? lastChunk : {};
      const { block, ...rest } = base;
      yield {
        ...rest,
        type: 'text-delta',
        text: corrected,
        index: lastIndex ?? 0,
      };
    }
  }
}

return {
  name: 'a2-service-forbidden-filter',
  apply(ctx) {
    ctx.on('llm/stream', (options, next) => {
      const upstream = next();
      if (
        !upstream ||
        (typeof upstream[Symbol.asyncIterator] !== 'function' &&
         typeof upstream[Symbol.iterator] !== 'function')
      ) {
        return upstream;
      }
      return transformStream(upstream);
    });
  },
};
