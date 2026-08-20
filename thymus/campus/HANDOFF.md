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

**分层结论：写规矩，模型能；判自己写得对不对，现在不能；语义那部分，机制上够到边了，
代价和副作用还没算清。**

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

## 依赖状态（2026-08-19 核对）

vendor 的 dsh 是 `0.1.0-rc.7`（`99f6f02`）。上游已发 `dsh-v0.1.0-rc.8`（`141eb6fef`），
中间 536 个 commit。按文件比对我们全部结论压在上面的那几处：

```
未变  cordis-host-runner/src/guard.ts    ← 沙箱 façade，policy 层可达性压在它上面
未变  cordis-host-runner/src/index.ts    ← 动态插件运行时
未变  llm/llm/src/index.ts               ← llm/stream waterfall、ctx.llm.stream
未变  core/tools/src/index.ts
已变  llm/llm/src/assembler.ts           ← 只加 interruptedBlocks()，block-end 权威两行原封不动
已变  core/session/src/types.ts          ← TurnEndReasonMap 六个变体一个没动
```

**四份 FINDINGS 在 rc.8 上仍然成立，不用重跑。** 但 agent-loop 的取消/收尾改了
（「取消的流要 finalize 已交付前缀」「失败的尝试不要 finalize」），那正是 `say()`
空转问题所在的地带——升级后 TRANSPORT 失败在事件里的表现可能不同，`src/turn.ts`
的判断要重新验。升级不急。

## 下一步

1. 判定器托管调模型的插件。`src/eval-framework.ts` 的 `runCase` 只装了 Timer /
   SystemPrompt / ToolRuntime / DynamicCordisRunner，**没装 LlmRuntime**，一个调模型的
   插件挂上去当场废。这是 A2 实验的直接阻塞。建议做成 opt-in，不要让既有 spec 变成
   非确定性、要花钱。
2. A2 单约束实验，评测我们手写冻结。手写是**故意拿掉一个变量**（发现 03 里评测符号
   反了，把插件侧的真实水平埋掉了），不是退回去；自造评测那条线在第 3 步回来。
   评测集设计的支点（发现 04 已验证它站得住一半）：
   - `said-excludes` 断言违规词不出现 —— 两种机制都可复现，**可用**
   - 正常话术 `said-includes` 原文片段做过度改写对照 —— **可用**
   - 任何对改写出来的内容做字面断言 —— 语义版上每跑都不同，**不可用**
   - 判别力来自**留出测试集**：拿 SPEC 没列的同义表达做断言，词表版必漏，语义版才可能过
3. 空插件组基线做成 `eval-framework.ts` 的不变量：冻结前重放一遍，全过就拒绝冻结。
   脚本已有（`check-empty-baseline.ts`），搬进去加测试即可。放最后是因为它属于自造评测
   那条线，要等第 2 步给出机制层答案后再跑才不会两个变量一起动。

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
