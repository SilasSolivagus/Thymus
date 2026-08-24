# 交接：校园网客服 agent（新会话从这里接）

> **先读 `STATUS.md`。** 15 份 FINDINGS 里有若干条已被后来的实验推翻或降级，
> STATUS 里有完整的撤回清单和可直接照做的架构结论。本文件是流程与下一步。

分支 `spike/layer-feasibility`。DEEPSEEK_API_KEY 由 `.env.local` 自动加载（勿入库）。
重活（构建、真模型调用）派子 agent 后台跑。

## 这一轮在验什么

用一份真实客户材料（西安新路《客户服务部作业指导书》.docx）验证核心命题：
**过去要人写的客服插件/工具，能不能换成 agent 自己写、自己用**。
需求以「给人读的真实文档」形态到达（口语、模糊、条款交叉），看内核在哪散架。
约束 spec 见 `SPEC.md`（四类：A禁语 / B认人前置 / C内部字段不外泄 / D越界兜底），
保留原文话术与模糊表述，不为评测优化。

## 现在能做到什么（大白话，接手先看这段）

一份客服 SOP，能变成一张表挂到 agent 上。交付走四步：

1. **照工作单填表**（`packages/thymus/TEMPLATE.zh.md`）——五种规矩类型各填什么、
   考题怎么写、表达不了的怎么登记，都有模板和真实反例。
2. **跑机械闸**（`checkSpecHygiene`，不花钱）——查考题缺没缺、留出题是不是伪装的、
   一条规矩里是不是混了两条、`uncovered` 空不空。不过就不该冻结。
3. **跑考题**（`checkSpecEvals`）——必拦 / 必放 / 留出三组数字，哪组掉了对应哪种毛病。
   同一轮还要跑 `checkReplacements`：拒绝时换上去的那句话，自己合不合别的规矩
   （它发出前不再过闸，见发现 29）。
4. **上线之后每天回流**（`badcase.ts`）——线上样本人标、确定性分流、留出侧只给数字、
   与上一版比。

运行时那侧：工具通道挂调度器（拒绝 + 产出抹除），说话通道挂 `prepareCall`
（缓冲全流、装配后裁决、只换话不停轮），另有 `propose_tool` 让 agent 自己长工具
而装工具的动作留在宿主手里（配额 / 去重 / 回收）。

**人不可替代的四件事**，这轮反复证明省不掉：写留出题、拆条款、判定「这条表达不了」、
调措辞。前三件有模板和脚本兜着；第四件只能改完重跑看数字——**措辞是唯一没有机械检查
的一环**。

**最该记住的一句**：evals 是检测器，检测不到没写进去的东西。漏掉的条款不会有用例，
报告因此全绿——所以 `uncovered` 必须是必填项。

一张图：`../../output/story-map.svg`（交付故事地图，横向六个环节、纵向四层）。

## 已确认的发现

| # | 结论 | 文件 |
|---|---|---|
| 01 | agent 对用户说话走 assistant 消息，不是工具调用，绕开整条 tools 管线 | `FINDINGS-01-speech-bypasses-tools.md` |
| 02 | 说话类约束的挂载点是 `llm/stream`；三个隐蔽漏点：大小写变体、`block-end`、reasoning 通道 | `FINDINGS-02-speech-guard-on-llm-stream.md` |
| 03 | 模型写插件写得出来；自己出题出反了，空插件组 24/24 通过 | `FINDINGS-03-self-authored-speech-plugins.md` |
| 04 | 语义约束换机制可行：`llm/stream` 里再调一次模型，判定 36/36；代价 967ms/句 | `FINDINGS-04-semantic-guard-feasibility.md` |
| 05 | 告知这条路存在，模型会换机制；但把语义判定挂在字面词表后面当二级过滤，收益被门控抵消 | `FINDINGS-05-a2-ab-gate.md` |
| 06 | 门控这个错，弱反馈一轮就解掉，且在从未喂过的留出集上泛化（n=1，已被 07 推翻一半） | `FINDINGS-06-feedback-removes-gate.md` |
| 07 | 重复 3 次：弱反馈只在 4 次里 2 次有效；强反馈零增量；新增回归这种失败形态 | `FINDINGS-07-feedback-not-stable.md` |
| 08 | dsh 不决定插件该不该加载；已加载的插件能卸掉别的插件（其 README 明说沙箱不是安全边界） | `FINDINGS-08-who-gates-plugin-load.md` |
| 09 | 约束挪出动态注册表能防卸载，防不住架空——约束不能和被约束方做同侪 | `FINDINGS-09-protected-layer.md` |
| 10 | 判决聚合层：任一 deny 即拒绝、顺序无关；按工具名判定有确证缺口，白名单必需 | `FINDINGS-10-decision-gate.md` |
| 11 | J-Space 实测：不引入（结论理由已被 12 修正） | `FINDINGS-11-jspace-eval.md` |
| 12 | 基线双峰，n=3 分不出来；05/07 的门控频率降为 3/7，11 的质量结论撤回 | `FINDINGS-12-baseline-variance.md` |
| 13 | 两个语义插件挂一起会无限递归；判定放进网关则互不污染 | `FINDINGS-13-multiplugin-pollution.md` |
| 14 | 热替换干净；但决策途中换版会让该次调用失败（方向是不放行），且 run 阶段换版失败会把旧约束带走 | `FINDINGS-14-hotswap.md` |
| 15 | 模型调用失败不抛错而是发 error finish——插件词表兜底不执行、网关 fail-closed 被绕过 | `FINDINGS-15-silent-llm-failure.md` |
| 16 | 网关挂错了地方：agent 不走 `execute` 走调度器；改写产出与拒绝在真实链路上各验 3/3 | `FINDINGS-16-real-mount-point.md` |
| 17 | 说话侧挂载点是 `ctx.llm.prepareCall`（`ctx.llm.stream` 命中 0 次）；它站在 `llm/stream` 链外，但沙箱插件够得到同一个入口，后包的赢；reasoning 是漏点，重试每次都重新过网关 | `FINDINGS-17-say-mount-point.md` |
| 18 | B 类的状态从会话事件现读即可，不用自己存；工具侧有身份、说话侧身份在 `stream` 那一层；多 agent 不串；并发派发时事实还没落库 | `FINDINGS-18-b-class-state.md` |
| 19 | 压缩与剪枝只动 surface，事件日志只增不减；resume 之后 B 类的事实仍在 | `FINDINGS-19-facts-survive-compaction.md` |
| 20 | D 类真模型验收：判得住一半，漏的那半是条款混写造成的（拆开后留出 5/5） | `FINDINGS-20-d-class-real-model.md` |
| 21 | SPEC.md 整份编译成声明：四类里三类填得满，B 填一半；**措辞是未受控变量** | `FINDINGS-21-spec-as-declaration.md` |
| 22 | 模型自己写声明 vs 人写：选型全对，但缺口硬套、留出集 2/3 是伪装的、自评全绿 | `FINDINGS-22-authored-vs-human-spec.md` |
| 23 | 工具注册边界：旧名字动不了、新名字随便造、**占名攻击成立** | `FINDINGS-23-propose-tool.md` |
| 24 | `propose_tool` 真 agent 端到端：白名单扛住绕过，但工具表会膨胀 | `FINDINGS-24-propose-agent-e2e.md` |
| 25 | 配额、去重、回收：撞上提交上限不会把模型逼去编造 | `FINDINGS-25-propose-quota.md` |
| 26 | 说话侧首字延迟＝整段生成时间；并发不串；B 缺口用 `require-before-say` 补上 | `FINDINGS-26-say-cost-and-b2.md` |
| 27 | `require-before-say` 真模型验收：判得住，但**替代话术会被自己的规矩拦下** | `FINDINGS-27-b2-real-model.md` |
| 28 | 注册数上限真链路验到；去重仍无证据；回流补上工具侧五种样本形状 | `FINDINGS-28-quota-and-toolside-reflow.md` |
| 29 | 替代话术不过闸，且说哪句由声明顺序定；为 A2/B2 写的话术在越界语境下不满足 D | `FINDINGS-29-replacement-crossclass.md` |

**分层结论：写规矩，模型能；判自己写得对不对，现在不能；语义那部分，机制上够到边了，
模型也会走，但它第一版有相当比例会把旧机制留在前门、收益自己抵消
（7 次里 3 次，分布双峰 [2,2,2,3,6,6,6]）。
这个错反馈有时能纠正（4 次里 2 次），有时只换来扩词表或把合规话术改坏——
反馈闭环是可能省人力的尝试，不是可以承诺的路径。**

两条容易被误读的，写清楚：

- 「模型能写插件」目前的强度是「挂载点选得对、API 用得对、单点逻辑看着对」。
  **至今没有一次组合评测真正通过的记录**——发现 03 里那 4 个插件的质量判断来自静态复查
  和逐句人工比对，不是来自评测通过（那组评测本身是坏的）。「多插件同时正确」仍未验证，
  而上一轮（`../demo/FINDINGS-composite.md`）记录的正是这里是模型能力边界。
- 发现 03 的要害不是「AI 出题会错」，是**三方独立闭环里没有任何位置能发现题错了**：
  判定器是死代码，开发 agent 只看扣分不看题，出题 agent 冻结即退场。
  人目前是唯一的方向性信号源。但这次的错是可以机械挡掉的（空插件组全过＝方向反了），
  这类闸该做成框架不变量，把人留给机械挡不掉的那类。
  另：人写评测解决方向问题，**不解决语义问题**——A2 那类约束人写的断言同样只能是字面的。

## 定位判断（对外讲 Thymus 时用这个口径）

拿企业 agent 落地的常见问题清单对一遍，Thymus 实际覆盖的范围：

- **正中**：评测与可观测（消融归因＝分得清错在哪一层；冻结评测＋基线＝挡得住版本静默漂移）；
  架构形态（约束挂在运行时、可挂可卸，实测停掉后干净 unwind，既不是写死 workflow 也不是
  完全放开的自由 loop）。
- **碰到边**：系统集成里的审计轨迹、工具描述；人与流程里的反馈闭环（已实测它会静默空转）。
- **完全不碰**：范围与预期（商业/项目管理）；数据与上下文（schema 考古、知识库脏、
  权限边界、更新链路断）——而这一块通常是工作量最大、客户拿来衡量交付的那一块。

结论：Thymus 的位置是**让约束可挂载、可评测、可归因、可卸载**。把位置说窄说准，
比把覆盖面说宽有用。

顺带一条与「workaround 会变负债」直接对应的实测：A2 上字面词表是 workaround，
模型再强它也不会自己变好；语义判定是换机制，模型变强它就变准、变便宜、变快。
今天两条路差 967ms 和几十行代码。

## 依赖状态

vendor 的 dsh 已升到 `0.1.0-rc.8`（`141eb6fe`），submodule url 改指上游
`deepseek-ai/deepseek-harness`（原 fork 相对上游零自带 commit，定制在
`../../probes/scope-fix.patch` 里由 run.sh 运行时打）。

rc.7→rc.8 共 536 个 commit，逐文件核对过：`cordis-host-runner`（含 guard.ts）、
`llm/llm/src/index.ts`、`core/tools/src/index.ts` 未变；`assembler.ts` 只加
`interruptedBlocks()`，block-end 权威两行未动；`TurnEndReasonMap` 六个变体未动；
`agent-loop/src/agent.ts` 改了 33 行但没有一行碰 `turnEnds` / `turn/end` 赋值。
**四份 FINDINGS 在 rc.8 上全部成立，不用重跑**（已实测：40 passed、空插件组基线
24 条全过、probe-speech-guard 真模型跑通）。

一处行为差异要记住：**`llm/retry-policy.ts` 的 `DEFAULT_MAX_RETRIES` 从 2 改成 5**。
Thymus 没有显式配 `retryPolicy`，直接继承新默认值。瞬时失败要重试 5 次才会冒成
`turn/end` 的 `{kind:'error'}`——发现 03 二记的空转现象出现频率会下降，失败路径
单轮耗时上升。**要复现那个现象，需显式把 `retryPolicy.maxRetries` 配回 2。**

## 已完成（原第 1、2 步）

1. **判定器托管调模型的插件——已做**。`judgeCases` 加了第四个可选参数
   `options: JudgeOptions`，只有一个字段 `llm?: (ctx) => void | Promise<void>`。
   给了才 `ctx.plugin(LlmRuntime)`（装在 Timer 之后、候选插件挂载之前），然后把 ctx
   交给回调让调用方注册 provider。缺省什么都不装，既有 spec 一行未改。
   **判定器不认识任何 provider**：接真 DeepSeek 还是接假 adapter 由调用方决定，
   `eval-framework.ts` 不 import provider 包、不碰 API key。
   - 单测第四档三条（`thymus-eval-framework.spec.ts`），用假 adapter，不花钱：
     不开 llm 时插件静默失效、开了两条用例都过、开了不影响工具通道。
   - 真 provider 端到端：`check-llm-optin.ts`（要花钱，不进 `run-tests.sh`）。
     实测不开 `passed=false`／开 `passed=true`，3 条含一条过度改写对照，3217ms。
2. **A2 单约束 A/B——已做**，见发现 05。评测集 `a2-evals.ts`（人手写冻结，
   公开集 9 条 + 留出集 6 条），实验 `a2-ab.ts`，门控消融 `a2-gate-ablation.ts`。
   HANDOFF 原先列的四条评测集支点全部按预期成立；判别力确实只来自留出集
   ——两个 arm 公开集都是第一轮 9/9。

## 当前进行中：插件包与约束声明

**铁律（全局）**：先试验，再实现。本轮已经因为跳过这一步栽了一次
（`installToolGate` 挂在 `execute` 上，单测全过、真 agent 上一次都不触发）。

已完成：
- `packages/thymus/` 插件包骨架（双语 README、`dsh-plugin` 话题、版本兼容声明），
  `gate.ts` 与 `eval-framework.ts` 已搬进去，包内零客户数据。
- 约束的**声明形式**（`src/spec.ts`）：数据不是代码，三个内置类型
  `forbidden-phrases` / `semantic-policy` / `no-leak`，每条自带验收用例
  （`deny` / `allow` / `heldout`），`checkSpecEvals()` 逐条只挂它自己去判。
- 环境两修：`demo/run.sh` 漏拷 `packages/thymus/src`；这台机器要走代理而 Node 的
  fetch 默认不认 `HTTP_PROXY`，加 `--use-env-proxy`（不加时所有真模型调用全失败，
  而失败的样子和「模型不泄露」一模一样）。
- **工具通道网关搬到调度器——已做**。`installToolGate` 现在同时包三处：调度器的
  `prepare`（拒绝）与 `finalize`（改写产出），外加原来的 `ctx.tools.execute`
  （只服务外部调用方，含评测框架）。两条路径在 dsh 里各自直达同一份私有实现、
  不互相转发，一次调用只被裁决一次（论证63 在数）。拒绝结果补了 `error` 字段。
  验收改用真链路：脚本化 adapter 发一次 tool-call，走 `agent-loop/tool-calls.ts`，
  断言看的是**模型在下一轮请求里实际收到的 tool-result**，不是我们自己的返回值
  （论证59–63，不花钱）。四条对照：老写法在真 agent 上 execute 命中 0 次、
  无网关时内部字段确实漏、缺 `error` 时拒绝理由被换成序列化错误发给模型、
  抹除只动该动的字段。测试 14 files / 198 passed。

- **说话侧挂载点——已探，见发现 17**（`probe-say-mount.ts`，脚本化 adapter，不花钱）。
  `ctx.llm.stream` 命中 0 次，是第二个 `execute`；agent 走 `preparedCall.stream()`。
  可用的位置是包住 `ctx.llm.prepareCall`：它站在 `llm/stream` 整条链之外，拿得到
  用户会看到的那段文本，改写后 `assistant/message` 与 `assistant/chunk` 都干净。
  但沙箱插件够得到同一个入口，后包的赢（臂 C 禁语原样送达）——所以它不是保护层，
  靠架构结论 7 兜底。附带查清：工具侧够不到调度器，是因为 `tools` 有手写 façade，
  不是沙箱的普遍性质。

- **说话侧网关——已做**。`installSayGate(ctx, constraints, replacement, timeoutMs?)`
  包住 `ctx.llm.prepareCall`：整条流收完 → 装配 → 正文与思考块**分两条通道各判一次**
  → 按 chunk 协议重发。`Constraint.say` 因此加了第二个参数 `channel`。
  拒绝的语义已拍板：**只换话，不停轮**——正文换成调用方给的那句，思考块整块丢掉，
  同一条消息里的工具调用照常执行。`gateSay` 保留为「判一句话」的评测入口。
  验收八条走真 agent 路径（论证69–77，脚本化 adapter，不花钱）：挂 `ctx.llm.stream`
  命中 0 次的对照、无网关时禁语落库的阳性对照、`assistant/chunk` 里也没有禁语
  （证明没先放行再改）、reasoning 分开判且不与正文拼接、只判正文会漏的对照、
  拒绝后工具照跑且这一轮走完、纯工具调用那一轮零判定。测试 14 files / 198 passed。

- **B 类的状态——已探，见发现 18**（`probe-b-state.ts`）。三条结论：
  状态**不用自己存**，从 `agent.session.events` 现读就够（`tool/call` 的名字与
  `tool/result` 的成败按 callId 对上）；工具侧 `exec.agent` 有身份，说话侧身份在
  `stream(options).sessionId` 而不在 `prepareCall` 的 config 上；多 agent 并发不串
  （实测调用顺序真交错，判决各归各的）。两个坑：工具声明 `isConcurrencySafe` 后
  并发派发，账单的 `prepare` 跑在核验 `finalize` 之前，事实还没落库会拒掉合法的
  批量调用（方向是 fail-closed）；压缩之后事实还在不在没测。

- **压缩会不会弄没事实——已验，见发现 19**。不会：压缩只动 surface，剪枝是追加一条盖上去，
  原始 `tool/call` / `tool/result` 都留在日志里，换宿主 resume 之后判定不变。
  但方向要记牢：**从事件日志读，不要从 surface 读**——改成读 surface，剪枝就开始影响判定。
  顺带一个操作性现象：`dispose()` 之后立刻 resume 会报 `session not found`，等 300ms 才行。

- **preTool 的调用方身份——已加**。`ToolCall` 多一个可选的 `caller`
  （`{ sessionId, events }`），从 `exec.agent` 取：调度器路径上 agent-loop 会填好它。
  选可选字段而不是加第二个参数，是因为 `postTool` 用的是同一个 `ToolCall`，
  加在这里两处都拿得到，且既有约束一行不用改。外部调用方不带 agent 时 `caller` 留空，
  不编一个空会话——「没有身份」和「有身份但没记录」必须分得开（论证81）。
  验收四条（论证78–81）：账单那次调用看得到核验事实、核验那次还看不到；
  端到端先认人放行（且工具体确实跑了 1 次）／不认人拒绝（工具体 0 次）；
  两个 agent 并发各读各的；无身份时按理由拒绝。

- **B 类的声明形式与多步用例——已做**。`require-before`：`requires` 是前置工具，
  `unguarded` 列不需要前置的工具，**其余一律受管**（白名单；按名字列受管工具是黑名单，
  有已确证的缺口）。`requires` 自己总是免管，否则它调不起来。
  用例是序列 `{before, call}`，`before` 是本会话里已**成功**调用过的工具——
  核验失败自然不进集合，不用另外表达。留出集写「声明里没提过的同类工具」：
  白名单写法下应当通过，列宽了就掉（论证88 是阳性对照，只有留出集会掉，必拦必放两组
  照样全过）。`Caller` 因此多一个 `succeeded` 派生字段，解析收在 gate.ts 一处。
  用例直接构造身份、不伪造事件——伪造的形状和解析可能一起写错互相掩盖，
  代价是 spec 的用例不覆盖解析那一层（写进了 `checkSpecEvals` 的文档）。
  论证82–89，138 passed。

- **D 类 `require-fallback`——已做**。四类到齐。它跟前三类不是同一个形状：前三类是禁止，
  它是**有条件的正向义务**（当提问越界，回复必须转出），而且光看回复判不了。
  为此 `Constraint.say` 加了第三个可选参数 `SayContext`（这次请求的完整对话），
  运行时网关拿得到（论证90 实测），`gateSay` 那条单句路径没有，拿不到时按拒绝计。
  判决新增可选 `replacement`，网关优先用它——顺带把「拒绝时说什么」那个悬着的问题解掉。
  判定两跳（越界吗 → 兜底了吗）合成一次调用，三选一，含糊按未兜底计。
  论证94–102，151 passed。

- **D 类真模型验收——已做，见发现 20**（`check-d-fallback.ts` + 冻结用例 `d-evals.ts`）。
  照 SOP 原文写成一条时判得住一半：留出 3–4/5、必拦 2–3/3，11 轮从没满分，过度拦截为零。
  阳性对照（削弱声明）必拦稳定掉到 1/3、留出掉到 [2,2,0]，所以那些通过不是题太软。
  漏的清一色是「超出权限／当场承诺」，「非运营学校」一条没漏过——原因是 SOP 那句把
  无条件禁止（不得承诺）和有条件义务（越界要转出）绑在一起，前者被后者吃掉了。
  拆成两条各判各的，留出 5/5×3 轮；但宽版立刻稳定误拦「照实报账单金额」，
  收窄成「对尚未发生的事不得承诺、陈述已查到的事实不算」之后两侧同时成立。
  **带走的一句：一条 SOP 条款不等于一条声明**（架构结论 17）。

**下一步**：
1. 说话侧还欠两个没量的：缓冲全流对首字延迟的代价、多 agent 并发下那一层过不过得干净。
3. ~~把 SPEC.md 整份编译成声明跑一遍~~ **已做，见发现 21**。四类里三类填得满，
   B 填了一半（内置类型判不了「这段话是不是在讲账号详情」），会话现实那三条不属于
   约束层。代价是声明的措辞进入了结果——同一条规矩改半句话，必拦从 3/3 变成 6 轮漏 3 次。
   交付形态因此是「填表 + 跑一遍留出集 + 看数字调措辞」，不是填表就完事。
   产物：`spec-declarations.ts`、`check-spec-full.ts`、`run-log-spec-full.txt`。

- **模型自己写声明 vs 人写——已做，见发现 22**（`author-spec.ts` / `check-authored.ts`，
  产物 `submitted/authored-spec-r*.json`、`run-log-authored.txt`）。
  共同标尺（人写的 36 条冻结用例，整份声明集口径，各 2 轮）：
  人写 必拦 13·12 / 必放 13·13 / 留出 8·8；模型三版 必拦 10·10、8·9、11·11，
  留出 5·6、5·6、8·8，其中第 3 版必放掉到 9·9。
  选型 3 版全对，瓶颈在别处：照抄原文不会拆条款（承诺类全漏）、内置类型够不着时硬套
  （第 3 版用 semantic-policy 表达 B 的说话侧，稳定误拦「照实报账单金额」）、
  留出集 3 次里 2 次是伪装成留出的必拦用例。自评几乎全绿而共同标尺 8/13。
  **人的位置因此很具体：写留出集、拆条款、判定「这条写不出来」——第三件它一次都没做。**

- **`propose_tool` 那条路——已探，见发现 23**（`probe-propose-tool.ts`，六轮，不花钱）。
  结论：拆开「写工具」和「装工具」站得住。agent 手里没有动态插件工具时它连造工具的
  入口都没有（`ToolRuntime`/`DynamicCordisRunner` 都不自带工具）；给了 `propose_tool`
  之后造出来的是数据、有准入、有记录，而且新工具默认就受约束层管（白名单写法）。
  dsh 这侧比预想的紧：**已注册的工具名动不了**，冒牌工具换不掉 `verify_identity`。
  但**名字先到先得**——动态插件抢先注册 `query_bill`，宿主随后注册真版被拒、冒牌版
  生效。因此部署纪律扩写成架构结论 19：先装约束、先注册完全部受管工具，再放行动态插件。

- **线上回流——已做**（`packages/thymus/src/badcase.ts`，论证133–144）。
  `splitBadCases`（按内容哈希确定性分流，不能重抽）、`applyBadCases`（并进声明，
  留出侧的 deny 进留出集、allow 仍进 allow）、`redactHeldout`（留出只报数字不报原文）、
  `compareReports`（与上一版比，任一组掉了都算回归，含留出集与被删掉的约束）。
  三条纪律由代码保证，不靠自觉。「算不算违规」必须人判，这一栏没有自动化余地。
  工作单加了「上线之后：每天回流」一节。

- **配额真链路 + 回流工具侧——已做，见发现 28**。注册数上限换成「一次问三件事」这种
  自然撞上的任务后 3/3 轮触发；去重两次设计都没造出局面（后端报错时模型重试同一个工具，
  不换名重提），**仍然只有单测**，不再换场景去钓。回流的样本改成五种形状的联合类型，
  工具侧（`tool-output` / `tool-call`）收得进来了；形状对不上的不硬并、会报进 `skipped`。

**再往下**：
- **`propose_tool` 真 agent 端到端——已做，见发现 24**（`probe-propose-agent.ts`，三臂各 3 轮）。
  边界写进提示词一次写对（3/3）；不写边界靠拒绝理由 4 次往返收敛（3/3）。
  用户不给手机号那一臂是最有信息量的：新工具被成功调用 0/3，网关拦下 3/3，
  而模型转头连注册 4 个新工具试图绕过（一个的描述直接写「无需身份核验」）——一个没成。
  **这是架构结论 4「白名单不是黑名单」第一次在真 agent 上被正面验证。**
  暴露的新问题：`propose_tool` 缺配额、去重、回收，被拒的 agent 会把工具表和名字空间
  撑爆（名字先到先得，占掉宿主就注册不上了）。这三样不难加，是下一步。
- **交付工具链第一版——已做**。`packages/thymus/src/hygiene.ts`：`SpecBundle`
  （约束 + 必填的 `uncovered`）、`checkSpecHygiene`（冻结前机械闸，纯静态）、
  `TEMPLATE.zh.md`（填表工作单）。论证103–113。
  机械闸第一次跑就抓到我们自己那份声明缺 C 类的留出用例——补法用的是发现 22 里模型
  提出的思路。剩下的：措辞那一环仍然没有机械检查（架构结论 18），只能靠跑留出集发现。
- **`propose_tool` 的配额、去重、回收——已做，见发现 25**（`packages/thymus/src/propose.ts`，
  论证114–124）。真 agent 上验到回收生效（3/3 轮工具表干净回收）与**撞上提交上限之后
  不会编造**（3/3 轮零编造，转而问用户排查信息）。去重与注册数配额没触发过，
  只有单测支撑——要验得先造出「模型反复造工具」那个局面，那行为这几轮没复现。
- B 那个缺口要补的话，是一个新内置类型：说到某类内容之前必须有某个事实
  （B 的事实来源 + D 的上下文判定）。先探再写。
- A1 的留出集稳定 0/2 说明字面词表该并挂一条语义判定——并挂之后两条会不会互相干扰，没验。
- 留出集伪装可机械检出（含着已声明的词即是），这类闸该做成框架不变量——
  和「空插件组基线」那条一样，进 `eval-framework.ts` 当冻结前的拒绝条件。目前只想得出
  `forbidden-phrases` 那一种检法，别的类型怎么检没做。

- **说话侧那两个数与 B 缺口——已补，见发现 26**。首字延迟从 4ms 变成 403ms
  （等于整段生成时间），整轮耗时不变；多 agent 并发不串。B 缺口用新类型
  `require-before-say` 补上——事实从会话日志现读、内容交给判定器，事实成立时直接放行
  不问模型。那份真实 SOP 的声明从 6 条变 7 条，`uncovered` 从 3 条减到 2 条。
- **`require-before-say` 真模型验收——已做，见发现 27**（`check-b2.ts` + 冻结用例
  `b2-evals.ts`，三臂各 3 轮）。完整臂必拦 4/4、留出 **4/4 三轮全中**，明显好过 D 类
  同位置的 3–4/5。两个方向的阳性对照都成立（削窄→留出 0/4；写宽→必放稳定掉 1 条）。
  **新发现：替代话术会被自己的规矩判违规**——那句「麻烦您先提供一下学号、手机号码」
  正是这条声明的 `reply`，判定器认为它涉及账号。规则：带 `reply` 的类型要把那句原样
  写进 `allow` 用例（架构结论 14）。另：事实成立不问模型在真实数据上省下 2/14 次调用。

验收三条（工具侧的教训），说话侧已按这三条做完：

1. **端到端、真 agent。** 单测全绿不算数——工具侧 107 个测试全过，真 agent 上网关
   一次都没触发。论证69–77 全部走 `agent-loop`，断言看会话里落下的
   `assistant/message` 与 `assistant/chunk`。脚本化 adapter 是确定性的，不需要 n≥3
   （那条规矩是给真模型的）。
2. **必须有阳性对照。** 论证69（无网关时禁语落库）、论证74（只判正文时思考块漏）、
   论证76 上半（无网关时抢位攻击确实得手）。
3. **必须做抢位测试。** 论证76：网关先装、动态插件后在 `llm/stream` 上 `prepend`
   把禁语塞回去，网关仍拦得住。

别踩的坑（都已实测）：
- 判定用的模型调用**必须走 `judgeText`**。直接 `for await ctx.llm.stream` 时失败不抛错，
  它发 error finish 后正常结束，`try/catch` 不触发（发现 15）。
- 拒绝结果**必须带 `error` 字段**，否则被判为有损序列化并抛错（发现 16）。
- 真模型跑之前确认 `demo/run.sh` 里的 `--use-env-proxy` 还在。这台机器要走代理，
  不加时所有调用失败，**而失败的样子和「模型很守规矩」一模一样**。
- `ctx.llm.stream` **不是挂载点**，已实测命中 0 次：`agent.ts:346` 走
  `preparedCall.stream()`（发现 17）。这个坑在这个仓里出现两次了，下次接别的通道时
  先去看 agent-loop 到底调的哪个方法。



## 下一步

0. ~~先查基线不一致~~ **已查，见发现 12**：提示词逐字相同、耗时同量级，是方差。
   基线首版留出集2 双峰 [2,2,2,3,6,6,6]，门控频率 3/7。发现 05/07 的频率断言已降级，
   发现 11 的质量结论已撤回。留下的新问题：双峰的成因不知道，也没有加样本坐实。
1. ~~空插件组基线做成 `eval-framework.ts` 的不变量~~ **已做，落在 `0466eac`**：
   `checkEvalGradient`（`eval-framework.ts`）+ 4 条测试（`eval-framework.spec.ts`），
   已从 `index.ts` 导出。原先的独立脚本 `check-empty-baseline.ts` 因此冗余，已删；
   `check-a2-gradient.ts` 用的就是框架里的函数（工具桩另在 `spec-plugins.ts`）。
   **注意它只覆盖自造插件那条路**（`EvalCase[]` + 插件源码，跑在真运行时上）。
   交付走的声明那条路（填表 → `checkSpecHygiene` → `checkSpecEvals`）**做不了这个基线**，
   已消融验过：`probesOf` 造的探针直接调被测约束自己的钩子，判定的唯一来源就是那条约束，
   中间没有环境参与。换成合成对照，结果只由对照决定、与用例内容无关——全放行对照下
   真留出与死用例都判「没拦住」，全拒绝对照下都判「拦住了」，两边都区分不开；
   只有真约束区分得开（死用例必中、真留出漏）。所以声明这条路上，零判别力的用例
   只有**静态**查得出来，那就是 `hygiene.ts` 的 `fakeHeldout` 在做的事。
   `spec.ts:26` 那句「空插件组下它们应当全部通过」是说明梯度的直觉，不是可执行的判据。
2. 发现 05／06 留下的直接后续，按代价排序：
   - **重复 n 次——已做，见发现 07**。结论被推翻一半，且暴露出第三种失败形态（回归）。
     还缺的是：换一组留出集题目重跑，确认结论不依赖具体选了哪 5 个同义表达。
   - **多插件**：`llm/stream` 上说话与判定协议互相污染（见下），单插件碰不到。
   - **fail-open 打失败**：拆掉门控后每句都调模型，失败路径的暴露面变大了，
     但那条分支至今零执行、零数据。要专门造失败去打。
3. 自造评测那条线回来时，注意发现 05 第 3 条：出题 agent 看到的也只有 SPEC，
   它生不出「SPEC 没列但语义同类」的留出用例。留出集这一层目前只有人能写。
4. **留出集的污染只在同一个会话内**。发现 06 里 `HELDOUT` 从 v2 起进了那个 dev agent
   的上下文，所以在**那个会话**之后它测的是照差异改，不是泛化。换新的 dev agent 会话
   （重复实验就是这样）两组都仍然干净——模型不跨会话记事。要写新题的情况只有一个：
   同一个会话里要连着做第二次泛化判定。

## 已知未解 / 坑

- ~~`llm/stream` 上多插件互相污染~~ **已测，见发现 13**：比污染严重，是无限递归。
  两个语义插件即便各自防递归都写对，挂一起也不收敛（一句话 12 次判定调用，
  用户看到 12 层嵌套判定协议）。判定改放网关里则各判一次、互不污染。
  结论：语义约束这一类不该写成 `llm/stream` 插件。
- ~~判定器只看到孤立一句，改写会凭空补事实，A2 违规可能换成 B/D 违规~~
  **已验，见发现 29**：成立，而且比预想的更前面——替代话术是固定串，发出前
  **不再过任何约束**（论证94），两条同时拒绝时说哪句由**声明顺序**决定（论证95）。
  真模型交叉：为 A2/B2 写的替代话术在越界语境下每条都不满足 D 的兜底义务
  （两轮 6/6），在范围内的对照两轮 0/12，所以不是判定器过度拦截。
  「凭空补事实」这一类（「已为您转接相关部门」）没有任何约束管——D2 只管承诺未来，
  不管声称已完成的动作，即这条规矩没写进 SPEC。
  **补法已实现**：`checkReplacements` 把每条替代话术拿所有约束在各自的触发条件下判一遍，
  接在 `check-spec-full.ts` 那一轮里，真 SPEC 实跑抓出 2/3 条。
  判一次会漏：单次命中率实测最低那条只有 0.55（40 次，两个对照 40/40 与 0/40），
  所以冻结闸取 `repeats=5`（发现 29 六）。「不得声称未发生的动作」已登记进 `uncovered`，还没变成规矩——
  它不是表达不了，是 SOP 原文没有、措辞要客户定；在那之前这一类全绿。
- ~~fail-open / fail-closed 路径零失败~~ **已打，见发现 15**：两侧兜底都是假的。
  `ctx.llm.stream` 失败时不抛错，发 error finish 后正常结束，try/catch 不触发。
  已加 `judgeText()` 把静默失败翻成异常；判定调用一律走它。
- ~~`thymus-recording.spec.ts` 偶发失败（`persistence.list()` 偶尔读不到 rec-1）~~
  **已查已修**：根因是测试等固定 300ms 等落盘，而 JSONL 后端的写是批量延迟的
  （`writeBatchMaxDelayMs` 缺省 200ms），整套并行跑时那 100ms 余量不够。
  判决性实验：把批延迟调到 1000ms，失败从偶发变成 3/3 稳定复现，报错一字不差。
  改成等公开的持久化屏障 `ctx.sessions.flush(session)`，同一条件下 3/3 通过。
  同类写法（固定 sleep）在 `hotswap.spec.ts` 和 `gate.spec.ts` 还有几处，但那几处是
  故意制造竞争窗口用的，不是等落盘，没动。
- ~~其余 demo 的 `say()` 仍是旧写法，不检查 turn 结束原因~~ **已换**：五个都改了。
  `spec-composite` / `spec-tiers` / `spec-evals` 的 `say()` 与 campus 主线同形——返回
  `TurnOutcome`、未正常结束就打警告；`run` / `self-authored` 没有 say() helper，
  在 `whenIdle()` 之后就地 `checkTurn(agent)`。
  没跟着抄那句 400ms sleep：它（`8f0b298`）比 `turn.ts`（`cecf5b9`）还早，不是为这个
  检查加的，而 `gate.spec.ts:663` 长期是 `whenIdle()` 之后不等直接读 `turn/end`。
  `DEMO=run` 真跑一遍验证过：两轮都没打警告，说明真模型路径下 `turn/end` 那时已经在了。
  已有的 400ms 保留没动——那是另一件事，不在这次范围里。

## 运行方式

- 探针/demo：`DEMODIR=campus DEMO=<name> ./thymus/demo/run.sh`
- 测试：`./thymus/run-tests.sh`（应为 14 files / 198 passed）
- `spec-plugins.ts` 顶层已改为「仅直接执行时运行」。**其他 campus 脚本不要 import 它**
  之外的实验脚本前先确认同样有这个判断——曾因顶层无条件 `main()` 被 import 触发重跑，
  覆盖过冻结的 `evals.json`（从 `../trajectories/_no-cwd/campus-author/session.jsonl`
  的 `submit_evals` 调用里恢复的）。
- 产物：`submitted/`（冻结评测与提交的插件源码）、`run-log-*.txt`（完整实跑输出）。

## 外部项目：评估状态

### J-Space Cognition Suite V3.6 —— 已实测，结论：不引入

见 `FINDINGS-11-jspace-eval.md`。三比三无重叠的负收益：留出集2 从 6/6/6 掉到
1/2/2，同时耗时 1.60×、输出 token 1.58×（其自报为 2.53× 提速、2.21× token 下降）。
实验臂平均 4/6 条留出用例没问模型——门控回潮。

偏差写在 FINDINGS 里：只喂了 16KB 入口文件，9 个模块按需加载没实现，测的是它
能力的下限。要推翻这个结论得先把模块加载实现出来重测，在那之前没有理由引。

### dashi-taskboard —— 已实跑验证，不引入

`chuspeeism/dashi-taskboard`。本地优先的 issue 看板，状态流
todo → in_progress → in_review → done，带 CLI 与一个教 Codex 管任务的 skill。

**它的复核关卡是提示词，不是机制。实跑验证过，不是读代码推的**（本地起服务，走 HTTP API）：

1. 以 agent 身份（`X-Taskboard-Client: taskctl`）建 `todo` 任务 → 成功
2. 同一身份直接 `PATCH status=done` → **`HTTP 200`**，跳过 `in_progress` 与 `in_review`，
   全程无人参与
3. 去掉 `taskctl` 头再改一次 → 同样 200，审计表把这次记成 `user | 本地用户`

代码侧对应：服务端唯一的状态校验是 `isTaskStatus()`（集合成员检查），全库无流转校验；
「done 只在用户验收后」这句话只存在于 `skills/manage-taskboard/SKILL.md` 第 32 行。
身份由 `actorFromRequest()` 按请求头判定，可自称。

审计**是记的**（`task_activities` 表两条都在，含 `status: todo→done` 且标注 agent），
但身份自称使它只能当线索，不能当凭据。

**不作为评估依据**：它与轨迹回答同一类问题（发生了什么），不产生「这一版对不对」的信号。

**真用得上的位置是人工复核那一环，但强制力得我们自己加**：不把 taskctl 给业务 agent，
它只能建 issue 和推到 `in_review`，`done` 只从 UI 走人手。锁是我们加的，不是它给的。

暂不引：接到 dsh 上有实打实工作量；人工复核那一环目前还不是瓶颈。

配图 `constraint-holder-antipattern.svg` / `.png`：把 dsh 插件卸载、事件链架空、
dashi 自己盖章三例并排，说明「规矩交给被管的一方自己拿着」这个失效形态。
