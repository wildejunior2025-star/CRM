// ============================================================================
// Impressora FWC — agente de impressao automatica.
// Loga na conta da loja, escuta os pedidos novos em tempo real e imprime cada
// um direto na termica (ESC/POS). Sem navegador, sem QZ, sem certificado.
// Tela de configuracao roda em http://localhost:9110 (login + impressora).
// ============================================================================
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const { spawnSync, spawn, exec } = require('child_process')
const { createClient } = require('@supabase/supabase-js')
const { montarCupom } = require('./cupom')

// Node empacotado (pkg) nao tem WebSocket nativo — a lib realtime do Supabase
// precisa. Injeta o 'ws' como implementacao global.
const WS = require('ws')
if (!globalThis.WebSocket) globalThis.WebSocket = WS

const SUPABASE_URL = 'https://ycytrsqdvrviihkqfvno.supabase.co'
const ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InljeXRyc3FkdnJ2aWloa3Fmdm5vIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODExMjc1NDcsImV4cCI6MjA5NjcwMzU0N30.zAq-8gaw2U9wvwBJCX_rK2jP-tnjOL5VPS23fFxf2Zc'
const PORT = 9110

// Pasta de dados (grava mesmo com o .exe em Program Files)
const DATA_DIR = path.join(process.env.APPDATA || os.homedir(), 'ImpressoraFWC')
try { fs.mkdirSync(DATA_DIR, { recursive: true }) } catch (e) {}

// Se está rodando de fora do lugar instalado (ex.: baixado na Downloads), se
// instala na Área de Trabalho e sai. (definições das funções mais abaixo)
if (autoInstalar()) process.exit(0)

const SESSION_FILE = path.join(DATA_DIR, 'session.json')
const CONFIG_FILE = path.join(DATA_DIR, 'config.json')
const PS1_FILE = path.join(DATA_DIR, 'print-raw.ps1')

// ---- estado ----
const logs = []
function log(...a) {
  const s = new Date().toLocaleTimeString('pt-BR') + ' ' + a.join(' ')
  console.log(s)
  logs.push(s); if (logs.length > 200) logs.shift()
}
let empresa = null, empresaId = null, canal = null
let sessionAtiva = false, empresasDisponiveis = []
const config = () => { try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) } catch (e) { return {} } }
const setConfig = o => fs.writeFileSync(CONFIG_FILE, JSON.stringify({ ...config(), ...o }, null, 2))

// ---- storage de sessao em arquivo (auto-refresh do Supabase) ----
const fileStorage = {
  getItem: (k) => { try { return JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'))[k] ?? null } catch (e) { return null } },
  setItem: (k, v) => { let o = {}; try { o = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8')) } catch (e) {} o[k] = v; fs.writeFileSync(SESSION_FILE, JSON.stringify(o)) },
  removeItem: (k) => { let o = {}; try { o = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8')) } catch (e) {} delete o[k]; fs.writeFileSync(SESSION_FILE, JSON.stringify(o)) },
}
const supabase = createClient(SUPABASE_URL, ANON_KEY, {
  auth: { storage: fileStorage, persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
  realtime: { transport: WS },
})

// ---- impressao raw (ESC/POS) via spooler do Windows ----
const PS1 = `param([Parameter(Mandatory=$true)][string]$Printer,[Parameter(Mandatory=$true)][string]$File)
$code = @'
using System;using System.Runtime.InteropServices;
public class RawPrinter{
[StructLayout(LayoutKind.Sequential,CharSet=CharSet.Ansi)]public struct DOCINFOA{[MarshalAs(UnmanagedType.LPStr)]public string pDocName;[MarshalAs(UnmanagedType.LPStr)]public string pOutputFile;[MarshalAs(UnmanagedType.LPStr)]public string pDataType;}
[DllImport("winspool.Drv",EntryPoint="OpenPrinterA",SetLastError=true,CharSet=CharSet.Ansi)]public static extern bool OpenPrinter(string s,out IntPtr h,IntPtr p);
[DllImport("winspool.Drv",EntryPoint="ClosePrinter",SetLastError=true)]public static extern bool ClosePrinter(IntPtr h);
[DllImport("winspool.Drv",EntryPoint="StartDocPrinterA",SetLastError=true,CharSet=CharSet.Ansi)]public static extern bool StartDocPrinter(IntPtr h,int l,ref DOCINFOA d);
[DllImport("winspool.Drv",EntryPoint="EndDocPrinter",SetLastError=true)]public static extern bool EndDocPrinter(IntPtr h);
[DllImport("winspool.Drv",EntryPoint="StartPagePrinter",SetLastError=true)]public static extern bool StartPagePrinter(IntPtr h);
[DllImport("winspool.Drv",EntryPoint="EndPagePrinter",SetLastError=true)]public static extern bool EndPagePrinter(IntPtr h);
[DllImport("winspool.Drv",EntryPoint="WritePrinter",SetLastError=true)]public static extern bool WritePrinter(IntPtr h,byte[] d,int n,out int w);
public static bool SendBytes(string pr,byte[] b){IntPtr h;if(!OpenPrinter(pr,out h,IntPtr.Zero))return false;DOCINFOA d=new DOCINFOA();d.pDocName="FWC Cupom";d.pDataType="RAW";bool ok=false;if(StartDocPrinter(h,1,ref d)){if(StartPagePrinter(h)){int w;ok=WritePrinter(h,b,b.Length,out w);EndPagePrinter(h);}EndDocPrinter(h);}ClosePrinter(h);return ok;}}
'@
Add-Type -TypeDefinition $code -Language CSharp
$b=[System.IO.File]::ReadAllBytes($File)
if([RawPrinter]::SendBytes($Printer,$b)){Write-Output "OK"}else{Write-Output "FAIL";exit 1}`
try { fs.writeFileSync(PS1_FILE, PS1) } catch (e) {}

function listarImpressoras() {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', 'Get-Printer | Select-Object -ExpandProperty Name'], { encoding: 'utf8', windowsHide: true })
  return (r.stdout || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean)
}

// Caminho real da Área de Trabalho (respeita redirecionamento do OneDrive).
function caminhoDesktop() {
  try {
    const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', "[Environment]::GetFolderPath('Desktop')"], { encoding: 'utf8', windowsHide: true })
    const p = (r.stdout || '').trim()
    if (p) return p
  } catch (e) {}
  return path.join(process.env.USERPROFILE || os.homedir(), 'Desktop')
}

// Cria/atualiza o atalho na pasta Inicializar do Windows, apontando pra `alvo`.
function criarAtalhoStartup(alvo) {
  try {
    if (!process.env.APPDATA) return
    const lnk = path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'ImpressoraFWC.lnk')
    const ps1 = path.join(DATA_DIR, 'autostart.ps1')
    const esc = s => s.replace(/'/g, "''")
    fs.writeFileSync(ps1, [
      `$w = New-Object -ComObject WScript.Shell`,
      `$s = $w.CreateShortcut('${esc(lnk)}')`,
      `$s.TargetPath = '${esc(alvo)}'`,
      `$s.Arguments = '--installed'`,
      `$s.WorkingDirectory = '${esc(path.dirname(alvo))}'`,
      `$s.Save()`,
    ].join('\r\n'))
    spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1], { stdio: 'ignore', windowsHide: true })
  } catch (e) {}
}

// AUTO-INSTALAÇÃO: quando o cliente roda o .exe baixado (Downloads etc.), ele se
// copia pra Área de Trabalho, cria o atalho de inicialização, abre a cópia
// instalada e sai. O arquivo baixado vira só um "instalador" (rodar de novo =
// reinstala/atualiza). Retorna true se instalou (o chamador deve encerrar).
function autoInstalar() {
  if (process.platform !== 'win32' || process.argv.includes('--debug') || process.argv.includes('--installed')) return false
  const eu = process.execPath
  const alvo = path.join(caminhoDesktop(), 'ImpressoraFWC.exe')
  if (path.normalize(eu).toLowerCase() === path.normalize(alvo).toLowerCase()) return false // já está no lugar certo
  try {
    // Para qualquer instância já instalada (pra poder sobrescrever/atualizar) — sem me matar.
    spawnSync('powershell.exe', ['-NoProfile', '-Command',
      `Get-CimInstance Win32_Process -Filter "Name='ImpressoraFWC.exe'" | Where-Object { $_.ProcessId -ne ${process.pid} } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`],
      { windowsHide: true })
    // Copia com algumas tentativas (a instância parada pode demorar a liberar o arquivo).
    let ok = false
    for (let i = 0; i < 6 && !ok; i++) {
      try { fs.copyFileSync(eu, alvo); ok = true } catch (e) { spawnSync('cmd.exe', ['/c', 'ping', '127.0.0.1', '-n', '2', '>nul'], { windowsHide: true }) }
    }
    if (!ok) return false
    criarAtalhoStartup(alvo)
    spawn(alvo, ['--installed'], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
    spawnSync('powershell.exe', ['-NoProfile', '-Command',
      "(New-Object -ComObject WScript.Shell).Popup('Impressora FWC instalada! Ja esta rodando escondida na Area de Trabalho e vai ligar junto com o Windows.',7,'Impressora FWC',64) | Out-Null"],
      { windowsHide: true })
    return true
  } catch (e) { return false }
}
const jaImpressos = new Set()
function imprimir(pedido) {
  const printer = config().printer
  if (!printer) { log('  ! sem impressora escolhida'); return }
  if (jaImpressos.has(pedido.id)) return
  jaImpressos.add(pedido.id)
  try {
    const bytes = montarCupom(pedido, empresa)
    const tmp = path.join(os.tmpdir(), 'fwc-cupom-' + pedido.id + '.bin')
    fs.writeFileSync(tmp, bytes)
    const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PS1_FILE, '-Printer', printer, '-File', tmp], { encoding: 'utf8', windowsHide: true })
    log('  -> impresso #' + (pedido.numero_pedido ?? pedido.id) + ' [' + ((r.stdout || '') + (r.stderr || '')).trim() + ']')
    try { fs.unlinkSync(tmp) } catch (e) {}
  } catch (e) { log('  -> ERRO imprimir: ' + e.message) }
}

// ---- conecta e escuta os pedidos da loja ----
async function iniciarEscuta() {
  const { data: sess } = await supabase.auth.getSession()
  if (!sess?.session) { sessionAtiva = false; log('Sem sessao — faca login na tela de configuracao.'); return false }
  sessionAtiva = true
  supabase.realtime.setAuth(sess.session.access_token)
  const uid = sess.session.user.id
  const { data: prof } = await supabase.from('profiles').select('empresa_id, nome').eq('id', uid).single()
  empresaId = prof?.empresa_id || config().empresa_id || null
  if (!empresaId) {
    // Conta de dono/super_admin (varias lojas) — precisa escolher qual loja
    const { data: emps } = await supabase.from('empresas').select('id, nome').order('nome')
    empresasDisponiveis = emps || []
    if (empresasDisponiveis.length === 1) { empresaId = empresasDisponiveis[0].id; setConfig({ empresa_id: empresaId }) }
    else { log('Escolha a loja na tela de configuracao (' + empresasDisponiveis.length + ' lojas).'); return false }
  }
  // Guarda a loja resolvida pra sobreviver ao refresh / reabrir o app.
  if (empresaId) setConfig({ empresa_id: empresaId })
  const { data: emp } = await supabase.from('empresas').select('nome, slug, endereco, numero, bairro, cidade, telefone_contato').eq('id', empresaId).single()
  empresa = emp || { nome: prof?.nome || 'Loja' }
  supabase.realtime.setAuth(sess.session.access_token)
  if (canal) { try { supabase.removeChannel(canal) } catch (e) {} }
  canal = supabase.channel('impressora-fwc-' + empresaId)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'pedidos_delivery', filter: 'empresa_id=eq.' + empresaId },
      payload => { const p = payload.new; log('NOVO PEDIDO #' + (p.numero_pedido ?? p.id) + ' - ' + (p.cliente_nome || '') + ' (' + (p.origem || '') + ')'); imprimir(p) })
    .subscribe(st => log('Conexao: ' + st + (st === 'SUBSCRIBED' ? ' — imprimindo pedidos novos automaticamente!' : '')))
  log('Loja: ' + (empresa?.nome || '—'))
  return true
}

// ---- tela de configuracao (localhost) ----
function paginaHtml() {
  const c = config()
  const imps = listarImpressoras()
  const opts = imps.map(i => `<option${i === c.printer ? ' selected' : ''}>${i}</option>`).join('')
  const empOpts = empresasDisponiveis.map(e => `<option value="${e.id}"${e.id === c.empresa_id ? ' selected' : ''}>${e.nome}</option>`).join('')
  // Card de escolher a impressora — aparece SEMPRE que estiver logado.
  const cardImpressora = `
<div class="card">
  <label>Impressora (escolha a sua)</label>
  <form method="POST" action="/printer">
    <select name="printer">${opts || '<option value="">(nenhuma encontrada)</option>'}</select>
    <button>Salvar impressora</button>
  </form>
  <div class="sub" style="margin:8px 0 0">Aparecem todas as impressoras instaladas neste PC. Escolha a térmica e clique em Salvar.</div>
  <form method="POST" action="/teste"><button style="background:#16a34a">Imprimir cupom de teste</button></form>
</div>`
  let bloco
  if (!sessionAtiva) {
    bloco = `
<div class="card">
  <div class="warn">Faca login com a conta da sua loja (a mesma do gestor).</div>
  <form method="POST" action="/login">
    <label>E-mail</label><input name="email" type="email" required>
    <label>Senha</label><input name="senha" type="password" required>
    <button>Entrar</button>
  </form>
</div>`
  } else {
    const cardStatus = `
<div class="card">
  <div class="ok">✓ Conectado</div>
  <div style="margin-top:6px">Loja: <span class="pill">${(empresa?.nome || '—')}</span></div>
  <div style="margin-top:6px">Impressora: <span class="pill">${c.printer || 'nenhuma'}</span></div>
  <form method="POST" action="/logout"><button style="background:#374151">Sair (trocar conta)</button></form>
</div>`
    const cardLoja = (!empresaId && empresasDisponiveis.length > 0) ? `
<div class="card">
  <div class="warn">Sua conta tem mais de uma loja. Escolha qual vai imprimir:</div>
  <form method="POST" action="/empresa">
    <label>Loja</label>
    <select name="empresa_id">${empOpts}</select>
    <button>Usar esta loja</button>
  </form>
</div>` : ''
    bloco = cardStatus + cardLoja + cardImpressora
  }
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Impressora FWC</title><style>
body{font-family:Segoe UI,Arial,sans-serif;background:#0f1420;color:#e5e7eb;margin:0;padding:24px;max-width:560px;margin:0 auto}
h1{font-size:22px;margin:0 0 4px}.sub{color:#9ca3af;margin:0 0 20px;font-size:13px}
.card{background:#1a2130;border:1px solid #2a3444;border-radius:12px;padding:18px;margin-bottom:16px}
label{display:block;font-size:13px;font-weight:700;margin:10px 0 4px}
input,select{width:100%;padding:10px;border-radius:8px;border:1px solid #2a3444;background:#0f1420;color:#e5e7eb;font-size:14px;box-sizing:border-box}
button{background:#7c3aed;color:#fff;border:none;border-radius:8px;padding:11px 16px;font-weight:800;cursor:pointer;font-size:14px;margin-top:12px}
.ok{color:#22c55e;font-weight:800}.warn{color:#f59e0b;font-weight:800}
.log{background:#0b0f18;border-radius:8px;padding:10px;font-family:Consolas,monospace;font-size:11.5px;height:180px;overflow:auto;white-space:pre-wrap;color:#94a3b8}
.pill{display:inline-block;background:#2a3444;border-radius:20px;padding:3px 10px;font-size:12px;font-weight:700}
</style></head><body>
<h1>🖨️ Impressora FWC</h1><p class="sub">Impressao automatica dos pedidos direto na sua impressora.</p>
${bloco}
<div class="card"><label>Atividade</label><div class="log" id="log">${logs.slice(-40).join('\n')}</div></div>
<script>
var _st=${JSON.stringify(estadoStr())};
setInterval(async()=>{try{
  const r=await fetch('/logs',{cache:'no-store'});const t=await r.text();const el=document.getElementById('log');if(el){el.textContent=t;el.scrollTop=el.scrollHeight}
  const rs=await fetch('/state',{cache:'no-store'});const s=await rs.text();if(s!==_st){location.reload()}
}catch(e){}},2000)</script>
</body></html>`
}
function body(req) { return new Promise(res => { let d = ''; req.on('data', c => d += c); req.on('end', () => { const o = {}; new URLSearchParams(d).forEach((v, k) => o[k] = v); res(o) }) }) }
// Corpo JSON (usado pela API que o gestor chama).
function jsonBody(req) { return new Promise(res => { let d = ''; req.on('data', c => d += c); req.on('end', () => { try { res(JSON.parse(d || '{}')) } catch (e) { res({}) } }) }) }
// Assinatura do estado — quando muda, a tela recarrega sozinha (fim da tela travada).
function estadoStr() { return JSON.stringify({ s: sessionAtiva, e: !!empresaId, p: config().printer || '', n: empresasDisponiveis.length }) }
// Estado completo pra API (gestor mostra tudo bonitinho por lá).
function statusObj() {
  return {
    logado: sessionAtiva,
    loja: empresa?.nome || null,
    empresaId: empresaId || null,
    empresas: empresasDisponiveis,
    impressora: config().printer || null,
    impressoras: sessionAtiva ? listarImpressoras() : [],
  }
}
// CORS + Private Network Access — libera o gestor (https) a falar com o app (localhost).
function cors(req, res) {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*')
  res.setHeader('Vary', 'Origin')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'content-type')
  res.setHeader('Access-Control-Allow-Private-Network', 'true')
}
function sendJson(res, obj) { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)) }

const server = http.createServer(async (req, res) => {
  try {
    // ── API JSON pro gestor (CORS liberado) ───────────────────────────────
    if (req.url.startsWith('/api/')) {
      cors(req, res)
      if (req.method === 'OPTIONS') { res.writeHead(204); return res.end() }
      if (req.method === 'GET' && req.url === '/api/status') return sendJson(res, statusObj())
      if (req.method === 'POST' && req.url === '/api/login') {
        const f = await jsonBody(req)
        const { error } = await supabase.auth.signInWithPassword({ email: (f.email || '').trim(), password: f.senha || '' })
        if (error) { log('Login falhou: ' + error.message); return sendJson(res, { ok: false, erro: error.message }) }
        log('Login OK: ' + f.email); await iniciarEscuta(); return sendJson(res, { ok: true, ...statusObj() })
      }
      if (req.method === 'POST' && req.url === '/api/empresa') {
        const f = await jsonBody(req); setConfig({ empresa_id: f.empresa_id }); empresaId = null; log('Loja escolhida.'); await iniciarEscuta()
        return sendJson(res, { ok: true, ...statusObj() })
      }
      if (req.method === 'POST' && req.url === '/api/printer') {
        const f = await jsonBody(req); setConfig({ printer: f.printer }); log('Impressora: ' + f.printer); return sendJson(res, { ok: true, ...statusObj() })
      }
      if (req.method === 'POST' && req.url === '/api/logout') {
        await supabase.auth.signOut(); empresaId = null; empresa = null; sessionAtiva = false; empresasDisponiveis = []
        setConfig({ empresa_id: null }); if (canal) { try { supabase.removeChannel(canal) } catch (e) {} } log('Desconectado.')
        return sendJson(res, { ok: true, ...statusObj() })
      }
      if (req.method === 'POST' && req.url === '/api/teste') {
        jaImpressos.delete('teste')
        imprimir({ id: 'teste', numero_pedido: '0000', cliente_nome: 'TESTE', tipo_entrega: 'retirada', origem: 'teste',
          itens: [{ nome: 'Cupom de teste', qtd: 1 }], subtotal: 0, total: 0, forma_pagamento: 'dinheiro' })
        return sendJson(res, { ok: true })
      }
      res.writeHead(404); return res.end('{}')
    }
    if (req.method === 'GET' && req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end(paginaHtml())
    }
    if (req.method === 'GET' && req.url === '/logs') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end(logs.slice(-40).join('\n'))
    }
    if (req.method === 'GET' && req.url === '/state') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); return res.end(estadoStr())
    }
    if (req.method === 'POST' && req.url === '/login') {
      const f = await body(req)
      const { error } = await supabase.auth.signInWithPassword({ email: (f.email || '').trim(), password: f.senha || '' })
      if (error) log('Login falhou: ' + error.message)
      else { log('Login OK: ' + f.email); await iniciarEscuta() }
    } else if (req.method === 'POST' && req.url === '/printer') {
      const f = await body(req); setConfig({ printer: f.printer }); log('Impressora: ' + f.printer)
    } else if (req.method === 'POST' && req.url === '/empresa') {
      const f = await body(req); setConfig({ empresa_id: f.empresa_id }); empresaId = null; log('Loja escolhida.'); await iniciarEscuta()
    } else if (req.method === 'POST' && req.url === '/logout') {
      await supabase.auth.signOut(); empresaId = null; empresa = null; sessionAtiva = false; empresasDisponiveis = []
      setConfig({ empresa_id: null }); if (canal) { try { supabase.removeChannel(canal) } catch (e) {} } log('Desconectado.')
    } else if (req.method === 'POST' && req.url === '/teste') {
      jaImpressos.delete('teste')
      imprimir({ id: 'teste', numero_pedido: '0000', cliente_nome: 'TESTE', tipo_entrega: 'retirada', origem: 'teste',
        itens: [{ nome: 'Cupom de teste', qtd: 1 }], subtotal: 0, total: 0, forma_pagamento: 'dinheiro' })
    }
    res.writeHead(302, { Location: '/' }); res.end()
  } catch (e) { res.writeHead(500); res.end(String(e.message)) }
})
// Uma instância só: se a porta já está em uso, outro app FWC já roda — sai quieto.
server.on('error', e => { if (e && e.code === 'EADDRINUSE') process.exit(0) })
server.listen(PORT, '127.0.0.1', () => {
  log('=== Impressora FWC ===')
  log('Configuracao: http://localhost:' + PORT)
  criarAtalhoStartup(process.execPath)  // mantém o "ligar com o Windows" no lugar certo
  iniciarEscuta()                       // conecta e escuta os pedidos
})
