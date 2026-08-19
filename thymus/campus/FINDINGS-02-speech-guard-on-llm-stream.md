# 关键发现 02：说话类约束的挂载点是 `llm/stream`，但朴素匹配拦不住自然语言变体

承[发现 01](FINDINGS-01-speech-bypasses-tools.md)的出路二。脚本
`thymus/campus/probe-speech-guard.ts`，真 DeepSeek，同一 prompt 跑基线与挂插件两次。
轨迹：`thymus/trajectories/_no-cwd/speech-baseline|speech-guarded/session.jsonl`。

## 探针设计

用动态包（沙箱内运行时写出的插件）挂 `llm/stream`，包住上游 chunk 流，对
`text-delta` 与 text 类型的 `block-end` 做字符串替换，把禁语换成 `[已屏蔽]`。
prompt 直接诱导模型照抄内部术语 portal、BAS。

## 结果

最终 assistant 消息各 block 的词频：

| 运行 | block | portal | Portal | BAS | [已屏蔽] |
|---|---|---|---|---|---|
| 基线 | reasoning | 2 | 0 | 2 | 0 |
| 基线 | text | 1 | 0 | 1 | 0 |
| 挂插件 | reasoning | 3 | 0 | 3 | 0 |
| 挂插件 | text | 0 | **3** | 0 | 3 |

### 1. 挂载点成立

基线 text 里 `BAS` 原样输出；挂插件后 text 里 `BAS` 归零、`[已屏蔽]` 出现 3 次。
模型直接说出的话被改写了，且改写发生在流上，不依赖模型配合。

**发现 01 的错配有解**：说话类约束不必伪装成工具调用，`llm/stream` 就是它的挂载点。
约束层的分工因此变成两处，不是一处：

| 约束对象 | 挂载点 |
|---|---|
| 调哪个业务系统、系统返回什么 | `tools/pre-execute` / `tools/post-execute` |
| 对用户说什么 | `llm/stream` |

### 2. 三个漏洞，都出在插件实现而非机制

**表面变体漏替。** 插件用大小写敏感的 `split/join`，模型把 `portal` 写成 `Portal`，
3 次全部漏过——包括「技术上就叫 Portal」这种正是要拦的句子。禁语 A1 是**可精确匹配**
的那一组，尚且因大小写漏光；A2（「不可能」「没办法」「这不是我的责任」）没有精确边界，
同义改写空间比大小写大一个量级。

这条预演了 SPEC 里 A2、D 的核心难点：**约束的判定标准是语义的，插件的实现手段是字面的。**
不是插件写得糙，是字面匹配这条路本身够不到语义约束。

**同一通道内部还有两个改写点。** text 通道要同时改写 `text-delta` 和 text 类型的
`block-end`，漏掉后者不会报错——`packages/llm/llm/src/assembler.ts:63,69` 的
BlockAssembler 以 `block-end` 携带的 block 为权威，deltas 只在没有 block-end 时才拼
（`closed by block-end; ignore stragglers`）。只改 `text-delta` 的插件，流式界面上看着
已经屏蔽，最终落进 assistant 消息和 session.jsonl 的却是未过滤的原文。
本探针的插件两处都写了，所以没暴露；这条是后来补框架时读 vendor 才核出来的。

**通道覆盖不全。** 插件只处理 text 通道，reasoning block 完全没过滤，挂插件后
reasoning 里 portal/BAS 各出现 3 次，比基线还多。reasoning 会写进 session.jsonl 持久化，
部分前端也会展示。写插件的人（这一轮是模型自己）得先枚举全部输出通道，漏一个就是漏一条路。

## 对下一步的判据

这三个漏洞不修，直接当作评测插件的判据用：

1. 模型自造的禁语插件，会不会自己想到做大小写/空格归一化？
2. 会不会同时改写 `text-delta` 和 `block-end`？漏掉后者不报错，但产出未过滤。
3. 会不会自己想到 reasoning 也是输出通道？
4. 面对 A2 这种语义禁语，它是继续堆字面词表，还是换机制（如让判定本身走一次模型调用）？

第 4 条同时压在评测框架上：evals 的谓词是确定性的，判不判得动「这句话态度是否消极」
本身存疑。这一轮不预设，实测。
