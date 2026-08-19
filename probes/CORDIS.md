# 关于 cordis：我们要研究的不是 cordiverse/cordis

依据：`vendor/deepseek-harness/vendor/README.md` @ `99f6f02`。

## 一句话

**dsh 跑的不是上游 cordis。** 是一份带 18 条本地修改的硬分叉，而其中几条恰好是 Thymus 整个设计的承重墙。

## 事实

dsh 把整个框架层源码级 vendor 进自己仓库（`vendor/`），不走 npm 依赖。理由写得很明白：让 harness 完全拥有框架层——可审计、可打补丁、可钉版本。

全部改名进 `@deepseek-ai` scope。

| 目录 | 上游名 | 上游版本 | 上游仓库 |
|---|---|---|---|
| `cordis/` | `cordis` | 4.0.0-rc.7 | **cordiverse/cordis** (`packages/core`) |
| `loader/` | `@cordisjs/plugin-loader` | 1.0.0-rc.5 | cordiverse/cordis |
| `include/` `group/` `timer/` `hmr/` `logger-console/` | `@cordisjs/plugin-*` | 各异 | **deepseek-harness/cordis**（他们自己的 fork 组织） |
| `cosmokit/` `schemastery/` | 同名 | | deepseek-harness/* |

注意：只有 **cordis 核心**直接取自 cordiverse。其余插件已经走的是 deepseek 自己的 fork。

## 关键：18 条本地修改

`vendor/AGENTS.md` 立了规矩：**不许随便改 `vendor/*/src/`，每一条与上游的偏离都必须穷尽记录**。目前记了 18 条。

其中直接砸在 Thymus 承重墙上的是第 6 条：

> **`cordis/src/fiber.ts` lifecycle hardening**：本地修补了三处**重入式卸载**的漏洞。

具体补了什么（原文摘要）：

- effect 的属主包装在 setup 跑之前就登记，所以从 setup 内部发起的卸载会等 setup 及其收集到的所有 cleanup 完成
- 同步 setup 失败会移除包装并回滚已收集的 cleanup
- 异步 cleanup 在达到静默前对属主保持可见
- 属主处于 `UNLOADING` 状态时拒绝新建 effect，防止 cleanup 期间登记的东西逃出卸载快照
- 子 fiber 在 `internal/plugin` 发布前就拿到父方持有的 disposer
- 重入卸载使加载纪元失效时跳过插件执行
- teardown 通知失败按观察者隔离，一个回调不能拖垮其他的

**翻译成人话：上游 cordis 的「卸载」在重入场景下有洞，dsh 自己补的。**

而 Thymus 的两处设计直接站在这块地板上：

- 4 节生命周期：全部状态迁移都要求卸载干净
- 5.3 消融装置：「卸载可逆」是三大前提之一

所以：**只研究 cordiverse/cordis 会得到偏乐观的结论**——上游那份的 disposal 语义比 dsh 实际跑的这份弱。

其他值得注意的条目：

- 第 15 条：回移了上游 PR [cordiverse/cordis#41](https://github.com/cordiverse/cordis/pull/41)（Loader 惰性配置解析）。说明他们跟上游有互动，不是单向脱离。
- 第 8、12 条：Loader / Include 的事务化重挂与串行化，含一个「退出码 13、无任何诊断」的死锁修复。这些是热重挂的可靠性基础。

## 怎么读

**读 `vendor/deepseek-harness/vendor/cordis/src/`，不要读 GitHub 上的 cordiverse/cordis。** 前者才是实际跑的那份。

好消息：**核心只有 2693 行**（`cordis/src/*.ts` 合计）。一天能读完。

配套读法：

1. 先读 `vendor/README.md` 的 18 条本地修改 —— 它就是一份现成的「上游 vs 实际」差异清单，而且是上游团队自己写的
2. 再读 `cordis/src/fiber.ts` —— 生命周期、effect、卸载全在这儿，也是被改得最多的文件
3. 再读 `packages/core/scope/` —— 不是 cordis 的，是 dsh 在 cordis 之上加的作用域层。**探针 G 那个坑就在这一层**，Thymus 要动的多半也是这一层

## 对 Thymus 的三点意义

**一、版本风险比原以为的高一层。** 不只是 dsh 会变，它脚下的框架层也在被它自己持续打补丁。原文档只钉了 dsh 的版本（rc.7），没钉框架层。建议把 `vendor/README.md` 的 18 条也纳入复核范围。

**二、打补丁是这个项目认可的做法。** 上游自己就在 vendor 里改 cordis，还立了「必须穷尽记录」的规矩。所以 Thymus 要修那个作用域隔离的坑，不必绕着走——照他们的规矩改、记账，是符合这个仓库习惯的做法。

**三、真正该动的层次可能更低。** 隔离问题的根在 `cordis-host-runner` 挂载点选了 rootCtx，但修法要用 `dsh-scope` 的 `createScope`。这两个都在 dsh 里，不在 cordis 里。**cordis 本身可能不需要改** —— 这对可维护性是好消息。
