# 交接：校园网客服 agent（新会话从这里接）

对话上下文损坏（长上下文触发解码退化，反复吐 "court" 乱码），换会话继续。
仓库代码与所有 FINDINGS 都在，未丢。

## 这一轮在验什么
用一份真实客户材料（西安新路《客服部作业指导书》.docx）验证核心命题：
**过去要人写的客服插件/工具，能不能换成 agent 自己写、自己用**。
需求以「给人读的真实文档」形态到达（口语、模糊、条款交叉），看内核在哪散架。
spec 已提取：thymus/campus/SPEC.md（四类约束：A禁语/B认人前置/C内部字段不外泄/D越界兜底）。

## 已确认的关键发现

### 发现01（已记录 thymus/campus/FINDINGS-01-speech-bypasses-tools.md）
客服 agent 对用户「说话」走的是 assistant 消息，不是工具调用，绕开整条 tools 管线。
→ 我们全部约束都挂在工具调用上，最重要的禁语约束恰好拦不到。
（但追问填槽行为正确：信息不全时 agent 会先问，不瞎调工具。probe-multiturn 已验。）

### 发现02（已记录 thymus/campus/FINDINGS-02-speech-guard-on-llm-stream.md）
出路验证成立：**禁语约束能挂在 dsh 的 `llm/stream` 事件上，拦住模型直接说出的话。**
- 脚本：thymus/campus/probe-speech-guard.ts（子 agent 后台跑通，非本损坏上下文）
- 基线：模型直说 portal、BAS
- 挂插件后：BAS 被成功替换为 [已屏蔽]
- 结论行原文：「说话类约束挂在 llm/stream: 成立，拦住了模型的话」
- **但暴露真问题**：插件是朴素字符串匹配、大小写敏感。模型把 "portal" 写成大写
  "Portal"，该词漏替。→ 连精确术语都会因自然语言表面变体（大小写/空格/同义）
  漏掉，预演了 A2 语义禁语、D 兜底这类「判定标准本身模糊」约束的核心难点。

## 新会话第一步
1. ~~把发现02 与「大小写漏替」补记进 FINDINGS 文件。~~ 已完成，另补记了
   reasoning 通道未过滤（插件只覆盖 text block）。
2. 然后继续客服主线：agent 自造一组插件（禁语走 llm/stream、认人前置走
   tools/pre-execute、内部字段脱敏走 tools/post-execute），独立 evals 判。
   预期禁语的语义部分会暴露「评测框架谓词不够判语义」的边界——这本身是有价值的产出。

## 运行方式
- 探针/demo：`DEMODIR=campus DEMO=<name> ./thymus/demo/run.sh`
- 测试：`./thymus/run-tests.sh`
- 重活（构建/真模型调用）建议派子 agent 后台跑，避免再触发上下文损坏。
- 分支 spike/layer-feasibility。DEEPSEEK_API_KEY 由 .env.local 自动加载（勿入库）。

## 待办：J-Space 两个仓库（用户问过，暂缓）
Tiger3807861189/J-Space-Cognition-Suite-V3.6 及其 report。是推理时认知脚手架
（提示词/skill 层），与 Thymus（运行时/插件/治理层）不同层，不冲突不互替。
唯一潜在接触点：若它真能提升 DeepSeek 写码正确率，未来可作为开发 agent 的 skill
缓解「多插件正确率不足」。但其性能数字系自报、未经我们验证，暂不引入。
