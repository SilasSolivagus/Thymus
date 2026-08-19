# DESIGN.md 第 2 节照代码复核

依据：`vendor/deepseek-harness` @ `99f6f02`（0.1.0-rc.7）。复核日 2026-08-19。

原文档自己写了「第 2 节的全部事实需在实现前复核」。这就是那次复核。

---

## 一、错的（4 条）

### 1. 工具是 7 个，不是 5 个

2.1 的表列了 `cordis_inspect` / `define` / `run` / `stop` / `undefine`。

实际（`tool-cordis/src/index.ts`）：

| 工具 | 行 |
|---|---|
| `cordis_inspect_list` | 42 |
| `cordis_inspect_query` | 61 |
| `cordis_inspect_self` | 97 |
| `cordis_define` | 149 |
| `cordis_run` | 241 |
| `cordis_stop` | 330 |
| `cordis_undefine` | 352 |

`cordis_inspect` 已拆成三个：列 Provider、查具体契约、查本会话自己的插件。

注意上游自己的 `tool-cordis/README.md` 也还写着 5 个 —— **原文档是照 README 写的，不是照代码写的**。

### 2. 铸号不是 `dyn-<n>`

`cordis-host-runner/src/registry.ts:154`：

```
mintPluginId(prefix) → `${prefix}-${n}`
mintPackageId()      → `pkg-${n}`
mintPluginRunId()    → `run-${n}`
```

`prefix` 是模型自己提的 3–6 位小写语义前缀，宿主只负责配号。所以实际长这样：`probe-1` / `thymus-2`。不存在 `dyn-` 这个前缀。

### 3. `recompose()` 不能为「存活 agent」更换 preset

2.3 原文：「`recompose()` 可为存活 agent 更换 preset」。

`agent-presets/README.md:148` 写在**局限**章节里：

> A preset cannot be changed once a session has produced anything —— `recompose` 只重挂 **空白** 会话的父作用域，只限空白。换掉一个已经跑过的组装，会让模型已经调用过的工具悬空。

`scope/README.md` 用词是 “the blank-session recompose contract”，中文版直接叫「仅空白可切」。

**影响面**：3.3 节「成长表现为换装而非累加」。会话中途换装这条路，通过 preset 是走不通的。要么在会话开始前定装，要么另找机制。

### 4. 「能力集可按单个 agent 隔离」对动态包不成立

2.3 原文把这条当作 5.3 消融装置的三大前提之一。

对**静态 scoped 插件**成立，对**动态包**不成立。已由探针 G 实证，机制现在能定位到两行：

- `scope/README.md`：`scopeTarget` 把带标签的事件路由给同 key 的监听器，**未打标签的监听器保持全局**（原文：untagged listener ⇒ admitted）。
- `cordis-host-runner/src/index.ts:1238`：`this.rootCtx.plugin({ name: 'cordis-dynamic', ... })` —— 动态包统一挂在**根上下文**下。

根上下文没有 scope 标签 → 动态包的 `ctx.on` 是未打标签的监听器 → 对每一个 agent 都放行。

**修复路径是现成的**：`createScope(ctx, key, { parent })` 就在 `dsh-scope` 里。把 `cordis-dynamic` group 挂到发起会话的 agent scope 下而不是根下，隔离即成立。这是一个可以本地打补丁、也可以向上游提的具体改动，对应原文档待决问题 5。

---

## 二、要加限定的（4 条）

### 5. 全文检索需要另挂后端

2.2 写「`session-query` + SQLite 全文检索」。

`session-query/README.md:26` 明说基础包**不是**全文检索：调用方文本被转义成正则做字面扫描，“a literal semantic-text scan, not a full-text query”。全文方法是抽象的，需要具体后端；第一个实现是 `session-query-sqlite`（独立包）。

基础包没有 provider 协调器，没有兜底实现。也就是说：不挂 `session-query-sqlite`，就没有全文检索。

### 6. 「契约可见」属实，但有裁剪规则

2.1 第 2 点属实，且比原文更强：AST 生成、`verify-cordis-api` 卡新鲜度都对。

要补的是裁剪规则——目录**只渲染「可调用且可注入」的键**。非方法成员、symbol 键成员、够不着的 ctx 键，都不会出现在模型看到的报告里。

这不是遗漏，是刻意的：给模型看一个它调不到的东西，等于教它走死路。对 Thymus 有直接意义——**模型的能力上界由这份目录定义，不由运行时定义**。

### 7. 「扩展位 `cordis/mount`」—— 代码里确实没有

全仓搜不到 `cordis/mount` 这个事件。与原文说法一致（原文说的是「remains addable」，不是「已有」），不算错。

记在这里是为了备查：要做档案与复现率统计，这个事件目前得自己加。

### 8. 「工具集变更记为完整的 changed request header」—— 未找到支撑

`agent-loop/README.md:34` 提到 invariant companion 会从日志独立重建 “message boundary and folded request header”，但没有一处把**工具集变更**与 header 关联起来。

这条降级为存疑。要么另找依据，要么改写。

---

## 三、核对属实的（逐条）

| 条目 | 依据 |
|---|---|
| `extensions/` 标题「the agent modifies its own runtime」 | `packages/extensions/README.md:1` 逐字一致 |
| `node:vm` 沙箱 | `cordis-host-runner/src/sandbox.ts:14` |
| 动态包挂在 `cordis-dynamic` group 下 | `index.ts:1238` |
| 卸载至完全静默 | `lifecycle.ts` —— 且比原文简单：不需要专门 helper，普通 `await fiber.dispose()` 即可，因为插件注册的一切都是它 fiber 上的 effect |
| 2.2 全部包存在 | `session-query` / `llm/token-meter` / `session/session-telemetry{,-otel}` / `session/session-stats` / `session-query/tool-session-query` / `goal` |
| 「model-visible ⟺ logged」是真规则 | `agent-presets/src/session.ts:9` 称其为 repo 级规则 |
| effect 可逆 | 探针 B / F 实证 |
| 作用域链 agent → preset → global，近者遮蔽远者 | `scope/README.md`：注册视图**向下**继承，近者遮蔽远者。注意事件准入方向**相反**（向上），两者不是一回事 |
| agent-presets discovery 不做记忆化 | `agent-presets/README.md:11` 逐字一致 |
| 2.4 三条原文 | 全部仍在，位置：`tool-cordis/README.md:19`（固化落盘）、`tool-ralph/README.md:47`（worker reports）、`tool-cordis/README.md:23` + `cordis-host-runner/README.md:32`（安全边界） |
| resume 不重建动态包 | `tool-cordis/README.md:19` “do not survive restart” |
| waterfall 未调 `next()` 会短路 | 探针 A / C 实证 |
| turn 内死锁 | `tool-cordis/src/prompt.ts:104` |
| README 必须含 Token/KV Cache effect 两节（3.3） | `package.json:77` 有 `verify-package-readme-model-experience` 卡口 |

---

## 四、复核中发现的一个陷阱

`tool-cordis/README.md:19` 结尾：

> Every verb is session-scoped: a package is visible and controllable only in the session that defined it.

单读这句极易理解成「动态包按会话隔离」。**它说的是「动作」按会话隔离**——你只能看见和操作自己会话定义的包。

**包的运行时效果不隔离。** 这两件事在同一段话里，一句挨着一句，但意思完全相反。探针 G 就是撞在这个缝上。

写实现的时候要盯住这个区分。
