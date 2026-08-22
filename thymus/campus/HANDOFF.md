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

**下一步（已探明，可以动手）**：把 `installToolGate` 从 `execute` 改挂到调度器
（`prepare` 拒绝 + `finalize` 改写），同时保留 `execute` 的包装给外部调用方；
拒绝结果补 `error` 字段（见发现 16，现在这个 bug 一挂上去就会炸）。
说话侧改成挂 `llm/stream` waterfall、装配后裁决，不再自己 dispatch。

之后：B 类（认人前置）——它要跨调用记状态，得先探状态挂在哪、多 agent 会不会串。

## 下一步

0. ~~先查基线不一致~~ **已查，见发现 12**：提示词逐字相同、耗时同量级，是方差。
   基线首版留出集2 双峰 [2,2,2,3,6,6,6]，门控频率 3/7。发现 05/07 的频率断言已降级，
   发现 11 的质量结论已撤回。留下的新问题：双峰的成因不知道，也没有加样本坐实。
1. 空插件组基线做成 `eval-framework.ts` 的不变量：冻结前重放一遍，全过就拒绝冻结。
   脚本已有（`check-empty-baseline.ts`），搬进去加测试即可。原计划的前置条件
   （第 2 步先给出机制层答案）已满足。
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
- 判定器只看到孤立一句，没有会话上下文与工具调用事实，改写会凭空补事实
  （「我这就为您转接」），**A2 违规可能换成 B/D 违规**。未交叉验证。
- ~~fail-open / fail-closed 路径零失败~~ **已打，见发现 15**：两侧兜底都是假的。
  `ctx.llm.stream` 失败时不抛错，发 error finish 后正常结束，try/catch 不触发。
  已加 `judgeText()` 把静默失败翻成异常；判定调用一律走它。
- `thymus-recording.spec.ts` 偶发失败（`persistence.list()` 偶尔读不到 rec-1），两跑一挂，
  既有问题，未查。跑到它挂就重跑。
- 其余 demo（`../demo/spec-composite`、`spec-tiers`、`spec-evals`、`run`、`self-authored`）
  的 `say()` 仍是旧写法，不检查 turn 结束原因。要重跑哪个先换掉。

## 运行方式

- 探针/demo：`DEMODIR=campus DEMO=<name> ./thymus/demo/run.sh`
- 测试：`./thymus/run-tests.sh`（应为 7 files / 40 passed）
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
