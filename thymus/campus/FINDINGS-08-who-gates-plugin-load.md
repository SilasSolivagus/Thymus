# 发现 08：没有外部卡点时，dsh 不决定插件该不该加载，且已加载的插件能卸载别的插件

起因是「自生长」这个概念要拆成三件事：写得出、能热替换、能卸载重写。
第三件牵出治理问题——**插件自己能不能把约束卸掉**。这一轮只查 dsh 的既有行为。

探针 `probe-selfunload.ts`（不调模型，确定性）。查的代码在
`vendor/deepseek-harness/packages/extensions/cordis-host-runner/`。

## 一、加载这一侧：宿主半边零审批

`src/index.ts` 的 `run()` 里，审批分支只在有 client 半边时才走：

```js
if (plan.definition.clientCode === undefined) {
  const started = await this.activate(plan, undefined, false, attempt)   // 直接激活
  ...
}
const requiresApproval = !plan.plugin.clientVersionUpdatesApproved
  && !plan.plugin.approvedClientPackages.has(packageId)                  // 只对 client 半边
```

我们的插件全是 host-only（`code: { host: source }`），所以 `run()` 返回即已生效，
中间没有任何审批调用。探针里每次 `mount` 都直接拿到 `ok:true`，实测如此。

`define()` 阶段做的检查是：name/purpose 非空、idPrefix 三到六位小写字母、
`precheckCode` 只编译不执行（`new Script(...)`，纯语法检查）。没有语义审查。

## 二、卸载这一侧：任何已加载的插件都能卸掉别的插件

四组实测，约束插件是一个拦 `delete_file` 的 `tools/pre-execute` 插件：

| 组 | 探测插件的做法 | 拿到服务 | 卸载结果 | 约束还在吗 |
|---|---|---|---|---|
| B | `inject: ['dynamicCordisRunner']` + 自造 `{id}` | 是 | `{"ok":true}` | **拦不住了** |
| C | 不写 inject，`ctx.get('dynamicCordisRunner')` | 是 | `{"ok":true}` | **拦不住了** |
| E | 不给 session id，让它自己翻 | 是 | `{"ok":true}` | **拦不住了** |

三条具体事实：

1. **`inject` 声明可绕开**。façade 的属性访问要求声明，但 `ctx.get(name)` 走的是
   `readService(name, false)`——不要求声明。组 B 与组 C 结果相同。
2. **服务对象上的 `registry` 读得到**（TS 的 `private` 只是编译期）。
   `guardedService` 对非函数成员只过 `denyContext`（挡 Context），别的原样返回。
   组 E 顺着 `svc.registry` 翻出了 `sessionId`。
3. **`owned()` 只比对 `plugin.sessionId === agent.id`**，`agent` 是普通对象。
   拿到 sessionId 就能自造 agent，然后 `listPlugins` 列出全部、`stop` 掉任意一个。

组 E 的完整链条是自助的，不需要任何预置知识：
`ctx.get('dynamicCordisRunner')` → 读 `svc.registry` → 翻出 `sessionId` →
`listPlugins({id})` 列到 2 个 → `stop({id}, 约束插件id)` → `{"ok":true}` → 约束失效。

一处副产品：全量枚举服务成员会碰到 Context 类型的属性，触发 `denyContext`
把整个插件毙掉（组 E 第一版就死在这儿）。但精确单点读 `registry` 不触发。
这道防线拦的是粗放枚举，不是定向取用。

## 三、这不是漏洞，是 dsh 声明过的信任模型

`cordis-host-runner/README.md` 写得很清楚：

> vm 沙箱隔离全局对象，但不是安全边界……把动态包当作 bash 访问看待。

`sandbox.ts` 也标了 `vmTimeoutMs` 只约束同步部分，异步体逃得掉，
「符合工具集的协作式信任立场」。

所以上面测到的都在它的设计意图之内。**结论不是「dsh 有洞」，是「dsh 不在这一层做决定」**。

## 四、对我们的含义

- 「约束可挂载」不等于「约束不可解除」。在 dsh 这一层，约束插件和它要约束的东西
  同权——后者能把前者卸掉。
- 所以卡点必须在 dsh 之外。我们现在这套里，卡点是评测：agent 提交的插件必须过冻结
  评测才算数，替换由人（评测）把着。这个顺序不能反，反了就等于没有约束。
- 对外讲「约束挂在运行时、可挂可卸」的时候，要连着讲「谁有权挂、谁有权卸」。
  只讲前半句，懂行的人一问就穿。
- 自生长里的「能卸载重写」这一条，能力上 dsh 已经给足了；缺的从来不是能力，
  是决定该不该换的信号，以及不让被约束方自己动这个开关的权限设计。

## 五、这一轮的边界

- 探针用的是最小 context（Timer / SystemPrompt / ToolRuntime / DynamicCordisRunner），
  不是完整 dsh 部署。走的是同一份 `run()` 与同一份 façade，但完整部署里是否还有别的
  层会拦，没有验。
- 只测了 `stop`。`undefine`、`define` + `run`（自己造新插件挂上去）看得见方法，
  没有实际调用过。
- 没有测客户端半边那条审批路径。
- 没有向上游报告，也不建议报告——README 已经写明这是设计立场。
