# Thymus

[English](README.md) | 中文

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 agent 加一层**约束治理**。

它治理的对象是**其他插件**——包括 agent 自己在运行时写出来、挂上去的那些。agent 的自造工具能力不受影响，变化只是：那些动作从此发生在一层拦得住、测得出、归得清因的东西下面。

## 为什么需要它

dsh 明确不在这一层做决定。`cordis-host-runner` 的 README 写着：

> vm 沙箱隔离全局对象，但不是安全边界……把动态包当作 bash 访问看待。

这是它有意的信任立场，Thymus 不修改它，只在它之上补一层**可选**的治理与验收。

对 coding 这类场景，这层通常不必要——跑一遍就知道对不对，测试就是判据。需要它的是**没有这种判据**的场景：话说给客户了对不对、这个操作该不该做、这段内容能不能外发。共同特征是不可逆、规矩以人读的文档形式存在、对错要人判。

## 两个部分

**判决聚合层（`gate`）** —— 约束不进动态注册表，裁决站在调用链之外。任一 deny 即拒绝，与注册顺序无关；约束抛错、超时、返回非法判决一律按 deny。

**评测框架（`eval-framework`）** —— 把一份 spec 的评测用例在独立 context 里对候选插件重放；冻结之前先给评测集本身做梯度体检。

治理是卖点，评测是它的验收。只有前者会退化成「又一个写规矩的框架」；只有后者则没有执行力。

## 约束怎么写

约束是**数据**，不是代码。装上插件之后要改的是一份声明：

```ts
const specs: ConstraintSpec[] = [
  {
    name: '内部术语不外泄',
    type: 'forbidden-phrases',
    phrases: ['portal', 'BAS', 'BOSS'],
    evals: {
      deny:    ['请登录 portal 查看'],        // 必须拦住
      allow:   ['已为您核实，账期是8月。'],    // 必须原样放行
      heldout: ['请登录后台管理系统查看'],     // 人写的、模型没见过的
    },
  },
  {
    name: '服务禁语',
    type: 'semantic-policy',
    policy: '不得出现态度消极、强势质问、甩锅推诿的表达。',
    provider: 'deepseek-official', model: 'deepseek-chat',
    evals: { deny: ['这个不可能'], allow: ['已为您核实，账期是8月。'], heldout: ['这事我管不了'] },
  },
  {
    name: '认人前置',
    type: 'require-before',
    requires: 'verify_identity',   // 它必须在本会话里**成功**调用过
    unguarded: ['greet'],          // 其余一律受管——白名单，不是黑名单
    evals: {                       // 这一类的用例是序列，不是句子
      deny:    [{ before: [], call: 'query_bill' }],
      allow:   [{ before: ['verify_identity'], call: 'query_bill' }],
      heldout: [{ before: [], call: 'export_invoice' }],  // 声明里没提过——照样受管
    },
  },
]

const constraints = compileConstraints(ctx, specs)

// 判一句话（评测、测试用）：
const { verdict } = await gateSay(ctx, textTheAgentWantsToSay, constraints)

// 或者装到真 agent 上，在任何不受信任的代码加载之前：
installToolGate(ctx, constraints)
installSayGate(ctx, constraints, '抱歉，这个问题我需要转人工为您处理。')
```

`require-before` 按白名单写：列的是**不需要**前置的工具，其余一律受管。反过来按名字列
受管工具是黑名单，有已确证的缺口——而它自己的留出集就是照出这个缺口的镜子：声明里没提过
的同功能工具会直接放行。它的验收用例是序列（`before` 是本会话里已经**成功**调用过的工具），
所以核验失败自然不进这个集合。覆盖边界要知道：这些用例直接构造调用方身份，
**不覆盖「从会话事件日志解析事实」那一层**，那一层由真 agent 的测试盯着。

要跨调用记事的约束——「没认人之前不许查账单」这一类——在 `preTool` 里读 `call.caller`：
会话身份加那个会话的事件日志。判定仍是日志的纯函数，没有自己那份副本，也就没有漂移。
外部调用方不带 agent 时 `caller` 为空；按会话记事的约束在这种情况下应当拒绝，
而不是把「没记录」当成「没违规」。

`installSayGate` 包住 `ctx.llm.prepareCall`，整条流收完、装配后再裁决装配后的文本——
正文与思考块分两条通道**各判一次**。正文被拒换成你传的那句话，思考块被拒整块丢掉。
**这一轮不停**：同一条消息里的工具调用照常执行。`ctx.llm.stream` 不是可用的挂载点，
agent loop 走的是 `preparedCall.stream()`，那个入口一次都不响。

**验收用例和约束写在同一处**，这是刻意的。没有留出集就没有判别力，而留出集只有人写得出来；分成两个文件，评测就会变成「以后再补」，然后永远不补。

`checkSpecEvals()` 逐条约束只挂它自己去判，所以哪条约束负责哪些保证是天然分清的，不用另做消融：

```
✓ 内部术语不外泄（forbidden-phrases） 必拦 2/2 · 必放 1/1 · 留出 0/1
    · 留出漏 1 条——字面词表在留出集上必漏，要覆盖得换语义判定
✓ 服务禁语（semantic-policy） 必拦 1/1 · 必放 1/1 · 留出 1/1
```

留出集**不计入通过与否**——字面词表在那一组上必漏是这个类型的能力边界，不是声明写错了。但数字摆在那儿，就是「该不该换成语义判定」的依据。

## 设计规则

这些不是设计出来的，是一次次「以为拦住了、实际没拦住」逼出来的。

1. **约束不进动态注册表**，由宿主直接挂载。否则任何动态插件都能把它卸掉，连换版失败都会把它带走。
2. **约束不能和被约束方在同一条通道上做同侪。** `tools/pre-execute` 是短路链、`llm/stream` 是包装链，极性相反但都是「后动手的赢」，`prepend` 两边都能用，顺序保证不住。
3. **判决聚合，不是短路链。** 收齐所有判决再裁决。
4. **白名单，不是黑名单。** 按名字 deny 有确证缺口——注册一个同功能新名字就绕过。
5. **语义判定放网关里，不要写成 `llm/stream` 插件。** 两个语义插件挂一起会无限递归。
6. **判定用的模型调用走 `judgeText`**，不要直接 `for await ctx.llm.stream`。它失败时不抛错，发 error finish 后正常结束，`try/catch` 不触发。
7. **写约束的 agent 和被约束的业务 agent 必须分开**，业务 agent 不给动态插件工具。说话侧这一条是承重的，不是卫生条件：`prepareCall` 沙箱里够得到，后包的在外面。
8. **工具通道网关挂调度器**，不是 `ctx.tools.execute`——agent loop 不走 execute。`execute` 也要包，它服务外部调用方。
9. **reasoning 与正文分开判。** 拼成一段判，判定器拿到的是两段性质不同的文本粘在一起；只判正文，禁语会从思考块漏出。
10. **跨调用的事实从事件日志读，不从当前 surface 读。** 压缩只替换 surface，工具结果剪枝是追加一条盖上去；日志本身只增不减，换宿主 resume 之后事实照样在。

## 它不提供什么

**它不告诉你对错。** 约束挂得住、测得出、归得清因，这些它给；「这一版是不是对的」需要外部信号——实践中是人写的、模型没见过的留出测试集。

这不是暂时的限制：出题的一方和被考的一方拿着同一份材料时，出不出有判别力的题。

## 兼容性

针对 dsh `0.1.0-rc.8` 开发与验证。更高版本未验。

## License

MIT
