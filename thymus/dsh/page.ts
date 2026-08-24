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
  <h1>Thymus · 约束治理实况</h1>
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
