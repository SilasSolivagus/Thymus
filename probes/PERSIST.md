# Spike 结论：落盘可行，但「转正」还不是一条路

依据 dsh `99f6f02`（0.1.0-rc.7）。`./probes/run.sh` 可复现。

## 结论

| 问题 | 答案 |
|---|---|
| 沙箱源码能不能机械转成磁盘上的正式插件 | **能**，对自足的器官 |
| 全新进程能不能只凭磁盘配置捡起来 | **能** |
| 从磁盘加载的器官是不是天然在全局层 | **是** |
| 是不是所有动态包都能这么转 | **不是**，见探针 N |
| 有没有一条自动转正的路 | **没有**，全程是我手工做的 |

## 转正的形态比预想的简单

正式插件就是一个导出 `name` 与 `apply(ctx)` 的模块，加 `cordis.yml` 里一行：

```yaml
- id: thymus-organ
  name: ./organ.mjs
```

而沙箱源码是「一段函数体，返回一个 plugin 对象」。两者之间的转换是机械的：

```js
const __plugin = (function () { <沙箱源码原样> })()
export const name = __plugin.name
export const apply = __plugin.apply
export const inject = __plugin.inject
```

**探针 L** 验证这个转换忠实：同一段器官源码，走沙箱与走生成文件，两条路的输出逐字相同（断言是拿沙箱的实际输出去比对生成文件的输出，不是各自对一个写死的期望值）。

## 重启后仍在

**探针 M** 用 `boot(binName, configPath)` 从磁盘的 `cordis.yml` 起了一棵全新的树——内存里什么都没有，器官只能来自配置里那一行。起来之后它照常拦截。

对照组：同一棵树，配置写成空列表，器官就不在，工具正常执行。

这是「重启后仍在」的忠实模拟：新 Context、新加载、全部来源于磁盘。

## 不是所有动态包都能机械转正

**探针 N** 是个反例，而且很硬。

沙箱给模型注入了一个 `harness` 辅助对象（`harness.defineTool`、`harness.registerTool`），注册工具要靠它。这东西只存在于 vm 沙箱里，正式模块中没有。

同一段注册工具的源码，在沙箱里跑得好好的（`reverse_text` 可调用，输出正确），机械转正后加载即炸：

```
ReferenceError: harness is not defined
```

**所以转正的难度按器官类型分层：**

| 器官类型 | 机械转正 |
|---|---|
| Policy / Loop（只用 `ctx.on`） | 可以，直接包一层就行 |
| Tool（用 `harness.*` 注册工具） | 不行，需要把沙箱辅助调用改写成真实 API |

这对 Thymus 是个反直觉的结论：**项目重心在 Policy / Loop 两层（见 DESIGN.md 3.1），而恰好是这两层最容易转正。** 最难转正的 Tool 层，反而是价值最低、最可被 MCP 替代的一层。

## 最要紧的一句：这证明的是终点可达，不是有路

上面每一步——决定转正、取回源码、写文件、改 `cordis.yml`——**都是我手工做的**。

dsh 侧的现状是：源码取得回来（`cordis_inspect_self` 给定 pluginId + packageId 时返回源码），但没有任何写文件或改配置的动作，README 明写 "cannot be promoted automatically"。

所以本次验证的结论应当被读作：**落盘这个终点是可达的，机制上没有拦路虎；但从「跑通的动态包」到「磁盘上的正式插件」之间那条路，一米都还没修。**

那条路要修的东西至少包括：什么条件触发转正、转正前审查什么、文件写到哪个 profile、`cordis.yml` 怎么安全地增删一行、转正失败怎么回滚、以及降级时怎么把那一行再摘掉。

## 复现

```bash
./probes/run.sh
```
