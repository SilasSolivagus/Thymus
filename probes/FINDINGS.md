# Spike 结论：哪一层做得出来

| 项 | 值 |
|---|---|
| dsh 版本 | 0.1.0-rc.7，`99f6f02`（fork 与上游 tag 完全一致） |
| 探针 | 8 个，全过；`probes/run.sh` 可复现 |
| 性质 | 一次性探针，非保留代码 |

## 结论

| # | 问题 | 答案 | 依据 |
|---|---|---|---|
| 1 | Policy 层可达？ | **是** | 探针 A/B/C |
| 2 | Loop 层可达？ | **是** | 探针 D/E/F |
| 3 | 按 agent 消融可行？ | **否，前提不成立** | 探针 G |

### 1. Policy 层成立

`cordis-host-runner/src/guard.ts:636` 的沙箱 façade 白名单含 `on`/`once`，且**没有事件名白名单**。运行时写出的动态包可挂任意 waterfall。

- **探针 A**：动态包挂 `tools/pre-execute`，返回 `{kind:'deny'}`，真的拦住了工具调用。自带阴性对照——挂载前两个工具都正常，挂载后只有被点名的那个变成 `Error: thymus policy veto`。
- **探针 B**：`runner.stop()` 后拦截器干净 unwind，工具恢复。DESIGN.md 2.3 的「effect 可逆」为真。

### 2. Loop 层成立

参照系是 dsh 自己的 `packages/core/agent-loop/tests/interception.spec.ts:234`，那里由宿主侧静态代码挂 `agent/pre-step` 并 reject。探针把同一件事换成沙箱里的动态包，真实 agent loop 一视同仁。

- **探针 D**：动态包否决 step 准入，模型一次都没被调用，`step/start` 不产生。
- **探针 E**：动态包能改写喂给模型的 messages（注入的字符串出现在 adapter 收到的请求里）。
- **探针 F**：停掉后准入恢复。
- **变异测试**：把否决改成 `next()` 放行后，D 与 F 如期失败。探针在鉴别，不是空转。

### 3. 按 agent 消融的前提不成立 —— 本次最重要的发现

**探针 G**：在 session A 定义并挂载的 Policy，把从未定义过任何动态包的 session B 一起挡住了。对照组（不挂任何动态包）证明两个 session 本来都能正常跑到模型。

动态包的 `ctx.on` 注册的是**根级监听器**，不是 agent-scoped。

这不是 bug，README 已写明 "may affect other sessions in that process"。但它推翻的是 DESIGN.md 的两处：

- **2.3 节**「能力集可按单个 agent 隔离」——对静态 scoped 插件为真，对动态包的事件监听器为假。
- **5.3 节**整套贡献度分配，其技术前提是「卸载可逆 + 轨迹可重放 + 能力集按 agent 隔离」三者叠加。第三项对 Policy/Loop 层器官不成立，因此**反事实消融不能在同进程内并行做**，只能串行独占，或每次消融起独立进程。

5.3 节称此为「本项目相对同类方案的结构性优势」。该优势在 Tool 层成立，在 Policy/Loop 层需要额外机制才成立，而项目重心恰在后两层。

### 4. 附带发现：Agent 能锁死自己的逃生口

**探针 C**：一个无条件 deny 的 Policy 会连 `cordis_stop` 一起拦下——Agent 卸载动态包的唯一手段本身也是工具，同样过 `tools/pre-execute`。宿主侧直接调 `runner.stop()` 不经过工具分发，仍然有效。

对 DESIGN.md 4 节的影响：`Purged` 状态的执行路径不能依赖 Agent 自己调工具，必须是带外的宿主侧通道。

## 复现

```bash
./probes/run.sh
```

脚本把探针临时拷进 dsh workspace（它们依赖 dsh 自己的 `tests/helpers.ts` 与 `mock-adapter.ts`），跑完撤走，`vendor/deepseek-harness` 始终停在 rc.7 干净状态。

## 环境备忘

- dsh 要求 pnpm 11.7.0，用 `corepack pnpm`。
- 装依赖须带 `CI=true`：根目录 `postinstall` 的 lefthook 安装在 submodule 里会因 `core.worktree` 与 `extensions.worktreeConfig` 冲突而失败，`CI=true` 是脚本自带的跳过口，git hook 对 vendored 副本无意义。
- vitest 的 include 模式相对仓库根，必须在 `vendor/deepseek-harness` 根目录跑并给全路径。
