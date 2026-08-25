/** 壳的那一页。纯静态字符串，没有外部资源。 */
export const PAGE = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Thymus · 约束治理实况</title>
<style>
  :root { color-scheme: light dark; --bg:#fff; --fg:#1a1a1a; --muted:#6b6b6b;
    --line:#e3e3e3; --card:#fafafa; --deny:#b42318; --rewrite:#8a6100; --ok:#2f6f3e; }
  @media (prefers-color-scheme: dark) { :root { --bg:#17181a; --fg:#e8e8e8; --muted:#9a9a9a;
    --line:#2c2e31; --card:#1e2022; --deny:#f97066; --rewrite:#e0b341; --ok:#75c98d; } }
  * { box-sizing:border-box }
  body { margin:0; background:var(--bg); color:var(--fg); font:15px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC","Helvetica Neue",sans-serif }
  header { padding:14px 20px; border-bottom:1px solid var(--line) }
  header h1 { margin:0; font-size:15px; font-weight:600 }
  header p { margin:4px 0 0; font-size:12.5px; color:var(--muted) }
  main { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,420px); gap:0; height:calc(100vh - 66px) }
  @media (max-width:900px) { main { grid-template-columns:1fr; height:auto } }
  #chat { overflow-y:auto; padding:18px 20px }
  #panel { border-left:1px solid var(--line); overflow-y:auto; padding:18px 20px; background:var(--card) }
  @media (max-width:900px) { #panel { border-left:none; border-top:1px solid var(--line) } }
  .msg { margin:0 0 14px; max-width:min(72ch,100%) }
  .msg .who { font-size:12px; color:var(--muted); margin-bottom:2px }
  .msg.user .bubble { background:var(--card); border:1px solid var(--line) }
  .bubble { padding:9px 12px; border-radius:10px; white-space:pre-wrap; word-break:break-word }
  .msg.bot .bubble { border:1px solid var(--line) }
  form { display:flex; gap:8px; padding:14px 20px; border-top:1px solid var(--line) }
  input { flex:1; padding:9px 11px; border:1px solid var(--line); border-radius:8px;
    background:var(--bg); color:var(--fg); font:inherit }
  button { padding:9px 16px; border:1px solid var(--line); border-radius:8px; background:var(--card);
    color:var(--fg); font:inherit; cursor:pointer }
  button:disabled { opacity:.5; cursor:default }
  h2 { font-size:12px; text-transform:uppercase; letter-spacing:.06em; color:var(--muted);
    margin:0 0 8px; font-weight:600 }
  .turn { border-top:1px solid var(--line); padding:12px 0; font-size:13px }
  .turn:first-of-type { border-top:none }
  .turn .q { color:var(--muted); margin-bottom:6px }
  .ev { margin:4px 0; padding-left:10px; border-left:2px solid var(--line) }
  .ev.deny { border-color:var(--deny); color:var(--deny) }
  .ev.rewrite { border-color:var(--rewrite); color:var(--rewrite) }
  .ev .who { font-weight:600 }
  .quiet { color:var(--muted) }
  code { font:12.5px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace }
  .hint { font-size:12.5px; color:var(--muted); padding:0 20px 14px }
  .hint b { color:var(--fg); font-weight:600; cursor:pointer; text-decoration:underline dotted }
</style></head><body>
<header>
  <h1>Thymus · 约束治理实况 <a href="/" style="font-size:12.5px;font-weight:400;margin-left:10px">← 处理台</a></h1>
  <p>内核是真的 dsh（AgentLoop + DeepSeek + 工具运行时），约束是真网关，声明用 campus 那份原件。
     这一页的壳是本仓库写的，不是 dsh 自带界面。</p>
</header>
<main>
  <section style="display:flex;flex-direction:column;min-height:0">
    <div id="chat"></div>
    <div class="hint">试试：<b>我这个月账单多少</b> · <b>我学号2021001，手机13800000000</b> ·
      <b>我在西京学院，你们能上门修吗</b> · <b>这个不可能，我做不到</b></div>
    <form id="f"><input id="t" autocomplete="off" placeholder="说点什么…"><button id="b">发送</button></form>
  </section>
  <aside id="panel"><h2>网关做了什么</h2><div id="log" class="quiet">还没有对话。</div></aside>
</main>
<script>
const sessionId = 'shell-' + Math.random().toString(36).slice(2, 9)
const chat = document.getElementById('chat'), log = document.getElementById('log')
const form = document.getElementById('f'), input = document.getElementById('t'), btn = document.getElementById('b')
let first = true
function bubble(who, cls, text) {
  const d = document.createElement('div'); d.className = 'msg ' + cls
  d.innerHTML = '<div class="who"></div><div class="bubble"></div>'
  d.querySelector('.who').textContent = who; d.querySelector('.bubble').textContent = text
  chat.appendChild(d); chat.scrollTop = chat.scrollHeight; return d
}
function record(q, data) {
  if (first) { log.textContent = ''; log.className = ''; first = false }
  const t = document.createElement('div'); t.className = 'turn'
  const q1 = document.createElement('div'); q1.className = 'q'; q1.textContent = '「' + q + '」'
  t.appendChild(q1)
  const evs = data.gate || []
  if (evs.length === 0 && (data.tools || []).length === 0) {
    const n = document.createElement('div'); n.className = 'quiet'; n.textContent = '没有拦截，也没调工具'
    t.appendChild(n)
  }
  for (const e of evs) {
    const d = document.createElement('div')
    d.className = 'ev ' + (e.kind === '产出被改写' ? 'rewrite' : 'deny')
    d.innerHTML = '<span class="who"></span> <span class="k"></span><div class="dt"></div>'
    d.querySelector('.who').textContent = e.who
    d.querySelector('.k').textContent = e.kind
    d.querySelector('.dt').textContent = e.detail
    t.appendChild(d)
  }
  for (const line of data.tools || []) {
    const d = document.createElement('div'); d.className = 'ev'
    const c = document.createElement('code'); c.textContent = line; d.appendChild(c); t.appendChild(d)
  }
  if (data.warning) {
    const d = document.createElement('div'); d.className = 'ev deny'; d.textContent = '⚠ ' + data.warning
    t.appendChild(d)
  }
  log.prepend(t)
}
async function send(text) {
  bubble('你', 'user', text)
  const pending = bubble('客服 agent', 'bot', '…')
  btn.disabled = true; input.disabled = true
  try {
    const r = await fetch('/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, text }) })
    const data = await r.json()
    pending.querySelector('.bubble').textContent = data.error ? ('出错：' + data.error) : (data.said || '（没有正文）')
    if (!data.error) record(text, data)
  } catch (e) {
    pending.querySelector('.bubble').textContent = '出错：' + e.message
  } finally { btn.disabled = false; input.disabled = false; input.focus() }
}
function submit() { const v = input.value.trim(); if (!v) return; input.value = ''; send(v) }
form.addEventListener('submit', e => { e.preventDefault(); submit() })
input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); submit() } })
document.querySelectorAll('.hint b').forEach(b => b.addEventListener('click', () => {
  input.value = b.textContent; input.focus() }))
</script></body></html>`

/** 前置登记页。边填边收窄——每改一项，立刻显示它启用或禁用了什么。 */
export const INTAKE_PAGE = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>现场前置登记 · Thymus</title>
<style>
  :root { color-scheme: light dark; --bg:#fff; --fg:#1a1a1a; --muted:#6b6b6b;
    --line:#e3e3e3; --card:#fafafa; --deny:#b42318; --warn:#8a6100; --ok:#2f6f3e; --accent:#0071e3; }
  @media (prefers-color-scheme: dark) { :root { --bg:#17181a; --fg:#e8e8e8; --muted:#9a9a9a;
    --line:#2c2e31; --card:#1e2022; --deny:#f97066; --warn:#e0b341; --ok:#75c98d; --accent:#4c9dff; } }
  * { box-sizing:border-box }
  body { margin:0; background:var(--bg); color:var(--fg);
    font:15px/1.65 -apple-system,BlinkMacSystemFont,"PingFang SC","Helvetica Neue",sans-serif }
  header { padding:14px 20px; border-bottom:1px solid var(--line); display:flex; align-items:baseline; gap:16px }
  header h1 { margin:0; font-size:15px; font-weight:600 }
  header nav a { font-size:13px; color:var(--muted); text-decoration:none; margin-right:11px }
  header nav a.on { color:var(--fg); font-weight:600 }
  header p { margin:0; font-size:12.5px; color:var(--muted) }
  main { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,460px); height:calc(100vh - 56px) }
  @media (max-width:900px) { main { grid-template-columns:1fr; height:auto } }
  .form { overflow-y:auto; padding:20px }
  .panel { border-left:1px solid var(--line); background:var(--card); overflow-y:auto; padding:20px }
  @media (max-width:900px) { .panel { border-left:none; border-top:1px solid var(--line) } }
  fieldset { border:1px solid var(--line); border-radius:10px; padding:12px 14px 14px; margin:0 0 14px }
  legend { font-size:12px; color:var(--muted); padding:0 5px; letter-spacing:.04em }
  label { display:inline-flex; align-items:center; gap:6px; margin:3px 12px 3px 0; font-size:14px }
  input[type=text] { width:100%; padding:7px 9px; border:1px solid var(--line); border-radius:7px;
    background:var(--bg); color:var(--fg); font:inherit; font-size:14px; margin-top:5px }
  .hint { font-size:12px; color:var(--muted); margin-top:6px; line-height:1.5 }
  h2 { font-size:12px; text-transform:uppercase; letter-spacing:.06em; color:var(--muted);
    margin:0 0 9px; font-weight:600 }
  .big { font-size:22px; font-weight:600; letter-spacing:-.02em }
  .big span { font-size:13px; font-weight:400; color:var(--muted) }
  .item { padding:8px 0 8px 11px; border-left:2px solid var(--line); margin:6px 0; font-size:13.5px; line-height:1.55 }
  .item.block { border-color:var(--deny); color:var(--deny) }
  .item.warn { border-color:var(--warn); color:var(--warn) }
  .item.off { border-color:var(--deny) }
  .delta { border:1px solid var(--line); border-radius:10px; padding:11px 13px; margin-bottom:16px;
    background:var(--bg); font-size:13.5px; line-height:1.6 }
  .delta b { color:var(--deny) }
  pre { background:var(--bg); border:1px solid var(--line); border-radius:10px; padding:13px 15px;
    font:12.5px/1.7 ui-monospace,SFMono-Regular,Menlo,monospace; white-space:pre-wrap; word-break:break-word;
    max-height:340px; overflow-y:auto }
  button { padding:6px 13px; border:1px solid var(--line); border-radius:7px; background:var(--bg);
    color:var(--fg); font:inherit; font-size:13px; cursor:pointer }
</style></head><body>
<header>
  <h1>现场前置登记</h1>
  <nav><a href="/">处理台</a><a href="/rules">约束声明</a>
    <a href="/intake" class="on">前置登记</a><a href="/chat">对话</a></nav>
  <p>人在现场问出来的前提，进系统之后反过来收窄系统允许做的事</p>
</header>
<main>
  <section class="form">
    <fieldset><legend>数据与模型</legend>
      <div>
        <label><input type="radio" name="egress" value="允许" checked> 业务内容可发往外部模型</label>
        <label><input type="radio" name="egress" value="仅私有模型"> 仅私有模型</label>
        <label><input type="radio" name="egress" value="禁止"> 禁止出境</label>
      </div>
      <input type="text" id="models" value="deepseek-chat" placeholder="可用于判定的模型，逗号分隔">
      <div class="hint">六种约束类型里有三种要把内容发给模型判定。禁止出境时它们整类不可用——
        这是范围，不是效果差一点。</div>
    </fieldset>

    <fieldset><legend>接入系统与权限</legend>
      <label><input type="checkbox" id="hasSystem"> 已接入一个系统</label>
      <input type="text" id="sysName" value="123 云盘 manager 后台" placeholder="系统名称">
      <div style="margin-top:7px">
        <label><input type="radio" name="acct" value="服务账号" checked> 服务账号</label>
        <label><input type="radio" name="acct" value="个人账号"> 个人账号</label>
      </div>
      <div style="margin-top:5px">
        <label><input type="radio" name="lvl" value="只读聚合"> 只读聚合</label>
        <label><input type="radio" name="lvl" value="只读明细" checked> 只读明细</label>
        <label><input type="radio" name="lvl" value="可写"> 可写</label>
      </div>
      <div class="hint">权限档决定技能生成的上界。按 只读聚合 → 只读明细 → 可写 逐档申请。</div>
    </fieldset>

    <fieldset><legend>干系人</legend>
      <label><input type="checkbox" id="r1" checked> 决策人</label>
      <label><input type="checkbox" id="r2"> 业务责任人</label>
      <label><input type="checkbox" id="r3"> 数据责任人</label>
      <label><input type="checkbox" id="r4"> 安全对接人</label>
      <div class="hint">没有业务责任人就没有复验对象，声明不得冻结。</div>
    </fieldset>

    <fieldset><legend>材料来源</legend>
      <input type="text" id="matTitle" value="西安新路《客户服务部作业指导书》" placeholder="材料名称">
      <label style="margin-top:8px"><input type="checkbox" id="matMeta"> 已登记版本与提供人</label>
      <div class="hint">缺版本或提供人，引用它的条款事后无法追溯。</div>
    </fieldset>
  </section>

  <aside class="panel">
    <div id="delta" class="delta">改动任一项，这里显示它启用或禁用了什么。</div>
    <div id="queueNote" class="hint" style="margin:-8px 0 16px"></div>
    <h2>可做范围</h2>
    <div class="big" id="count">—</div>
    <div id="blocked"></div>
    <h2 style="margin-top:18px">尚未确认的前提</h2>
    <div id="gaps"></div>
    <h2 style="margin-top:18px">能力边界说明 <button id="copy" style="float:right">复制</button></h2>
    <pre id="stmt">—</pre>
  </aside>
</main>
<script>
let last = null
function read() {
  const q = s => document.querySelector(s)
  const sys = q('#hasSystem').checked ? [{
    name: q('#sysName').value || '未命名系统', systemType: '自研管理后台',
    accountType: document.querySelector('input[name=acct]:checked').value,
    accessLevel: document.querySelector('input[name=lvl]:checked').value,
  }] : []
  const roles = [['#r1','决策人'],['#r2','业务责任人'],['#r3','数据责任人'],['#r4','安全对接人']]
  const meta = q('#matMeta').checked
  return {
    instance: '校园网客服',
    dataEgress: document.querySelector('input[name=egress]:checked').value,
    allowedModels: q('#models').value.split(',').map(x => x.trim()).filter(Boolean),
    systems: sys,
    stakeholders: roles.filter(([sel]) => q(sel).checked).map(([, role]) => ({ role, name: '待填' })),
    materials: q('#matTitle').value
      ? [meta ? { title: q('#matTitle').value, version: '2026-06', providedBy: '客服部' }
              : { title: q('#matTitle').value }]
      : [],
  }
}
async function refresh() {
  const r = await fetch('/api/intake', { method:'POST', headers:{'content-type':'application/json'},
    body: JSON.stringify(read()) })
  const d = await r.json()
  document.getElementById('count').innerHTML =
    d.scope.allowedTypes.length + '/6 <span>种约束类型可用</span>'
  const bl = document.getElementById('blocked'); bl.innerHTML = ''
  for (const t of d.blockedLabels) {
    const el = document.createElement('div'); el.className = 'item off'
    el.textContent = '不可用：' + t; bl.appendChild(el)
  }
  const gp = document.getElementById('gaps'); gp.innerHTML = ''
  if (d.scope.gaps.length === 0) { gp.innerHTML = '<div class="item">无</div>' }
  for (const g of d.scope.gaps) {
    const el = document.createElement('div')
    el.className = 'item ' + (g.level === '阻断' ? 'block' : 'warn')
    el.textContent = '【' + g.level + '】' + g.message; gp.appendChild(el)
  }
  document.getElementById('stmt').textContent = d.statement
  const q = document.getElementById('queueNote')
  if (q) q.textContent = '这些前提当前产生 ' + d.queueSize + ' 项待处理，已排进处理台'
  const dl = document.getElementById('delta')
  if (last) {
    const gained = d.scope.allowedTypes.filter(t => !last.scope.allowedTypes.includes(t))
    const lost = last.scope.allowedTypes.filter(t => !d.scope.allowedTypes.includes(t))
    const dg = d.scope.gaps.length - last.scope.gaps.length
    const parts = []
    if (lost.length) parts.push('<b>禁用 ' + lost.length + ' 种约束类型</b>')
    if (gained.length) parts.push('启用 ' + gained.length + ' 种约束类型')
    if (dg > 0) parts.push('新增 ' + dg + ' 项待确认前提')
    if (dg < 0) parts.push('消掉 ' + (-dg) + ' 项待确认前提')
    dl.innerHTML = parts.length ? '本次变更：' + parts.join(' · ') : '本次变更：可做范围没有变化'
  }
  last = d
}
// 单选与勾选只听 change，文本框只听 input——两个都听会让同一次改动刷新两次，
// 第二次拿改完的状态跟改完的状态比，差异就被吃掉了。
document.querySelectorAll('input[type=radio],input[type=checkbox]')
  .forEach(el => el.addEventListener('change', refresh))
document.querySelectorAll('input[type=text]')
  .forEach(el => el.addEventListener('input', refresh))
document.getElementById('copy').addEventListener('click', () => {
  navigator.clipboard.writeText(document.getElementById('stmt').textContent)
  document.getElementById('copy').textContent = '已复制'
  setTimeout(() => { document.getElementById('copy').textContent = '复制' }, 1200)
})
refresh()
</script></body></html>`

/**
 * 处理台——系统的首屏。
 *
 * 打开系统第一眼要回答的是「今天有什么要我处理」，不是一张空表。前置登记的阻断项、
 * 被前提禁用的约束，都在这里排队；点进去才是各自的界面。
 *
 * `__VIEW__` 会被服务端替换成默认视图（desk / rules）。
 */
export const DESK_PAGE = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>处理台 · Thymus</title>
<style>
  :root { color-scheme: light dark; --bg:#fff; --fg:#1a1a1a; --muted:#6b6b6b;
    --line:#e3e3e3; --card:#fafafa; --deny:#b42318; --warn:#8a6100; --ok:#2f6f3e; --accent:#0071e3;
    --denyBg:#fdf0ef; --warnBg:#fbf4e6; --okBg:#eef7f0; }
  @media (prefers-color-scheme: dark) { :root { --bg:#17181a; --fg:#e8e8e8; --muted:#9a9a9a;
    --line:#2c2e31; --card:#1e2022; --deny:#f97066; --warn:#e0b341; --ok:#75c98d; --accent:#4c9dff;
    --denyBg:#2a1c1b; --warnBg:#272016; --okBg:#1a241d; } }
  * { box-sizing:border-box }
  body { margin:0; background:var(--bg); color:var(--fg);
    font:15px/1.65 -apple-system,BlinkMacSystemFont,"PingFang SC","Helvetica Neue",sans-serif }
  header { padding:12px 22px; border-bottom:1px solid var(--line); display:flex; align-items:center; gap:18px }
  header .inst { font-size:14px; font-weight:600 }
  header .inst span { font-weight:400; color:var(--muted); font-size:12.5px; margin-left:7px }
  nav { margin-left:auto; display:flex; gap:4px }
  nav a { padding:5px 11px; border-radius:7px; font-size:13px; color:var(--muted); text-decoration:none }
  nav a.on { background:var(--card); color:var(--fg); font-weight:600 }
  .wrap { max-width:940px; margin:0 auto; padding:26px 22px 70px }
  h2 { font-size:12px; text-transform:uppercase; letter-spacing:.06em; color:var(--muted);
    margin:0 0 12px; font-weight:600 }
  .sum { display:flex; gap:26px; align-items:baseline; margin-bottom:22px; flex-wrap:wrap }
  .sum b { font-size:26px; font-weight:600; letter-spacing:-.02em }
  .sum i { font-style:normal; font-size:13px; color:var(--muted); margin-left:6px }
  .card { border:1px solid var(--line); border-radius:11px; padding:13px 15px; margin-bottom:9px;
    display:flex; gap:13px; align-items:flex-start; text-decoration:none; color:inherit }
  .card:hover { border-color:var(--accent) }
  .tag { flex:none; font-size:11.5px; padding:2px 8px; border-radius:999px; margin-top:2px }
  .tag.block { background:var(--denyBg); color:var(--deny) }
  .tag.warn { background:var(--warnBg); color:var(--warn) }
  .card .t { font-size:14px; line-height:1.5 }
  .card .d { font-size:12.5px; color:var(--muted); margin-top:3px; line-height:1.5 }
  .card .k { font-size:11.5px; color:var(--muted); margin-top:4px }
  .empty { color:var(--muted); font-size:14px; padding:14px 0 }
  table { width:100%; border-collapse:collapse; font-size:13.5px }
  th { text-align:left; font-size:11.5px; letter-spacing:.04em; color:var(--muted);
    font-weight:600; padding:0 10px 8px 0 }
  td { padding:9px 10px 9px 0; border-top:1px solid var(--line) }
  .off { color:var(--deny) }
  .pill { font-size:11.5px; padding:2px 8px; border-radius:999px; background:var(--card); color:var(--muted) }
  .pill.bad { background:var(--denyBg); color:var(--deny) }
</style></head><body>
<header>
  <div class="inst" id="inst">—<span>当前实例</span></div>
  <nav>
    <a href="/" id="n-desk">处理台</a>
    <a href="/rules" id="n-rules">约束声明</a>
    <a href="/intake" id="n-intake">前置登记</a>
    <a href="/chat" id="n-chat">对话</a>
  </nav>
</header>
<div class="wrap">
  <div id="deskView">
    <div class="sum">
      <div><b id="qn">—</b><i>项待处理</i></div>
      <div><b id="sc">—</b><i>种约束类型可用</i></div>
    </div>
    <h2>待处理 · 按是否需要人工介入排序</h2>
    <div id="queue"></div>
  </div>
  <div id="rulesView" style="display:none">
    <h2>约束声明 · 校园网客服</h2>
    <table><thead><tr><th>约束</th><th>类型</th><th>状态</th></tr></thead>
      <tbody id="specs"></tbody></table>
    <p class="empty">被现场前提禁用的约束不会因为写得好而变得可用——那是范围，不是质量。</p>
  </div>
</div>
<script>
const view = '__VIEW__' === 'rules' ? 'rules' : 'desk'
document.getElementById(view === 'rules' ? 'n-rules' : 'n-desk').classList.add('on')
document.getElementById('deskView').style.display = view === 'desk' ? '' : 'none'
document.getElementById('rulesView').style.display = view === 'rules' ? '' : 'none'
fetch('/api/desk').then(r => r.json()).then(d => {
  document.getElementById('inst').innerHTML = d.instance + '<span>当前实例</span>'
  document.getElementById('qn').textContent = d.queue.length
  document.getElementById('sc').textContent = d.scope.allowedTypes.length + '/6'
  const q = document.getElementById('queue')
  if (d.queue.length === 0) { q.innerHTML = '<div class="empty">没有待处理事项。</div>' }
  const order = { '阻断': 0, '提示': 1 }
  for (const it of d.queue.sort((a, b) => order[a.level] - order[b.level])) {
    const a = document.createElement('a'); a.className = 'card'; a.href = it.href
    a.innerHTML = '<span class="tag"></span><span><span class="t"></span>' +
      '<div class="d"></div><div class="k"></div></span>'
    const tag = a.querySelector('.tag')
    tag.textContent = it.level; tag.classList.add(it.level === '阻断' ? 'block' : 'warn')
    a.querySelector('.t').textContent = it.title
    a.querySelector('.d').textContent = it.detail
    a.querySelector('.k').textContent = '来源：' + it.kind
    q.appendChild(a)
  }
  const tb = document.getElementById('specs')
  for (const s of d.specs) {
    const tr = document.createElement('tr')
    tr.innerHTML = '<td></td><td></td><td></td>'
    const [c1, c2, c3] = tr.children
    c1.textContent = s.name; if (s.blocked) c1.className = 'off'
    c2.textContent = s.label
    c3.innerHTML = s.blocked
      ? '<span class="pill bad">前提不允许</span>'
      : '<span class="pill">可用</span>'
    tb.appendChild(tr)
  }
})
</script></body></html>`
