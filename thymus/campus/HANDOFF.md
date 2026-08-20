# 交接：校园网客服 agent（新会话从这里接）

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

**分层结论：写规矩，模型能；判自己写得对不对，现在不能；语义那部分，机制上够到边了，
模型也会走，但它第一版通常会把旧机制留在前门、收益自己抵消（5 次里 4 次）。
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

## 下一步

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

- `llm/stream` 上「对用户说的话」和「判定协议」是同一条通道，多插件下会互相污染
  （发现 04 组四实测：判定器的原始 JSON 直接成了用户正文）。
- 判定器只看到孤立一句，没有会话上下文与工具调用事实，改写会凭空补事实
  （「我这就为您转接」），**A2 违规可能换成 B/D 违规**。未交叉验证。
- fail-open / fail-closed 路径零失败，没走到过，没有数据。
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

## 待办：J-Space 两个仓库（用户问过，暂缓）

`Tiger3807861189/J-Space-Cognition-Suite-V3.6` 及其 report。是推理时认知脚手架
（提示词/skill 层），与 Thymus（运行时/插件/治理层）不同层，不冲突不互替。
唯一潜在接触点：若它真能提升 DeepSeek 写码正确率，未来可作为开发 agent 的 skill
缓解「多插件正确率不足」。但其性能数字系自报、未经我们验证，暂不引入。
