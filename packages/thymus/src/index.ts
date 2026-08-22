/**
 * Thymus：给 DeepSeek Harness 的 agent 加一层约束治理。
 *
 * 它治理的对象是**其他插件**——包括 agent 自己在运行时写出来、挂上去的那些。
 * dsh 明确不在这一层做决定（其 `cordis-host-runner` README 写着「vm 沙箱隔离全局
 * 对象，但不是安全边界，把动态包当作 bash 访问看待」），Thymus 不修改这个立场，
 * 只在它之上补一层可选的治理与验收。
 *
 * 两个部分，分开也各自成立，合起来才完整：
 *
 *   {@link module:thymus/gate}            —— 判决聚合层。约束不进动态注册表，
 *     裁决站在调用链之外；任一 deny 即拒绝，与注册顺序无关；抛错、超时、
 *     返回非法判决一律按 deny。
 *   {@link module:thymus/eval-framework}  —— 评测框架。把一份 spec 的评测用例在
 *     独立 context 里对候选插件重放，并在冻结之前给评测集本身做梯度体检。
 *
 * 治理是卖点，评测是它的验收。只有前者会退化成「又一个写规矩的框架」；
 * 只有后者则没有执行力。
 *
 * @module thymus
 */
export {
  DEFAULT_VERDICT_TIMEOUT_MS,
  adjudicate,
  gateSay,
  installToolGate,
  judgeText,
  type Constraint,
  type ToolCall,
  type Verdict,
} from './gate.ts'

export {
  checkSpecEvals,
  compileConstraints,
  formatSpecEvalReports,
  type ConstraintSpec,
  type EvalDeclaration,
  type ForbiddenPhrasesSpec,
  type NoLeakSpec,
  type SemanticPolicySpec,
  type SpecEvalReport,
} from './spec.ts'

export {
  checkEvalGradient,
  judgeCases,
  type EvalAssert,
  type EvalCase,
  type EvalSayStep,
  type EvalStep,
  type EvalToolStep,
  type GradientReport,
  type JudgeOptions,
  type JudgeResult,
} from './eval-framework.ts'
