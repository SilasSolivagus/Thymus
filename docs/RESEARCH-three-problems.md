# 三个问题的跨行业参照

实跑（`thymus/demo/FINDINGS-self-authored.md`）撞出三个问题。按 DESIGN.md 第 6 节的做法，
去别的行业找已经解决过同一类问题的机制。

| 本项目问题 | 参照领域 | 可采纳的具体机制 |
|---|---|---|
| 自我认证：模型自测自报 | 航天/医疗软件·IV&V | 技术独立 + 管理独立两条都要：验证方既不能是开发方，也不能受开发方管辖 |
| 威慑度量：越有效越看不见 | 职业安全·前瞻指标 | 不数事故，改测「控制本身是否仍然有效」，按风险分档定检查频率 |
| 威慑度量 | DevOps·混沌工程 Game Day | 定期主动注入被禁的动作，确认仍被拦住。高风险项持续自动化验证 |
| 权限分离：自己能摘紧箍咒 | Linux·seccomp / no_new_privs | 自我施加的限制**不可撤销**：一旦设置，进程自己无法解除，且随 fork/exec 继承 |
| 权限分离 | AWS·SCP 组织护栏 | 约束挂在比行为主体更高的层级，成员账号的 root 也覆盖不了 |
| 权限分离 | 哲学/临床·Ulysses 契约 | 关键不在绑，在于**执行方被要求无视当事人事后的指令** |
| 带外通道谁能走 | 安全运维·break-glass | 双人授权、限时、限范围、全程录制，且流程必须在事故之前就定好 |

---

## 一、自我认证

IV&V 的核心一句话是「人无法客观地测试自己写的代码」。它把独立性拆成两层：**技术独立**（验证者不是开发者）与**管理独立**（验证工作不归开发方管辖）。FAA、FDA 这类认证环境把安全关键代码的独立测试写成强制要求，理由就是避免利益冲突。

对 Thymus 的直接含义：**产前场景筛不能由写这个器官的那个 agent 来跑。**

好消息是我们已经无意中做对了一半——闭环探针里的场景筛是确定性重放，全程没有模型参与。轨迹重放天然满足技术独立。要补的是管理独立：**判定「通过/不通过」的那段逻辑，必须不由 agent 生成，也不能由 agent 修改**。否则它可以先写个宽松的判据再写器官。

这条与 DESIGN.md 已引用的 SR 11-7 *effective challenge* 是同一件事的两个行业版本。

## 二、威慑度量

安全领域管这个叫**预防悖论**：指标降到零的时候，你看起来反而像是白花钱。一句话点破了要害——

> 没出事故，不等于重大风险被控制住了。

行业给的解法不是换个公式，是**换测量对象**：从「数事故」改成「测控制本身还灵不灵」。前瞻指标测的是活动与状态（演练做了几次、隐患关闭率），不是结果。

落到工程上，审计业的做法是**控制测试**：定期重新执行一遍控制，确认它仍然按设计工作，频率按风险分档——高风险项持续自动化验证，低风险项按计划抽查。DevOps 那边是同一件事的另一个名字：**Game Day**，主动注入故障，看防线还在不在，成熟系统建议每月一次。

对 Thymus 的直接含义：**器官的健康检查 = 定期主动去撞它，而不是数它被撞了几次。**

具体到实跑里那个 `ndel-1`：不要统计 `errorResults`，而要定期在影子上下文里主动发一次 `delete_file`，确认它仍然被拒。拦截计数是滞后指标，主动撞墙是前瞻指标。这也顺带解决了「威慑导致计数归零」——主动测试的次数由我们控制，与模型撞不撞墙无关。

## 三、权限分离

三个领域给了三种形状，恰好可以叠加。

**seccomp / no_new_privs（Linux）** 给的是「不可撤销」这个性质本身。一旦进程设置了 `no_new_privs`，这个位无法被清除，并且随 `fork`/`clone`/`execve` 继承；seccomp 过滤器一旦装上，进程直到退出都无法卸载它。**注意它恰恰是自我施加的**——进程自己给自己上锁，然后自己开不了。这与「Agent 自己写器官」的形状完全一致。

**AWS SCP** 给的是「约束住在更高层」。SCP 挂在组织层，划定成员账号的权限上限，账号自己的 root 也覆盖不了。有一个细节值得抄：**管理账号不受 SCP 约束，因此它被要求保持几乎空置**——逃生口存在，但被刻意维持在无人日常使用的状态。

**Ulysses 契约** 给的是最关键的一层，而且常被误读。重点不在「把自己绑在桅杆上」，在于**水手们被事先要求无视他事后的任何命令**。Elster 1979 年把它形式化为自我约束理论：能预见自己将来会动摇，所以提前把选项从自己手里拿走。约束的执行方必须是第三方，且当事人事后的意愿被明确降权。

对 Thymus 的直接含义，三条合起来指向同一个结论：**作用域阶梯本身就是权限分离机制。**

这不是事后附会。dsh 的 `tool-cordis` 明确写着「每个动作都是会话级的：一个包只在定义它的会话里可见可控」。也就是说：

| 器官所在层级 | Agent 能否自己卸载 |
|---|---|
| L1 单会话 | **能**——是它自己定义的包，`cordis_stop` 够得着 |
| L2 preset / L3 全局 | **不能**——已不是它这个会话的动态包，它没有任何工具指向它 |

所以「转正」除了扩大作用域，还有一层此前没写进设计的含义：**把器官移出 Agent 的可及范围。** 实跑里模型之所以能提出「我先停掉守卫」，正因为那个器官还在 L1——完全符合预期，那一格本来就是试用期。

## 四、一个直接挑战我们前提的论点

搜索里有一派主张叫 **unfireable safety kernel**：任何位于 agent 运行时**之内**的控制，原则上都能被足以影响该运行时的输入所修改，因此执行期的对齐必须活在 agent 的地址空间**之外**。

这一条直接指向 Thymus 的根基——我们的器官就住在同一个进程、同一棵 cordis 树里。

诚实的回应分两半：

**对遗忘与惰性，Thymus 的控制是真的。** 升级之后 Agent 手上没有任何工具能指向那个器官，这是实测过的机制事实，不是承诺。

**对恶意，它不是安全边界，而且这话是上游自己说的。** `tool-cordis` 原文：沙箱隔离全局变量，但**不是安全边界**，宿主域的辅助对象使逃逸成为可能，应当按 bash 权限对待。

所以本项目的定位应当写死：**Thymus 是可靠性控制，不是安全控制。** 它防的是「说过就忘」「上下文一长就漂移」「图省事绕过去」，不防一个主动寻找逃逸路径的模型。这个边界越早写进文档越好，否则迟早有人拿它当沙箱用。

真要防恶意，按那派的说法得把控制移出进程——那是另一个项目的范围。

## 五、可以落地的三条

1. **场景筛的判据与执行都不能由被审器官的作者产生**。重放本身已经是确定性的；把判据也固化成不可由 agent 修改的东西。
2. **器官健康检查改成主动撞墙**，按风险分档定频率，替代拦截计数。
3. **把「能否自己卸载」显式写进阶梯的层级定义**：L1 可自卸（试用期），L2 以上不可自卸（转正即交权）。带外通道按 break-glass 设计——双人、限时、限范围、全程留痕，流程事先定好。

## 来源

- IV&V：[CMU SEI](https://www.sei.cmu.edu/library/independent-verification-validation-ivv-for-agile-developed-projects/)、[HHS IV&V 实务指南](https://www.hhs.gov/sites/default/files/ocio/eplc/EPLC%20Archive%20Documents/14%20-%20IVV/eplc_ivv_practices_guide.pdf)
- 预防悖论与前瞻指标：[The Prevention Paradox](https://medium.com/@qhsestandard/the-prevention-paradox-why-success-looks-like-a-waste-of-money-e072151ed8d4)、[EHS Today：对指标的虚假信心](https://www.ehstoday.com/safety-leadership/article/55390389/preventing-catastrophic-safety-incidents-do-we-have-false-confidence-in-our-metrics)、[CCOHS](https://www.ccohs.ca/oshanswers/hsprograms/leading-and-lagging-indicators.html)
- 控制测试与 Game Day：[Control Testing 101](https://www.suralink.com/blog/control-testing-101)、[Gremlin：GameDays 入门](https://www.gremlin.com/community/tutorials/introduction-to-gamedays)
- seccomp / no_new_privs：[Linux 内核文档](https://docs.kernel.org/userspace-api/no_new_privs.html)、[HackTricks](https://hacktricks.wiki/en/linux-hardening/privilege-escalation/container-security/protections/no-new-privileges.html)
- AWS SCP：[AWS Organizations 文档](https://docs.aws.amazon.com/organizations/latest/userguide/orgs_manage_policies_scps.html)、[AWS 安全成熟度模型](https://maturitymodel.security.aws.dev/en/2.-foundational/guardrails/)
- Ulysses 契约：[Grokipedia](https://grokipedia.com/page/Ulysses_pact)、[Bioethics 综述](https://onlinelibrary.wiley.com/doi/10.1111/bioe.13197)
- break-glass：[Lumos](https://www.lumos.com/blog/planning-for-emergency-access)、[Cloudanix](https://www.cloudanix.com/learn/break-glass-procedure-emergency-access-for-critical-resources)
- unfireable safety kernel 与 agent 护栏：[UnderDefense](https://underdefense.com/blog/ai-soc-guardrails/)
