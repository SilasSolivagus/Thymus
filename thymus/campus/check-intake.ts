/**
 * 两个实例的现场前置登记，以及它们收窄出来的可做范围。
 *
 * 这一份如实填写——包括填不出来的地方。前置登记的价值恰恰在于**照出还没确认的前提**，
 * 填得漂亮没有意义。
 *
 * 不调模型，零成本。跑法：DEMODIR=campus DEMO=check-intake ./thymus/demo/run.sh
 */
import { pathToFileURL } from 'node:url'
import { formatCapabilityStatement, scopeFromIntake, type Intake } from '../src/intake.ts'
import { checkSpecHygiene, formatHygieneReport } from '../src/hygiene.ts'
import { BUNDLE } from './spec-declarations.ts'

/**
 * 校园网客服。数据出境如实登记为「允许」——判定内容一直发往 DeepSeek。
 * 干系人与材料版本确实没有，不补。
 */
const CAMPUS: Intake = {
  instance: '校园网客服',
  dataEgress: '允许',
  allowedModels: ['deepseek-chat'],
  systems: [],
  stakeholders: [],
  materials: [{ title: '西安新路《客户服务部作业指导书》' }],
}

/** 123 云盘运营。自用账号、只读明细、GET-only。 */
const PAN: Intake = {
  instance: '123 云盘运营',
  dataEgress: '允许',
  allowedModels: ['deepseek-chat'],
  logRetention: '本机，不入库',
  systems: [{
    name: '123 云盘 manager 后台',
    systemType: '自研管理后台',
    accountType: '个人账号',
    accessLevel: '只读明细',
    approvedBy: '本人账号',
  }],
  stakeholders: [
    { role: '决策人', name: 'Silas' },
    { role: '业务责任人', name: 'Silas' },
    { role: '数据责任人', name: 'Silas' },
  ],
  materials: [{ title: '已确认接口清单', version: '2026-07-03', providedBy: '自建（抓包确认）' }],
}

function box(t: string): void { console.log(`\n${'='.repeat(76)}\n${t}\n${'='.repeat(76)}`) }

function main(): void {
  for (const intake of [CAMPUS, PAN]) {
    const scope = scopeFromIntake(intake)
    box(`${intake.instance} · 收窄结果`)
    console.log(`可用类型 ${scope.allowedTypes.length}/6`
      + `${scope.blockedTypes.length === 0 ? '' : ` · 被前提禁用：${scope.blockedTypes.join('、')}`}`)
    console.log(`技能生成上界：${scope.maxAccessLevel ?? '无接入系统'}`)
    console.log(`前提缺口 ${scope.gaps.length} 项：`)
    for (const g of scope.gaps) console.log(`  【${g.level}】${g.message}`)
    console.log(`\n— 能力边界说明 —\n`)
    console.log(formatCapabilityStatement(intake, scope))
  }

  box('校园网客服 · 把前提接进冻结前的机械闸')
  const scope = scopeFromIntake(CAMPUS)
  console.log(formatHygieneReport(checkSpecHygiene(BUNDLE, scope)))

  box('对照：如果客户不允许数据出境')
  const offline = scopeFromIntake({ ...CAMPUS, dataEgress: '禁止' })
  console.log(formatHygieneReport(checkSpecHygiene(BUNDLE, offline)))
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main()
