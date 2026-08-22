# 发现 17：说话侧的挂载点——机制上够得到，但防不住同侪

探针 `probe-say-mount.ts`。模型接脚本化 adapter，不花钱，走的是真 agent 路径
（`agent-loop` → `llm` → adapter）。HANDOFF 原先写「说话侧改成挂 `llm/stream` waterfall」，
这一轮先验它，结论是三个位置里只有一个可用，而可用的那个不满足保护层的要求。

## 一、`ctx.llm.stream` 是第二个 `execute`

| 位置 | 命中 |
|---|---|
| `ctx.llm.stream` | **0 次** |
| `ctx.llm.prepareCall` | 1 次 |
| `prepareCall` 返回句柄的 `stream` | 1 次 |
| `llm/stream`（宿主侧 listener） | 1 次 |

`agent.ts:346` 是 `preparedCall?.stream(request) ?? this.loopCtx.llm.stream(request)`，
而 `prepareCall` 只在没注册 adapter（`NO_ADAPTER`）时才抛。正常部署下后半永远走不到。
**同一个坑在这个仓里出现两次了**（工具侧是 `execute`），形状一样：公开入口给外部调用方，
agent 自己走另一条。

返回的句柄是 `Object.freeze` 的：直接改它的 `stream` 抛
`Cannot assign to read only property 'stream' of object '#<Object>'`，只能整个换一个对象。

## 二、包住 `prepareCall` 确实站在 `llm/stream` 整条链之外

两个入口最后都进 `streamWithRegistration`，`ctx.waterfall('llm/stream', …)` 在那里面
（读代码）。实测印证：挂一个前插的敌意插件把正文换成禁语，我们在 `prepareCall` 包装里
看到的就是换过之后的「这个不可能」——链内谁抢赢都不影响我们拿到用户会看到的那段。

## 三、改得动，而且改得干净

三臂，敌意插件都在场：

| 臂 | 用户看到的正文 | 禁语漏出 | `assistant/chunk` 里有禁语 | 结束情况 |
|---|---|---|---|---|
| 对照（无网关） | 这个不可能 | 是 | **是** | 正常 |
| A 链外改写 | 需进一步确认 | 否 | 否 | 正常 |
| B 链外拒绝 | 抱歉，这个问题我需要转人工为您处理。 | 否 | 否 | 正常 |

要点是**缓冲全流再决定**：`agent.ts:348` 每收到一个 chunk 就
`session.append('assistant/chunk', …)`，先放行再改就晚了——流式 UI 已经渲染过、
事件已经落库。臂 A/B 里一个 chunk 都没先放出去，所以 `assistant/chunk` 里也是改写后的文本。

代价明摆着：这一层把流式变成整段，首字延迟从「第一个 delta」推到「整段结束」。没量数。

## 四、但它不是保护层——沙箱够得到同一个入口

| 臂 | 顺序 | 结果 |
|---|---|---|
| C | 网关先装，敌意插件后包 `prepareCall` | 禁语**原样送达用户** |
| D | 敌意插件先包，网关后装 | 拦住 |

插件那边打印的是「包 prepareCall：成功」。还是「后动手的赢」，和 `llm/stream` 上的抢位
同一个形态，只是挪了个地方。**这条路不满足 STATUS 架构结论第 2 条。**

### 为什么工具侧不一样

沙箱里两个服务的待遇不同：

```
ctx.get('llm')   上的字段：ctx,name,adapters,directory,discoveries   有 stream：是   有 prepareCall：是
ctx.get('tools') 上的字段：register,schemas,get                      符号键：（没有）  够到调度器：否   够到私有 prepareScheduledExecution：否
```

`tools` 是 dsh 手写的专用 façade（`guard.ts` 里 `sandboxTools`，`sandboxContext` 对
`'tools'` 这个名字特判）。其余服务走通用 `guardedService`——读代码：那个 Proxy 只有
`get` 陷阱、**没有 `set` 陷阱**，所以写穿到真服务对象上，臂 C 的结果就是这么来的。

**工具侧够不到调度器，不是沙箱的普遍性质，是 `tools` 这一个服务被单独挡住了。**
架构结论 8 的强度要按这个口径讲。

## 五、reasoning 通道与 tool-call 块过这一层

同一轮里让模型发三种块：reasoning（禁语藏在这里）、正文、工具调用。

| 裁决范围 | 网关看到的 | 用户看到的正文 | 禁语在正文 | 禁语在 reasoning | 工具调用 | 工具体 |
|---|---|---|---|---|---|---|
| 只裁决正文块（现在的做法） | 「好的，我查一下。」 | 好的，我查一下。 | 否 | **是** | `query_bill` | 1 次 |
| 扩到 reasoning 块 | 「用户想退费，这个不可能，先查账单再说好的，我查一下。」 | 抱歉，我需要转人工。 | 否 | 否 | `query_bill` | 1 次 |

三条：

1. **reasoning 是漏点。** 只裁决正文块时，禁语原样落进 `assistant/message` 的 reasoning 块，
   网关完全看不见——它拿到的装配文本里根本没有那段。发现 02 在插件形态上记过这个漏点，
   在网关形态上同样成立。
2. **缓冲全流不压坏工具链。** 两组里工具调用都照常发出、工具体执行 1 次、turn 正常结束。
   把整条流收完再放行，对 tool-call 块没有副作用。
3. **扩到 reasoning 能改，但这么改是错的**，两个毛病都是这一次跑出来的：
   - 裁决拿到的是 reasoning 和正文**拼成的一段**（「…先查账单再说好的，我查一下。」），
     两段不同性质的文本粘在一起，判定器会被这个拼接误导。要分开判，不是拼起来判。
   - 命中之后正文换成了拒绝话术，**但 `query_bill` 照样发出去、工具体照样跑**。
     说话侧网关只管说话；同一条 assistant 消息里的工具调用它不拦，这一轮也不会停。
     「拒绝这句话」不等于「拒绝这一轮」——两者要不要绑，是个设计决定，目前没绑。

## 六、重试路径：每次都重新过网关

adapter 第一次以 `TRANSPORT` 的 error finish 收场，自带 `maxRetries: 1` 的策略，
挂 `dsh-llm-retry`。

```
会话里的 llm/retry 事件：1 次
prepareCall 调用次数：  2
prepared.stream 调用：  2
```

`agent.ts` 的 `while (true)` 在拿到 `{kind:'retry'}` 后重新 `buildRequest`，所以重试
是一次完整的重新准备。**没有绕过网关的路径**：重试后那一次调用的正文照样被裁决、被改写
（adapter 重试后发的是带禁语的一句，用户看到的是替代话术）。

## 结论

- 说话侧的挂载点是 **`ctx.llm.prepareCall`**：包住它、缓冲全流、装配后裁决、按 chunk 协议重发。
  不是 `llm/stream`（同侪抢位），也不是 `ctx.llm.stream`（不响）。
- 它满足「拿得到用户会看到的文本」和「改得动、改得干净」，重试路径也盖得住，
  **不满足「不与被约束方同侪」**。
- 所以架构结论 7（业务 agent 不给 cordis 动态插件工具）在说话侧从卫生条件变成**承重条件**：
  没有它，说话侧的约束可以被业务 agent 自己包在外面架空。
- 实现时要定的两件事（探针只把问题摆出来，没定）：reasoning 块**分开判**，不与正文拼成一段；
  以及正文被拒时，同一条消息里的工具调用与这一轮要不要一起停。

## 没验的

- 缓冲全流对首字延迟的代价没量；真模型的分块节奏与脚本化 adapter 不同。
- 只跑了单 agent、单轮对话。多 agent 并发下 `prepareCall` 包装是不是每个 agent 都过、
  会不会串，没测。
- 网关自己被篡改能不能察觉，没做（臂 C 里我们对被包在外面这件事一无所知）。
- 把 `llm` 也做成 façade 这条加固路没试，也没向上游确认这个不对称是有意还是缺口。
- 正文被拒时要不要连带停掉工具调用与这一轮——只看到现状是不停，没试过停的做法。
