# 发现 18：B 类（认人前置）的状态——不用自己存，但接口和时序都要改

探针 `probe-b-state.ts`（脚本化 adapter，不花钱）。A 类和 C 类都是无状态的：
拿到这一句话、这一次调用就能判。B 类要知道**这个会话之前发生过什么**，所以先问三件事：
网关拿得到什么身份、状态从哪来、多 agent 会不会串。

## 一、身份：两条通道拿到的东西不一样

```
工具侧 prepare 看到的：      verify_identity@b-id · query_bill@b-id
说话侧 prepareCall 的 config：provider,model
说话侧 stream 的 sessionId：  b-id
```

- **工具侧有**。`ToolExecutionInput.agent` 在调度器路径上是填好的，`agent.id` 就是
  sessionId，并且顺着 `agent.session.events` 拿得到整条会话日志。
- **说话侧分两层**：`prepareCall(config)` 只拿得到 `provider` 和 `model`，**没有身份**；
  sessionId 在 `stream(options)` 上。`installSayGate` 的裁决恰好发生在 `stream` 里，
  所以按会话记事是可行的——但要记住身份不能在 `prepareCall` 那一层取。

**这一条直接影响 Thymus 的接口**：`Constraint.preTool` 现在只收 `{ name, arguments }`，
拿不到调用方是谁。B 类落地必须把调用方身份传下去（sessionId，或整个 agent）。
A/C 两类不需要它，所以这个字段之前没人要过。

## 二、状态不用自己存，从会话事件现读就够

「本会话有没有成功做过身份核验」可以从会话日志重建：

```
tool/call   {turn,step,callId,name,arguments}                      ← 名字在这里
tool/result {turn,step,message:{content:[{type:'tool-result',
             toolCallId, isError, content:[{type:'text',text}]}]}}  ← 成败在这里
```

名字只在 `tool/call` 上，成败只在 `tool/result` 的结果块上，**两者按 callId 对上**
才知道哪个工具成功了。这样 B 类约束仍然是一个纯函数：输入是会话日志，输出是判决。
不用自己维护一份状态，也就没有「自己那份和会话不一致」这种漂移。

| 剧本 | 账单调用 |
|---|---|
| 先认人，下一轮再查 | 放行 |
| 不认人直接查 | **拒绝** |

## 三、时序是有坑的：并发派发时事实还没落库

同一条 assistant 消息里一起发 `verify_identity` 和 `query_bill` 两个调用：

| 工具的并发声明 | 账单调用 |
|---|---|
| 默认（exclusive） | 放行 |
| 声明 `isConcurrencySafe` | **拒绝** |

默认模式下一次只跑一个、跑完再下一个，所以轮到账单 `prepare` 时核验的 `tool/result`
已经落库，事实看得见。声明了并发安全之后 dispatch 重叠，账单的 `prepare` 跑在核验
`finalize` 之前，日志里还没有那条事实。

方向是对的（**看不见就不放行**，fail-closed），但代价要认：一个老老实实把两个调用
批在一起发的 agent 会被拒。这不是 bug，是「按已落库的事实判」这条路的固有性质——
要么接受这个代价，要么把 B 类的事实来源换成飞行中的状态（那就得自己存，回到漂移问题）。

## 四、多 agent 并发不串

一个宿主两个 agent，A 认过人、B 没有，同时跑：

```
工具侧看到的调用顺序：verify_identity@b-a · query_bill@b-b · query_bill@b-a
A（先认人再查）被拒：false
B（直接查）被拒：    true
```

顺序里 B 的调用确实插在 A 两次调用中间——是真交错，不是被串行化掩盖的。
按 `exec.agent` 取会话、各读各的日志，判决互不干扰。

## 又一次「两个错互相掩盖」

第一版读事件形状是想当然写的（以为 `tool/result` 上直接有 `callId` 和 `isError`），
于是 `verifiedFromEvents` 全程返回 false；而「拒绝有没有生效」的检测**读错了同一处**，
于是全程返回 false。两个错叠在一起，屏幕上看到的是「三种剧本都一切照常」——
一个非常像样的、完全错误的结论。把真实事件 dump 出来才对上（探针里 `DUMP=1` 留着）。

STATUS 方法论第 1 条（实测不等于测对了，要验中间态）的又一例。这次的教训更具体：
**读会话事件的形状不要凭印象写，先 dump 一条真的出来。**

## 结论

- B 类可以做成无状态判定：输入 `agent.session.events`，输出判决。不用额外存储。
- 但 `Constraint.preTool` 的入参要加调用方身份，否则约束根本够不到会话。
- 「按已落库的事实判」在并发派发下会拒掉合法的批量调用。这是取舍，不是缺陷，
  要写进 B 类的文档里。
- 多 agent 不串。

## 没验的

- 跨进程重启：会话日志是持久的，所以事实还在；但没实跑 resume 后再判一次。
- 压缩（compaction）之后 `tool/call` / `tool/result` 还在不在——如果被压掉，
  「现读事实」会变成「忘了认过人」。这是这条路最可能出问题的地方，没测。
- 只测了「做过某个成功的工具调用」这一种事实。「用户在对话里说了手机号」这类
  要从正文里判的事实没测。
- 没测过约束自己想记状态（写一份自己的），因此也没量两种做法的差别。
