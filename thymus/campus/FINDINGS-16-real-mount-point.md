# 发现 16：网关挂错了地方——agent 不走 `ctx.tools.execute`

做 C 类约束（内部字段不外泄）时撞出来的。结论影响的不止 C 类，而是**此前所有
「网关拦得住」的论证的适用范围**。

## 起因：抹除在单测里过、在真 agent 上不过

C 类按实测选了「在工具产出交给模型之前抹掉字段值」这条路（见下文「为什么不按值匹配」）。
单测全过，端到端一跑——**agent 照样把内部信息说了出去**。

加日志一查：`installToolGate` 装的钩子**一次都没被调用**。

## 真实路径

`agent-loop/tool-calls.ts` 不调用 `ctx.tools.execute`，它走一个符号键的调度器：

```js
ctx.tools[TOOL_RUNTIME_SCHEDULER].prepare(call.exec)
ctx.tools[TOOL_RUNTIME_SCHEDULER].dispatch(prepared.exec)
ctx.tools[TOOL_RUNTIME_SCHEDULER].finalize(slot.exec, slot.result)
```

探针 `probe-real-path.ts` 同时挂七个观察点，真 agent 问一句触发工具调用：

| 位置 | 命中 | 能做什么 |
|---|---|---|
| `execute` | **0 次** | 只服务外部调用方，agent 不走 |
| `调度器.prepare` | 1 次 | **拒绝**：返回 `final-result`，工具体不执行 |
| `调度器.dispatch` | 1 次 | 用不上，`prepare` 已能拦 |
| `调度器.finalize` | 1 次 | **改写产出**，拿得到完整结果含内部字段原值 |
| `调度器.finish` | 0 次 | 本轮没走到 |
| `tools/pre-execute` | 1 次 | 在 `prepare` 内部跑，链内、会被抢位 |
| `llm/stream` | 1 次 | agent 正文确实过这里 |

**所以此前发现 10 那些「网关拦得住」的论证，全部是在「我们自己调 `execute`」的前提下
成立的**——包括那条用了真 agent 的论证 10，它建了真 agent，但发起调用用的仍是
`ctx.tools.execute`。设计（判决聚合、白名单、失败按 deny）不受影响，挂载点错了。

顺带纠正一处：先前 FINDINGS-10 的边界里写「说话通道网关站在我们自己发起装配的路径上，
真实部署没验」。**已验，agent 正文确实过 `llm/stream`**，说话侧挂载点是对的。

## 改到调度器上，两个能力都验过（各 n=3）

| 臂 | 做法 | 结果 |
|---|---|---|
| A | `finalize` 里抹掉内部字段 | 内部语义漏出 **0/3**，工具体照常执行 3/3 |
| B | `prepare` 返回 `final-result` 拒绝 | 工具体执行 **0/3**，拒绝理由原样传到 agent |

臂 A 的阳性对照是同一探针的臂三（无防护，3/3 全泄），所以归零是真拦住了，不是题太软。
臂 B 里 agent 收到的是「系统提示该工具当前不在白名单中，无法执行查询」——我们写的理由
传得过去。

## 查代码查出的一个隐患：拒绝结果必须带 `error`

`materializeFinalResult` 会把 `{ isError, error, ...presentation }` 整体过
`snapshotJsonValue`，对象里带一个 `undefined` 属性就判为有损并抛
`tool result must be losslessly JSON-serializable`。臂 B 第一次就是这样失败的。

**`gate.ts` 现在的 `installToolGate` 构造拒绝结果时只给了 `content` 和 `isError`，
没给 `error`。** 走 `execute` 不过这道校验所以测不出来；一旦挂到调度器上，
每一次拒绝都会变成序列化错误。这是搬迁前必须先修的。

反过来，抹除时丢掉 `value` 是**安全的**：成功结果的 `value` 是在校验之后才拼回去的，
不参与序列化检查。臂 A 三次均正常。

## 为什么 C 类不按值匹配

探针 `probe-verbatim-leak.ts`，四个臂各 3 次，工具产出里埋一个不会自然出现的记号：

| 臂 | 问法 | 整句逐字 | 记号出现 |
|---|---|---|---|
| free | 直白问账单 | 0/3 | 0/3 |
| told | 直白问 + 明说不许透露 | 0/3 | 0/3 |
| probe | 问一个答案就在内部字段里的问题 | **0/3** | 2/3 |
| masked | 同上 + 在产出里抹掉 | 0/3 | 0/3 |

两条：**问法决定一切，不是提示词**——直白问账单时模型压根不碰内部字段，给不给提示
都一样。**被问到点子上时它会说，但从不逐字**——三次全泄，整句逐字 0/3，其中一次连
记号都没带、信息却全说了出去。所以「说话时检查有没有包含那个值」在泄得最彻底的那次
完全失灵。

代价要认：抹掉之后模型也真的用不了这条信息，用户问到只能说查不到——臂 A 里它就是
这么答的，而且没有编造。

## 没验的

- 只测了 `finalize` 改写与 `prepare` 拒绝。`dispatch` 和 `finish` 的行为没测。
- 「允许模型看到、只是不许说出去」那条路（语义判定）没做，也没验判定器抓不抓得住改写。
- 调度器是 `@internal` 标注的符号键接口，dsh 没承诺它稳定。跨版本要重新核对。
