# Spike 结论：逃逸边界实测

不再嘴上说「上游说不是安全边界」，而是实测我们这个配置下逃逸能走到哪。
依据 dsh `99f6f02`（0.1.0-rc.7）。`./probes/run-ladder.sh` 可复现。

## 一句话

**沙箱逃逸是真的**（能从 vm 够到宿主 `process`），**但升级后的器官逃逸也够不着**
（运行时没挂在宿主全局上）。两条都是实测，不是推断。

## 逃逸能不能出沙箱：能

| 路径 | 手段 | 结果 |
|---|---|---|
| 1 | `btoa.constructor`（btoa 是真实宿主函数）→ 宿主 `Function` → `process` | **逃逸成功**，拿到 `process.pid` |
| 2 | `harness.defineTool.constructor` 同法 | **逃逸成功** |
| 4 | `new TextEncoder().constructor.constructor` | **逃逸成功**，`typeof process === 'object'` |
| 3 | 直接 `require` | 失败——`require` 在宿主是模块局部变量，全局够不到 |
| 5 | `process.mainModule.require` | vitest 下 `mainModule` 为空（测试运行器未设，不代表生产） |
| 6 | `module._load` 爬取 | 同上，链路在 vitest 环境断裂 |

结论：**凡是暴露给沙箱的真实宿主函数，其 `.constructor` 都是通往宿主 `Function` 的梯子。**
一旦够到宿主 `Function` 就是图灵完全。`btoa`/`atob`/`TextEncoder`/`harness.*` 全是这样的梯子。

这与上游注释逐字一致：*host-realm helper functions remain an escape route* / *is not containment*。
现在这句话对我们这个配置是实测事实，不是引述。

## 逃逸能不能拆掉升级后的器官：够不着（有鉴别力的阴性）

真正对 Thymus 要命的不是通用 RCE，是「agent 逃出沙箱后，能不能卸掉一个它工具够不着的 L2 器官」。

**路径 7**：立一个宿主侧直接挂的器官（agent 无工具指向它），再让恶意动态包逃到宿主
`globalThis`，遍历找运行时把手。

结果：`globalThis` 上可疑键 = `[]`。**运行时没有挂在宿主全局上，逃逸够到了宿主 Function，
却没有现成的把手指向 runner 或器官。器官仍然生效。**

**路径 7 对照**：人为把 runner 挂到 `globalThis.__thymus_runner_handle` 上，同样的搜索立刻
`found === true`。证明路径 7 的空结果是「dsh 没把 runtime 暴露在全局」，不是「我的搜索失效」。
这是有鉴别力的阴性结果，不是没测出来。

## 诚实的边界

**已证实**：
- 出沙箱到宿主 `process` / `Function`：能，多条路径。
- 从宿主全局找到并卸载升级后的器官：够不着，运行时不在全局。

**未证实（不主张）**：
- 够到宿主 `Function` 后，通过更深的爬取（遍历模块缓存、原型链穷举、闭包捕获）
  最终定位到 runner——路径 7 只证明「顺手够不到」，不证明「绝对够不到」。图灵完全意味着
  上界只能靠「把手不存在」保证，而 vm 逃逸后这个保证本身是软的。
- 生产环境（非 vitest）下 `mainModule` 链路是否打通——很可能打通，因此 RCE 上限应按「能」对待。

## 对定位的结论

之前想写「Thymus 是可靠性控制，不是安全控制」。实测之后，这句话要按路径分，不按意图分：

| 边界 | 实测结论 |
|---|---|
| 经工具通道的行为（忘、漂、图省事、被注入） | Thymus 拦得住——都过 `tools/pre-execute`，动机不进入判断 |
| 升级后 agent 用工具卸载自己的器官 | 拦得住——工具够不着（作用域阶梯，已实测） |
| 沙箱逃逸后从宿主侧卸载器官 | **拦不住的下界不明**——逃逸成功，把手顺手够不到，但图灵完全下无法证明够不到 |

所以准确表述是：**Thymus 对「经由工具通道的不可靠行为」是真控制，且升级即交权这条经作用域实测成立；
它不构成对沙箱逃逸的防护——逃逸本身已实测可行，逃逸后能否拆掉器官取决于运行时把手的可达性，
本项目只证明了顺手够不到，未证明绝对够不到。**

要把最后这条从「软」变「硬」，得让运行时对沙箱逃逸后的宿主域也不可达——那需要进程级隔离，
正是调研里 unfireable safety kernel 那派的主张，属于另一个范围。

## 复现

```bash
./probes/run-ladder.sh   # 含 8 个逃逸探针
```
