# 发现 19：压缩不动事件日志——B 类的事实源活得下来

发现 18 把「从会话事件现读事实」定成 B 类的做法，同时把「压缩之后 `tool/call` /
`tool/result` 还在不在」列为那条路最可能出问题的地方。探针 `probe-compaction-facts.ts`
（脚本化 adapter，含压缩用的 summarize 调用，不花钱）把它打掉了。

## 结果

两臂，每臂三个时间点：跑完一轮 → 压缩/剪枝之后 → 换宿主 resume 之后。
判定用的是发现 18 那个函数：`tool/call` 的名字与 `tool/result` 的成败按 callId 对上。

| 臂 | 时间点 | tool/call | tool/result | 日志里判「认过人」 | 模型 surface 上还看得到 |
|---|---|---|---|---|---|
| A 只压缩 | 一轮跑完 | 2 | 2 | **true** | true |
| | compactNow 压掉 5 个 surface 节点后 | 2 | 2 | **true** | **false** |
| | 换宿主 resume 后 | 2 | 2 | **true** | false |
| B 压缩 + 剪枝 | 一轮跑完（自动压力路径已剪枝） | 2 | **3** | **true** | true |
| | compactNow 之后 | 2 | 3 | **true** | false |
| | 换宿主 resume 后 | 2 | 3 | **true** | false |

三条结论：

1. **压缩只动 surface，不动日志。** 压缩后 `tool/call` / `tool/result` 一条不少，
   多出来的是一条 `compaction/summary`；模型看到的消息里核验结果没了，
   但从事件日志重建事实照样成立。dsh 的文档把这三个 `compaction/*` 事件写作
   log-only，摘要靠一条带 `surfaceOp: replace` 的 `user/message` 顶上——实测对得上。
2. **剪枝是追加，不是改写。** 剪枝把 `tool/result` 从 2 条变成 3 条：原始那条留在日志里，
   剪过的那条以 `surfaceOp: replace` 盖在 surface 上。所以「按日志判事实」看到的仍是
   完整的原始结果。**注意方向**：如果哪天改成「按 surface 判」，剪枝就会开始影响判定。
3. **落盘再读回来也在。** 换一个宿主 resume，三项计数与判定全部不变。

## 顺带打到的一个操作性问题

`handle.dispose()` 之后立刻 resume，臂 B 稳定报 `session "compact-b-p8" not found`，
等 300ms 再试就成功（探针里留了这个重试并把第一次失败打出来）。臂 A 不复现。
只记现象：**dispose 与「日志在新宿主里可见」之间不是同步的**。没有去读那段实现，
也没有确认这是有意的写入可见性窗口还是缺口。B 类本身不受影响（同进程内不涉及），
但任何「关掉再马上接管」的编排要知道这件事。

## 探针里绕过的两处（不是结论，是条件）

- 自动压力路径在假 provider 上不触发：`tokenMeter` 拿不到这条路由的容量。臂 B 的剪枝
  是把 `thresholdChars` 调到 512 之后由步边界监听器自己跑的；直接调 `pruneSession`
  在 surface 已被压缩盖掉之后是 0 条，符合它只处理当前 surface 的定位。
- `compactIfNeeded` 从外面手动调会被拒（`no open turn`）——自动压缩事件必须包在一轮里。
  要单独驱动它得走 `compactNow` 或 `compactRegion`。

## 没验的

- 只验了「一次压缩」。反复压缩、摘要再被摘要之后日志是否仍然只增不减，没测。
- 没测 session 被显式清空（`session/end-seed` 那一类）之后的行为。
- 事实是「做过某个成功的工具调用」这一种。从正文里判的事实（用户在对话里报了手机号）
  会随 surface 被摘要而消失——那类事实**不能**靠现读 surface，得另想办法。没测。
