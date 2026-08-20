/*
 * A2 服务禁语约束插件
 * - 拦截 llm/stream，检测态度消极 / 强势质问 / 甩锅推诿类表达（含 SOP 示例及常见变体）。
 * - 命中后调用内部 LLM 改写；改写必须保留账期、金额等事实信息，失败则本地替换兜底。
 * - 内部 LLM 调用通过 SKIP_FLAG + system 标记防递归。
 * - 合规话术原样透传，不改动任何 chunk。
 */
const SKIP_FLAG = '__a2InternalCall__';
const INTERNAL_MARKER = '__A2_INTERNAL_TASK__';

const FORBIDDEN_EXACT = [
  '不可能', '做不到', '没办法', '没辙', '没法子', '无能为力', '爱莫能助',
  '帮不了你', '帮不了', '解决不了', '处理不了', '办不到', '办不了', '弄不了', '整不了',
  '这不是我的责任', '这不是我的错', '不是我的责任', '不是我的问题', '不是我的错',
  '这不是我们的责任', '不是我们的责任', '不是我们的问题',
  '不是我的事', '不关我事', '不关我的事', '不关我们的事', '关我什么事', '关你什么事',
  '关我屁事', '跟我没关系', '和我没关系', '跟我无关', '和我无关',
  '这不该我管', '不该我管', '不归我管', '不归我们管', '我管不着',
  '找我也没用', '跟我说也没用', '你跟我说没用',
  '系统崩了', '系统挂了', '系统瘫了', '系统宕机了', '系统出bug了', '系统出了bug',
  '系统出问题了', '系统出了点问题', '系统故障了', '系统出毛病了',
  '平台崩了', '平台出问题了', '服务器崩了', '服务器挂了', '网络崩了',
  '你听不懂吗', '你听不明白吗', '你怎么听不懂', '你听懂了没', '听不懂吗', '听不明白吗',
  '你自己看', '你自己想', '你自己查', '自己不会看吗', '自己看吧', '自己看着办',
  '我不管了', '我可不管', '我管不了', '管不了', '随便你', '随你便',
  '爱咋咋地', '爱咋地咋地', '爱办不办', '你爱信不信', '不信拉倒', '你爱怎么想怎么想',
  '别烦我', '别打扰我', '别再问了', '不要再问了', '别再说了', '烦死了', '闭嘴', '少啰嗦',
  '我没义务', '没有义务', '我没这义务', '怪你自己', '你自己的问题', '你自己负责',
  '我也没办法', '我也没有办法', '我们也没办法'
];

const FORBIDDEN_REGEX = [
  /不\s*可\s*能/,
  /做\s*不\s*到/,
  /做\s*不\s*了(?!\s*(主|决定))/,
  /办\s*不\s*到/,
  /办\s*不\s*了/,
  /没\s*办\s*法/,
  /没\s*辙/,
  /没\s*法\s*子/,
  /无\s*能\s*为\s*力/,
  /爱\s*莫\s*能\s*助/,
  /帮\s*不\s*了/,
  /解\s*决\s*不\s*了/,
  /处\s*理\s*不\s*了/,
  /弄\s*不\s*了/,
  /整\s*不\s*了/,
  /不\s*是\s*(我|我们)\s*的\s*(责任|问题|错)/,
  /不\s*关\s*(我|我们)\s*事/,
  /(跟|和)\s*(我|我们)\s*没\s*(关系|关)/,
  /(系统|平台|服务器|网络|设备)\s*(崩|挂|瘫|宕机|故障|出\s*(了\s*)?(bug|问题|故障|毛病)|有\s*(了\s*)?(bug|问题))/i,
  /[你您]\s*听\s*不\s*(懂|明白)/,
  /听\s*不\s*(懂|明白)\s*(吗|么)/,
  /(自己|你)\s*(不会|不能|没法)\s*(看|想|查|找)/,
  /我\s*不\s*管(?!怎|如|什|哪)/,
  /我\s*管\s*不\s*了/,
  /随\s*你/,
  /爱\s*(咋|怎)\s*地/,
  /爱\s*办\s*不\s*办/,
  /爱\s*信\s*不\s*信/,
  /不\s*信\s*拉\s*倒/,
  /别\s*(烦|打扰|催|问我)/,
  /(烦|吵|闹)\s*死\s*了/,
  /没\s*义\s*务/,
  /(这|那)\s*不\s*是\s*(我|我们)\s*的\s*(事|问题|责任)/,
  /找\s*我\s*也\s*没\s*用/,
  /跟\s*我\s*说\s*也\s*没\s*用/,
  /自\s*己\s*看\s*着\s*办/,
  /不\s*要\s*再\s*问\s*了/,
  /闭\s*嘴/,
  /少\s*啰\s*嗦/,
  /我\s*有\s*什\s*么\s*办\s*法/,
  /有\s*什\s*么\s*办\s*法/,
  /我\s*能\s*怎\s*么\s*办/,
  /你\s*急\s*什\s*么/,
  /你\s*怎\s*么\s*回\s*事/,
  /你\s*有\s*毛\s*病\s*(吗|吧)/,
  /谁\s*管\s*你/,
  /懒\s*得\s*(理|管)\s*你/,
  /关\s*你\s*什\s*么\s*事/,
  /爱\s*怎\s*么\s*样\s*就\s*怎\s*样/
];

const LOCAL_REPLACEMENTS = [
  ['这不是我们的责任', '非常抱歉给您带来困扰，我会尽力协助您解决'],
  ['这不是我的责任', '非常抱歉给您带来困扰，我会尽力协助您解决'],
  ['这不是我们的错', '非常抱歉给您带来困扰，我会尽力协助您解决'],
  ['这不是我的错', '非常抱歉给您带来困扰，我会尽力协助您解决'],
  ['不是我们的责任', '非常抱歉，我会帮您核实处理'],
  ['不是我们的问题', '非常抱歉，我会帮您核实处理'],
  ['不是我的责任', '非常抱歉，我会帮您核实处理'],
  ['不是我的问题', '非常抱歉，我会帮您核实处理'],
  ['不是我的错', '非常抱歉，我会帮您核实处理'],
  ['不是我的事', '非常抱歉，我会帮您核实处理'],
  ['这不该我管', '我帮您转达给相关负责人处理'],
  ['不该我管', '我帮您转达给相关负责人处理'],
  ['不归我管', '我帮您转达给相关负责人处理'],
  ['不归我们管', '我帮您转达给相关负责人处理'],
  ['不关我的事', '我帮您转达给相关负责人处理'],
  ['不关我们的事', '我帮您转达给相关负责人处理'],
  ['不关我事', '我帮您转达给相关负责人处理'],
  ['关我什么事', '我帮您转达给相关负责人处理'],
  ['关你什么事', '请问还有什么可以帮您'],
  ['关我屁事', '我帮您转达给相关负责人处理'],
  ['跟我没关系', '我帮您转达给相关负责人处理'],
  ['和我没关系', '我帮您转达给相关负责人处理'],
  ['跟我无关', '我帮您转达给相关负责人处理'],
  ['和我无关', '我帮您转达给相关负责人处理'],
  ['找我也没用', '我会尽力协助您解决'],
  ['跟我说也没用', '我会尽力协助您解决'],
  ['你跟我说没用', '我会尽力协助您解决'],
  ['我管不着', '我帮您反馈给相关部门处理'],
  ['我管不了', '我帮您反馈给相关部门处理'],
  ['管不了', '我帮您反馈给相关部门处理'],
  ['我不管了', '我会尽力帮您处理'],
  ['我可不管', '我会尽力帮您处理'],
  ['系统出了bug', '系统当前出现异常'],
  ['系统出bug了', '系统当前出现异常'],
  ['系统出了点问题', '系统当前出现异常'],
  ['系统出问题了', '系统当前出现异常'],
  ['系统出毛病了', '系统当前出现异常'],
  ['系统故障了', '系统当前出现异常'],
  ['系统崩了', '系统当前出现异常'],
  ['系统挂了', '系统当前出现异常'],
  ['系统瘫了', '系统当前出现异常'],
  ['系统宕机了', '系统当前出现异常'],
  ['平台崩了', '平台当前出现异常'],
  ['平台出问题了', '平台当前出现异常'],
  ['服务器崩了', '服务器当前出现异常'],
  ['服务器挂了', '服务器当前出现异常'],
  ['网络崩了', '网络当前出现异常'],
  ['你听不懂吗', '我可能没有表达清楚，我再为您说明一下'],
  ['你听不明白吗', '我可能没有表达清楚，我再为您说明一下'],
  ['你怎么听不懂', '我可能没有表达清楚，我再为您说明一下'],
  ['你听懂了没', '我可能没有表达清楚，我再为您说明一下'],
  ['听不懂吗', '我可能没有表达清楚，我再为您说明一下'],
  ['听不明白吗', '我可能没有表达清楚，我再为您说明一下'],
  ['你自己看', '您可以自行查看一下'],
  ['你自己查', '您可以自行查询一下'],
  ['你自己想', '您可以再确认一下'],
  ['自己不会看吗', '您可以自行查看一下'],
  ['自己看吧', '您可以自行查看一下'],
  ['自己看着办', '您看这样处理可以吗'],
  ['随便你', '您看这样可以吗'],
  ['随你便', '您看这样可以吗'],
  ['爱咋咋地', '您看这样可以吗'],
  ['爱咋地咋地', '您看这样可以吗'],
  ['爱办不办', '您看这样可以吗'],
  ['你爱信不信', '您可以再核实一下'],
  ['不信拉倒', '您可以再核实一下'],
  ['你爱怎么想怎么想', '您可以再核实一下'],
  ['别烦我', '请问还有什么可以帮您'],
  ['别打扰我', '请问还有什么可以帮您'],
  ['别再问了', '请问还有什么可以帮您'],
  ['不要再问了', '请问还有什么可以帮您'],
  ['别再说了', '请问还有什么可以帮您'],
  ['烦死了', '非常抱歉给您带来不好的体验'],
  ['闭嘴', '请您稍安勿躁，我会尽力协助您'],
  ['少啰嗦', '请问还有什么可以帮您'],
  ['我没义务', '我会尽力帮您处理'],
  ['没有义务', '我会尽力帮您处理'],
  ['我没这义务', '我会尽力帮您处理'],
  ['怪你自己', '非常抱歉给您带来不便'],
  ['你自己的问题', '我们会尽力协助您处理'],
  ['你自己负责', '我们会尽力协助您处理'],
  ['我也没办法', '目前暂时无法处理，我帮您反馈一下'],
  ['我也没有办法', '目前暂时无法处理，我帮您反馈一下'],
  ['我们也没办法', '目前暂时无法处理，我帮您反馈一下'],
  ['我有什么办法', '我会尽力协助您处理'],
  ['我能怎么办', '我会尽力协助您处理'],
  ['有什么办法', '目前暂时无法处理，我帮您反馈一下'],
  ['你急什么', '请您不要着急，我马上为您处理'],
  ['你怎么回事', '非常抱歉，我重新为您说明一下'],
  ['谁管你', '我会尽力帮您处理'],
  ['懒得理你', '请问还有什么可以帮您'],
  ['懒得管你', '请问还有什么可以帮您'],
  ['无能为力', '目前暂时无法处理，我帮您反馈一下'],
  ['爱莫能助', '目前暂时无法处理，我帮您反馈一下'],
  ['帮不了你', '我帮您反馈给相关部门处理'],
  ['帮不了', '我帮您反馈给相关部门处理'],
  ['解决不了', '我帮您反馈给相关部门处理'],
  ['处理不了', '我帮您反馈给相关部门处理'],
  ['办不到', '暂时无法实现'],
  ['办不了', '暂时无法实现'],
  ['弄不了', '暂时无法实现'],
  ['整不了', '暂时无法实现'],
  ['做不到', '暂时无法实现'],
  ['不可能', '暂时无法实现'],
  ['没办法', '目前暂时无法处理'],
  ['没辙', '目前暂时无法处理'],
  ['没法子', '目前暂时无法处理']
];

LOCAL_REPLACEMENTS.sort((a, b) => b[0].length - a[0].length);

function containsForbidden(text) {
  if (!text) return false;
  for (const phrase of FORBIDDEN_EXACT) {
    if (text.includes(phrase)) return true;
  }
  for (const re of FORBIDDEN_REGEX) {
    if (re.test(text)) return true;
  }
  if ((text.includes('怪你') || text.includes('怪用户')) && !text.includes('不怪你') && !text.includes('不怪用户')) return true;
  if ((text.includes('怨你') || text.includes('怨用户')) && !text.includes('不怨你') && !text.includes('不怨用户')) return true;
  if ((text.includes('赖你') || text.includes('赖用户')) && !text.includes('不赖你') && !text.includes('不赖用户')) return true;
  return false;
}

function localRewrite(text) {
  let out = text;
  for (const [from, to] of LOCAL_REPLACEMENTS) {
    if (out.includes(from)) out = out.split(from).join(to);
  }
  out = out.replace(/做\s*不\s*了(?!\s*(主|决定))/g, '暂时无法实现');
  out = out.replace(/办\s*不\s*了/g, '暂时无法实现');
  out = out.replace(/帮\s*不\s*了/g, '我帮您反馈给相关部门处理');
  out = out.replace(/解\s*决\s*不\s*了/g, '我帮您反馈给相关部门处理');
  out = out.replace(/处\s*理\s*不\s*了/g, '我帮您反馈给相关部门处理');
  out = out.replace(/弄\s*不\s*了/g, '暂时无法实现');
  out = out.replace(/整\s*不\s*了/g, '暂时无法实现');
  out = out.replace(/(自己|你)\s*(不会|不能|没法)\s*(看|想|查|找)/g, '您可以再核实一下');
  out = out.replace(/爱\s*(咋|怎)\s*地/g, '您看这样可以吗');
  out = out.replace(/爱\s*办\s*不\s*办/g, '您看这样可以吗');
  out = out.replace(/爱\s*信\s*不\s*信/g, '您可以再核实一下');
  out = out.replace(/不\s*信\s*拉\s*倒/g, '您可以再核实一下');
  out = out.replace(/别\s*(烦|打扰|催|问我)/g, '请问还有什么可以帮您');
  out = out.replace(/没\s*义\s*务/g, '我会尽力帮您处理');
  out = out.replace(/我\s*有\s*什\s*么\s*办\s*法/g, '我会尽力协助您处理');
  out = out.replace(/我\s*能\s*怎\s*么\s*办/g, '我会尽力协助您处理');
  out = out.replace(/有\s*什\s*么\s*办\s*法/g, '目前暂时无法处理，我帮您反馈一下');
  out = out.replace(/你\s*急\s*什\s*么/g, '请您不要着急，我马上为您处理');
  out = out.replace(/你\s*怎\s*么\s*回\s*事/g, '非常抱歉，我重新为您说明一下');
  out = out.replace(/你\s*有\s*毛\s*病\s*(吗|吧)/g, '非常抱歉给您带来不好的体验');
  out = out.replace(/谁\s*管\s*你/g, '我会尽力帮您处理');
  out = out.replace(/懒\s*得\s*(理|管)\s*你/g, '请问还有什么可以帮您');
  out = out.replace(/关\s*你\s*什\s*么\s*事/g, '请问还有什么可以帮您');
  out = out.replace(/爱\s*怎\s*么\s*样\s*就\s*怎\s*样/g, '您看这样可以吗');
  if (out.includes('怪你') && !out.includes('不怪你')) out = out.split('怪你').join('非常抱歉给您带来不便');
  if (out.includes('怨你') && !out.includes('不怨你')) out = out.split('怨你').join('非常抱歉给您带来不便');
  if (out.includes('赖你') && !out.includes('不赖你')) out = out.split('赖你').join('非常抱歉给您带来不便');
  return out;
}

function sanitize(text) {
  let out = text;
  out = out.replace(/不\s*可\s*能/g, '暂时无法实现');
  out = out.replace(/做\s*不\s*到/g, '暂时无法实现');
  out = out.replace(/做\s*不\s*了(?!\s*(主|决定))/g, '暂时无法实现');
  out = out.replace(/办\s*不\s*到/g, '暂时无法实现');
  out = out.replace(/办\s*不\s*了/g, '暂时无法实现');
  out = out.replace(/没\s*办\s*法/g, '目前暂时无法处理');
  out = out.replace(/没\s*辙/g, '目前暂时无法处理');
  out = out.replace(/没\s*法\s*子/g, '目前暂时无法处理');
  out = out.replace(/无\s*能\s*为\s*力/g, '目前暂时无法处理');
  out = out.replace(/爱\s*莫\s*能\s*助/g, '目前暂时无法处理');
  out = out.replace(/帮\s*不\s*了/g, '我帮您反馈给相关部门处理');
  out = out.replace(/解\s*决\s*不\s*了/g, '我帮您反馈给相关部门处理');
  out = out.replace(/处\s*理\s*不\s*了/g, '我帮您反馈给相关部门处理');
  out = out.replace(/不\s*是\s*(我|我们)\s*的\s*(责任|问题|错)/g, '非常抱歉，我会尽力协助您解决');
  out = out.replace(/不\s*关\s*(我|我们)\s*事/g, '我帮您转达处理');
  out = out.replace(/(跟|和)\s*(我|我们)\s*没\s*(关系|关)/g, '我帮您转达处理');
  out = out.replace(/[你您]\s*听\s*不\s*(懂|明白)/g, '我可能没有表达清楚');
  out = out.replace(/听\s*不\s*(懂|明白)\s*(吗|么)/g, '我可能没有表达清楚');
  out = out.replace(/我\s*管\s*不\s*了/g, '我帮您反馈处理');
  out = out.replace(/我\s*不\s*管(?!怎|如|什|哪)/g, '我会尽力帮您处理');
  out = out.replace(/随\s*你/g, '您看这样可以吗');
  out = out.replace(/爱\s*(咋|怎)\s*地/g, '您看这样可以吗');
  out = out.replace(/爱\s*办\s*不\s*办/g, '您看这样可以吗');
  out = out.replace(/爱\s*信\s*不\s*信/g, '您可以再核实一下');
  out = out.replace(/不\s*信\s*拉\s*倒/g, '您可以再核实一下');
  out = out.replace(/别\s*(烦|打扰|催|问我)/g, '请问还有什么可以帮您');
  out = out.replace(/(烦|吵|闹)\s*死\s*了/g, '非常抱歉给您带来不好的体验');
  out = out.replace(/没\s*义\s*务/g, '我会尽力帮您处理');
  out = out.replace(/我\s*有\s*什\s*么\s*办\s*法/g, '我会尽力协助您处理');
  out = out.replace(/我\s*能\s*怎\s*么\s*办/g, '我会尽力协助您处理');
  out = out.replace(/有\s*什\s*么\s*办\s*法/g, '目前暂时无法处理，我帮您反馈一下');
  out = out.replace(/你\s*急\s*什\s*么/g, '请您不要着急，我马上为您处理');
  out = out.replace(/谁\s*管\s*你/g, '我会尽力帮您处理');
  out = out.replace(/懒\s*得\s*(理|管)\s*你/g, '请问还有什么可以帮您');
  out = out.replace(/关\s*你\s*什\s*么\s*事/g, '请问还有什么可以帮您');
  out = out.replace(/爱\s*怎\s*么\s*样\s*就\s*怎\s*样/g, '您看这样可以吗');
  out = out.replace(/(系统|平台|服务器|网络|设备)\s*(崩|挂|瘫|宕机|故障|出\s*(了\s*)?(bug|问题|故障|毛病)|有\s*(了\s*)?(bug|问题))/gi, '系统当前出现异常');
  return out;
}

function normalize(s) {
  return String(s)
    .replace(/\s+/g, '')
    .replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xFEE0))
    .replace(/[，。！？、；：""''（）《》]/g, '')
    .toLowerCase();
}

function numericFacts(text) {
  const nums = new Set();
  const re = /\d+(?:[.,]\d+)?/g;
  let m;
  while ((m = re.exec(text))) nums.add(m[0]);
  return nums;
}

function factsPreserved(original, rewritten) {
  const nums = numericFacts(original);
  if (nums.size === 0) return true;
  const rw = normalize(rewritten);
  for (const n of nums) {
    if (rw.includes(n)) continue;
    const compact = n.replace(/[.,]/g, '');
    if (compact.length >= 2 && rw.includes(compact)) continue;
    return false;
  }
  return true;
}

function cleanModelOutput(text) {
  let t = String(text || '').trim();
  if ((t.startsWith('"') && t.endsWith('"')) ||
      (t.startsWith('「') && t.endsWith('」')) ||
      (t.startsWith("'") && t.endsWith("'"))) {
    t = t.slice(1, -1).trim();
  }
  t = t.replace(/^```[a-zA-Z]*\n?/, '').replace(/\n?```$/, '').trim();
  return t;
}

const REWRITE_SYSTEM = '你是一名专业的校园网客服话术合规改写助手。你的任务是在严格保留事实信息的前提下，把含有服务禁语的客服回复改写为合规、礼貌、积极、负责的表达。';

const REWRITE_PROMPT = `下面是一段校园网客服 agent 对用户说的话。其中可能包含服务禁语（态度消极、强势质问、甩锅推诿类表达），例如：「不可能」「做不到」「没办法」「这不是我的责任」「系统崩了」「系统出bug了」「你听不懂吗」等。

请改写这段话，要求：
1. 删除或替换所有消极、质问、推诿、甩锅的表达，改为积极、礼貌、负责、专业的说法。
2. 严格保留所有事实信息：账期、金额、日期、套餐、办理材料、操作步骤、号码等必须原样保留，不得丢失、改变或编造。
3. 保持原话的语义和回复结构，不要添加无关内容。
4. 如果原文已经合规，请原样输出，不要做任何修改。
5. 直接输出改写后的完整文本，不要输出任何解释、前缀、引号或代码块。

待改写文本：
"""
@@TEXT@@
"""`;

async function callLlmText(ctx, system, prompt, options, timeoutMs) {
  if (!ctx || !ctx.llm || typeof ctx.llm.stream !== 'function') {
    throw new Error('llm unavailable');
  }
  const callOptions = {
    ...(options || {}),
    [SKIP_FLAG]: true,
    provider: (options && options.provider) || 'deepseek-official',
    model: (options && options.model) || 'deepseek-chat',
    reasoningEffort: (options && options.reasoningEffort) || 'off',
    system: INTERNAL_MARKER + '\n' + system,
    messages: [
      { role: 'user', content: [{ type: 'text', text: prompt }], source: { kind: 'user' } }
    ]
  };
  const stream = ctx.llm.stream(callOptions);
  let text = '';
  let timer = null;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('a2 llm timeout')), timeoutMs || 15000);
  });
  try {
    const iterator = stream[Symbol.asyncIterator]();
    while (true) {
      const { done, value } = await Promise.race([iterator.next(), timeoutPromise]);
      if (done) break;
      if (value && value.type === 'text-delta' && typeof value.text === 'string') {
        text += value.text;
      } else if (value && value.type === 'block-end' && value.block && value.block.type === 'text' && typeof value.block.text === 'string') {
        text = value.block.text;
      }
    }
  } finally {
    if (timer) clearTimeout(timer);
  }
  return text.trim();
}

async function* processStream(ctx, options, next) {
  const upstream = next(options);
  if (!upstream || typeof upstream[Symbol.asyncIterator] !== 'function') {
    return;
  }

  const chunks = [];
  let deltaText = '';
  let blockText = null;
  let textBlockEnd = null;
  let firstTextDeltaIndex = null;

  for await (const chunk of upstream) {
    chunks.push(chunk);
    if (chunk && chunk.type === 'text-delta') {
      if (firstTextDeltaIndex === null) firstTextDeltaIndex = chunk.index;
      if (typeof chunk.text === 'string') deltaText += chunk.text;
    } else if (chunk && chunk.type === 'block-end' && chunk.block && chunk.block.type === 'text') {
      textBlockEnd = chunk;
      if (typeof chunk.block.text === 'string') blockText = chunk.block.text;
    }
  }

  const fullText = ((blockText != null && blockText.trim()) ? blockText : deltaText).trim();
  if (!fullText) {
    yield* chunks;
    return;
  }

  if (!containsForbidden(fullText)) {
    yield* chunks;
    return;
  }

  let finalText = null;
  try {
    const rewritten = cleanModelOutput(
      await callLlmText(ctx, REWRITE_SYSTEM, REWRITE_PROMPT.replace('@@TEXT@@', fullText), options, 20000)
    );
    if (rewritten && rewritten !== fullText && !containsForbidden(rewritten) && factsPreserved(fullText, rewritten)) {
      finalText = rewritten;
    }
  } catch (e) {
    finalText = null;
  }

  if (!finalText) {
    finalText = localRewrite(fullText);
  }

  if (containsForbidden(finalText)) {
    finalText = sanitize(finalText);
  }

  if (containsForbidden(finalText)) {
    for (const phrase of FORBIDDEN_EXACT) {
      finalText = finalText.split(phrase).join(' ');
    }
    finalText = finalText.replace(/\s{2,}/g, ' ').trim();
  }

  if (!finalText.trim()) {
    finalText = fullText;
  }

  const deltaIndex = firstTextDeltaIndex != null ? firstTextDeltaIndex : (textBlockEnd ? textBlockEnd.index : 0);
  const blockIndex = textBlockEnd ? textBlockEnd.index : deltaIndex;
  let emittedDelta = false;

  for (const chunk of chunks) {
    if (chunk && chunk.type === 'text-delta') {
      if (!emittedDelta) {
        emittedDelta = true;
        yield { ...chunk, index: deltaIndex, text: finalText };
      }
      continue;
    }
    if (chunk && chunk.type === 'block-end' && chunk.block && chunk.block.type === 'text') {
      yield { ...chunk, index: blockIndex, block: { ...chunk.block, text: finalText } };
      continue;
    }
    yield chunk;
  }

  if (!emittedDelta && !textBlockEnd) {
    yield { type: 'text-delta', index: deltaIndex, text: finalText };
  }
}

return {
  name: 'a2-forbidden-words-guard',
  inject: ['llm'],
  apply(ctx) {
    if (!ctx || typeof ctx.on !== 'function') return;
    ctx.on('llm/stream', (options, next) => {
      if (options && (options[SKIP_FLAG] || (typeof options.system === 'string' && options.system.includes(INTERNAL_MARKER)))) {
        return typeof next === 'function' ? next(options) : next;
      }
      return processStream(ctx, options, next);
    });
  }
};
