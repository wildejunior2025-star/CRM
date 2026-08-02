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
const { montarCupom, montarTexto, montarComandaMesa, LARGURA } = require('./cupom')

// Node empacotado (pkg) nao tem WebSocket nativo — a lib realtime do Supabase
// precisa. Injeta o 'ws' como implementacao global.
const WS = require('ws')
if (!globalThis.WebSocket) globalThis.WebSocket = WS

const SUPABASE_URL = 'https://ycytrsqdvrviihkqfvno.supabase.co'
const ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InljeXRyc3FkdnJ2aWloa3Fmdm5vIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODExMjc1NDcsImV4cCI6MjA5NjcwMzU0N30.zAq-8gaw2U9wvwBJCX_rK2jP-tnjOL5VPS23fFxf2Zc'
const PORT = 9110

// Auto-atualização: a cada release eu subo o .exe novo E o impressora-version.json
// com o número novo. Este app compara e, se tiver versão maior, baixa e se instala
// sozinho (silencioso). BUMP a cada mudança no app.
const APP_VERSION = 18
const FWC_EXE_URL = SUPABASE_URL + '/storage/v1/object/public/downloads/ImpressoraFWC.exe'
const FWC_VERSION_URL = SUPABASE_URL + '/storage/v1/object/public/downloads/impressora-version.json'

// Pasta de dados (grava mesmo com o .exe em Program Files)
const DATA_DIR = path.join(process.env.APPDATA || os.homedir(), 'ImpressoraFWC')
try { fs.mkdirSync(DATA_DIR, { recursive: true }) } catch (e) {}

// Se está rodando de fora do lugar instalado (ex.: baixado na Downloads), se
// instala na Área de Trabalho e sai. (definições das funções mais abaixo)
if (autoInstalar()) process.exit(0)

const SESSION_FILE = path.join(DATA_DIR, 'session.json')
const CONFIG_FILE = path.join(DATA_DIR, 'config.json')
const PS1_FILE = path.join(DATA_DIR, 'print-raw.ps1')
const IMPRESSOS_FILE = path.join(DATA_DIR, 'impressos.json') // dedupe persistente (sobrevive a reinicio)

// ---- estado ----
const logs = []
function log(...a) {
  const s = new Date().toLocaleTimeString('pt-BR') + ' ' + a.join(' ')
  console.log(s)
  logs.push(s); if (logs.length > 200) logs.shift()
}
let empresa = null, empresaId = null, canal = null
let sessionAtiva = false, empresasDisponiveis = []

// ---- classificação bebida x comida (roteamento cozinha/bar) ----
let mapaCategoria = {}     // norm(nome do produto) -> categoria
let catBebida = new Set()  // categorias tratadas como "bebida" (vão pra impressora do bar)
const KW_BEBIDA = ['refriger', 'suco', 'bebid', 'cerveja', 'agua', 'drink', 'tonic', 'energetic', 'chopp', 'vinho', 'destilad', 'whisky', 'cachaca', 'caipir', 'gin', 'vodka', 'licor']
function norm(s) { return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim() }
// Carrega os produtos/categorias da loja pra saber o que é bebida (pra rotear).
async function carregarCategorias() {
  mapaCategoria = {}; catBebida = new Set()
  try {
    const { data: prods } = await supabase.from('produtos').select('nome, categoria').eq('empresa_id', empresaId)
    for (const p of (prods || [])) if (p && p.nome) mapaCategoria[norm(p.nome)] = p.categoria || ''
    const { data: cats } = await supabase.from('categorias').select('nome').eq('empresa_id', empresaId)
    const extra = (config().categoriasBebida || []).map(norm)   // override opcional (nomes de categoria)
    for (const c of (cats || [])) {
      const n = norm(c.nome)
      if (KW_BEBIDA.some(k => n.includes(k)) || extra.includes(n)) catBebida.add(c.nome)
    }
    log('Categorias carregadas (bebida: ' + ([...catBebida].join(', ') || 'nenhuma') + ')')
  } catch (e) { log('  ! erro ao carregar categorias: ' + e.message) }
}
// Um item é "bebida" se a categoria do seu produto está marcada como bebida.
function ehBebida(nome) {
  const cat = mapaCategoria[norm(nome)]
  return cat ? catBebida.has(cat) : false
}
const config = () => { try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) } catch (e) { return {} } }
const setConfig = o => fs.writeFileSync(CONFIG_FILE, JSON.stringify({ ...config(), ...o }, null, 2))

// ---- filtro: o que ESTE computador imprime (por origem) ----
// Cada PC/impressora escolhe o que sai nele. Sem config = imprime tudo (padrao,
// nao muda nada pras lojas antigas). Uma origem so deixa de imprimir se estiver
// explicitamente desligada (=== false).
const ORIGENS_FILTRAVEIS = ['whatsapp', 'cardapio', 'app', 'balcao', 'ifood', 'mesa']
function origemLigada(origem) {
  const f = config().filtros
  if (!f) return true
  const k = String(origem || '').toLowerCase()
  if (!ORIGENS_FILTRAVEIS.includes(k)) return true  // origem desconhecida / teste = sempre imprime
  return f[k] !== false
}

// ---- storage de sessao em arquivo (auto-refresh do Supabase) ----
const fileStorage = {
  getItem: (k) => { try { return JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'))[k] ?? null } catch (e) { return null } },
  setItem: (k, v) => { let o = {}; try { o = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8')) } catch (e) {} o[k] = v; fs.writeFileSync(SESSION_FILE, JSON.stringify(o)) },
  removeItem: (k) => { let o = {}; try { o = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8')) } catch (e) {} delete o[k]; fs.writeFileSync(SESSION_FILE, JSON.stringify(o)) },
}
const supabase = createClient(SUPABASE_URL, ANON_KEY, {
  auth: { storage: fileStorage, persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
  // heartbeat curto mantém o WebSocket vivo (evita a conexão cair por inatividade
  // atrás de firewall/NAT e os pedidos chegarem atrasados em lote).
  realtime: { transport: WS, heartbeatIntervalMs: 15000 },
})
const APP_START = Date.now() // pra o backup só olhar pedidos DESTE turno (não reimprime antigos)

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
  const ps = (cmd) => {
    try {
      const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', cmd], { encoding: 'utf8', windowsHide: true })
      return (r.stdout || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean)
    } catch (e) { return [] }
  }
  // Tenta várias formas — Windows novo/antigo, política restrita, impressora USB.
  let l = ps('Get-Printer | Select-Object -ExpandProperty Name')
  if (l.length) return l
  l = ps('Get-CimInstance Win32_Printer | Select-Object -ExpandProperty Name')
  if (l.length) return l
  l = ps('Get-WmiObject Win32_Printer | Select-Object -ExpandProperty Name')
  if (l.length) return l
  try {
    const r = spawnSync('wmic', ['printer', 'get', 'name'], { encoding: 'utf8', windowsHide: true })
    l = (r.stdout || '').split(/\r?\n/).map(s => s.trim()).filter(s => s && s.toLowerCase() !== 'name')
  } catch (e) { l = [] }
  return l
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
    // Instalação normal mostra o aviso; auto-atualização é silenciosa.
    if (!process.argv.includes('--auto-update')) {
      spawnSync('powershell.exe', ['-NoProfile', '-Command',
        "(New-Object -ComObject WScript.Shell).Popup('Impressora FWC instalada! Ja esta rodando escondida na Area de Trabalho e vai ligar junto com o Windows.',7,'Impressora FWC',64) | Out-Null"],
        { windowsHide: true })
    }
    return true
  } catch (e) { return false }
}
const jaImpressos = new Set()

// Checa se saiu versão nova no bucket; se sim, baixa o .exe e roda ele —
// o baixado (autoInstalar) para esta instância, se copia pro Desktop e reabre.
let atualizando = false
// checa (e baixa) atualização. manual=true → dispara pelo botão do gestor (ignora o
// guard de --debug) e RETORNA o resultado pra mostrar na tela. Auto ignora o retorno.
async function checarAtualizacao(manual = false) {
  if (atualizando) return { ok: false, atualizando: true, erro: 'ja atualizando' }
  if (!manual && process.argv.includes('--debug')) return { ok: false }
  try {
    const r = await fetch(FWC_VERSION_URL + '?t=' + Date.now(), { cache: 'no-store' })
    if (!r.ok) return { ok: false, erro: 'sem version.json' }
    const j = await r.json().catch(() => null)
    const ultima = Number(j && j.version)
    if (!ultima) return { ok: false, erro: 'version.json invalido' }
    if (ultima <= APP_VERSION) return { ok: true, atualizado: true, atual: APP_VERSION, disponivel: ultima }
    log('Atualizacao v' + ultima + ' disponivel (tenho v' + APP_VERSION + ') — baixando...')
    const rr = await fetch(FWC_EXE_URL + '?t=' + Date.now(), { cache: 'no-store' })
    if (!rr.ok) return { ok: false, erro: 'falha ao baixar exe' }
    const buf = Buffer.from(await rr.arrayBuffer())
    if (buf.length < 5000000) { log('  exe baixado suspeito (' + buf.length + ' bytes) — ignorei'); return { ok: false, erro: 'exe invalido' } }
    atualizando = true
    const tmp = path.join(os.tmpdir(), 'ImpressoraFWC-update.exe')
    fs.writeFileSync(tmp, buf)
    log('  baixado ' + buf.length + ' bytes — instalando atualizacao (silenciosa)...')
    spawn(tmp, ['--auto-update'], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
    // o baixado vai matar esta instância; saio por garantia depois de um tempinho.
    setTimeout(() => process.exit(0), 4000)
    return { ok: true, baixando: true, atual: APP_VERSION, disponivel: ultima }
  } catch (e) { log('Falha ao checar atualizacao: ' + (e && e.message)); return { ok: false, erro: (e && e.message) || 'erro' } }
}

// Envia bytes ESC/POS pra impressora escolhida. Retorna true se conseguiu mandar.
function imprimirBytes(bytes, nome, printerOverride) {
  const printer = printerOverride || config().printer
  if (!printer) { log('  ! sem impressora escolhida'); return false }
  const tmp = path.join(os.tmpdir(), 'fwc-' + (nome || 'doc') + '.bin')
  try { fs.writeFileSync(tmp, bytes) } catch (e) { log('  -> ERRO gravar tmp: ' + e.message); return false }

  // Método 1: WritePrinter via PowerShell/C# (funciona na maioria dos PCs).
  let ok = false
  try {
    const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PS1_FILE, '-Printer', printer, '-File', tmp], { encoding: 'utf8', windowsHide: true })
    const out = ((r.stdout || '') + (r.stderr || '')).replace(/\s+/g, ' ').trim()
    ok = /(^|\W)OK(\W|$)/.test(r.stdout || '') && !/erro|error|falha|80070002/i.test(out)
    log('  -> metodo1 ' + (nome || '') + ': ' + (ok ? 'OK' : 'FALHOU') + ' [' + out.slice(0, 110) + ']')
  } catch (e) { log('  -> metodo1 excecao: ' + e.message) }

  // Método 2 (fallback SEM PowerShell): compartilha a impressora e copia RAW pro
  // share via CMD. Necessário em PCs onde o PowerShell está quebrado (erro 80070002).
  if (!ok) {
    try {
      const share = 'FWC' + String(printer).replace(/[^A-Za-z0-9]/g, '').slice(0, 8).toUpperCase()
      spawnSync('rundll32', ['printui.dll,PrintUIEntry', '/Xs', '/n', printer, 'attributes', '+shared', 'sharename', share], { windowsHide: true })
      const r2 = spawnSync('cmd', ['/c', 'copy', '/b', tmp, '\\\\localhost\\' + share], { encoding: 'utf8', windowsHide: true })
      const out2 = ((r2.stdout || '') + (r2.stderr || '')).replace(/\s+/g, ' ').trim()
      ok = r2.status === 0 && !/0 arquivo|0 file/i.test(out2)
      log('  -> metodo2 (cmd/share) ' + (nome || '') + ': ' + (ok ? 'OK' : 'FALHOU') + ' [' + out2.slice(0, 110) + ']')
    } catch (e) { log('  -> metodo2 excecao: ' + e.message) }
  }

  try { fs.unlinkSync(tmp) } catch (e) {}
  return ok
}
function imprimir(pedido) {
  if (jaImpressos.has(pedido.id)) return
  jaImpressos.add(pedido.id)
  imprimirCupomPedido(pedido)
}
// Cupom COMPLETO sempre na cozinha (impressora principal). Se houver impressora
// de bar configurada, manda também um ticket só das bebidas pra ela.
function imprimirCupomPedido(pedido) {
  imprimirBytes(montarCupom(pedido, empresa), 'cupom-' + pedido.id)
  const bar = config().printerBar
  if (!bar) return
  const bebidas = (Array.isArray(pedido.itens) ? pedido.itens : []).filter(it => ehBebida(it.nome))
  if (!bebidas.length) return
  const linhas = bebidas.map(it => (it.quantidade ?? it.qtd ?? 1) + 'x ' + (it.nome || 'Item'))
  imprimirBytes(montarTexto(linhas, 'BEBIDAS #' + (pedido.numero_pedido ?? String(pedido.id).slice(-4))), 'bar-' + pedido.id, bar)
}
// HTML (cozinha/conta de mesa) -> linhas de texto pra térmica.
const SEP = '\x01' // marca interna: separa as 2 colunas (nome | valor) de uma linha
function htmlParaLinhas(html) {
  let s = String(html || '')
  // Remove blocos <style>/<script>/<head> INTEIROS (com conteúdo) — senão o CSS
  // sai impresso como texto na térmica.
  s = s.replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<head[\s\S]*?<\/head>/gi, '')
  // Linhas de 2 colunas (nome à esquerda, valor à direita): <div ...><span>A</span><span>B</span></div>.
  // Vira "A" + SEP + "B" numa linha só, pra depois alinhar o valor à direita (senão gruda: "ItemR$X").
  s = s.replace(/<div[^>]*>\s*<span>([\s\S]*?)<\/span>\s*<span>([\s\S]*?)<\/span>\s*<\/div>/gi,
    (m, a, b) => '\n' + a.replace(/<[^>]+>/g, '') + SEP + b.replace(/<[^>]+>/g, '') + '\n')
  s = s.replace(/<\s*(br|\/p|\/div|\/tr|\/h[1-6]|\/li)\s*>/gi, '\n').replace(/<[^>]+>/g, '')
  s = s.replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
  return s.split('\n').map(l => {
    if (l.includes(SEP)) {
      const [a, b] = l.split(SEP)
      const A = String(a).replace(/[ \t]+/g, ' ').trim()
      const B = String(b).replace(/[ \t]+/g, ' ').trim()
      const espacos = Math.max(1, LARGURA - A.length - B.length)
      return A + ' '.repeat(espacos) + B
    }
    return l.replace(/[ \t]+/g, ' ').trim()
  }).filter(Boolean)
}

// Imprime um pedido uma única vez (evita 2ª via quando chegam vários updates do
// mesmo pedido). O dedupe é PERSISTENTE: sobrevive a reinício do app, senão o
// próximo update automático do iFood (polling de 30s) reimprimiria a comanda.
function carregarImpressos() {
  try { const a = JSON.parse(fs.readFileSync(IMPRESSOS_FILE, 'utf8')); return new Set(Array.isArray(a) ? a : []) }
  catch (e) { return new Set() }
}
const pedidosImpressos = carregarImpressos()
function marcarImpresso(id) {
  pedidosImpressos.add(id)
  // Mantém só os últimos ~1500 IDs (não deixa o arquivo/memória crescer sem fim).
  if (pedidosImpressos.size > 2000) {
    const arr = [...pedidosImpressos].slice(-1500)
    pedidosImpressos.clear(); for (const x of arr) pedidosImpressos.add(x)
  }
  try { fs.writeFileSync(IMPRESSOS_FILE, JSON.stringify([...pedidosImpressos])) } catch (e) {}
}
function imprimirPedido(p) {
  if (!p || pedidosImpressos.has(p.id)) return
  if (!origemLigada(p.origem)) { log('  (' + (p.origem || '?') + ' DESLIGADO nesta impressora — nao imprimiu #' + (p.numero_pedido ?? p.id) + ')'); return }
  log('NOVO PEDIDO #' + (p.numero_pedido ?? p.id) + ' - ' + (p.cliente_nome || '') + ' (' + (p.origem || '') + ')')
  if (config().pausado) { log('  (impressao automatica PAUSADA — nao imprimiu)'); return }
  marcarImpresso(p.id)
  imprimir(p)
}

// ---- pedidos de MESA (comandas) — imprime na cozinha automaticamente ----
// Os itens de um mesmo envio do cliente chegam quase juntos; junta num cupom só
// (com o número da mesa) usando um pequeno atraso, igual o gestor faz.
const comandaBuf = new Map()            // comanda_id -> { itens:[], timer }
const comandaItensImpressos = new Set() // dedupe por id de item (reconexão)
// Busca os dados extras da comanda pro cabeçalho da cozinha (salão, atendente, pessoas).
async function infoComandaMesa(cid) {
  const info = { numero: '?', area: '', atendente: '', pessoas: 0 }
  try {
    const { data: c } = await supabase.from('comandas')
      .select('numero_mesa, num_pessoas, garcom_id, mesa_id').eq('id', cid).maybeSingle()
    if (c) {
      if (c.numero_mesa != null) info.numero = c.numero_mesa
      info.pessoas = c.num_pessoas || 0
      if (c.garcom_id) {
        const { data: g } = await supabase.from('profiles').select('nome').eq('id', c.garcom_id).maybeSingle()
        if (g?.nome) info.atendente = String(g.nome).split(' ')[0]  // primeiro nome
      }
      if (c.mesa_id) {
        const { data: m } = await supabase.from('mesas').select('nome').eq('id', c.mesa_id).maybeSingle()
        if (m?.nome) info.area = m.nome
      }
    }
  } catch (e) { /* segue com o que tiver */ }
  return info
}

// Monta a comanda de mesa em ESC/POS pra COZINHA (nome da loja, mesa+salão, data/hora,
// atendente, pessoas, itens grandes com espaço, rodapé da loja). Usada no automático e
// no botão manual do gestor (/api/imprimir-mesa) — mesmo visual.
function comandaMesaBytes(numero, itens, nomeLoja, opts) {
  const o = opts || {}
  return montarComandaMesa({
    nomeLoja, numero, itens,
    area: o.area || '', atendente: o.atendente || '', pessoas: o.pessoas || 0,
    rodape: o.rodape || empresa?.rodape_cozinha || '', sufixo: o.sufixo || '',
  })
}
async function imprimirComandaMesa(cid, itens) {
  const info = await infoComandaMesa(cid)
  const numero = info.numero
  const base = { area: info.area, atendente: info.atendente, pessoas: info.pessoas }
  const nomeLoja = empresa?.nome || ''
  const bar = config().printerBar
  if (bar) {
    const comida = itens.filter(it => !ehBebida(it.nome))
    const bebida = itens.filter(it => ehBebida(it.nome))
    if (comida.length) imprimirBytes(comandaMesaBytes(numero, comida, nomeLoja, base), 'mesa-' + cid)
    if (bebida.length) imprimirBytes(comandaMesaBytes(numero, bebida, nomeLoja, { ...base, sufixo: ' - BEBIDAS' }), 'mesa-bar-' + cid, bar)
    return
  }
  imprimirBytes(comandaMesaBytes(numero, itens, nomeLoja, base), 'mesa-' + cid)
}
function agendarComandaMesa(it) {
  if (!it || (it.status && it.status !== 'pendente')) return
  if (!origemLigada('mesa')) return // respeita o filtro "Mesa" deste PC (tempo real E backup)
  if (comandaItensImpressos.has(it.id)) return
  comandaItensImpressos.add(it.id)
  if (comandaItensImpressos.size > 2000) comandaItensImpressos.clear()
  if (config().pausado) { log('  (mesa PAUSADA — nao imprimiu)'); return }
  const cid = it.comanda_id
  let e = comandaBuf.get(cid)
  if (!e) { e = { itens: [], timer: null }; comandaBuf.set(cid, e) }
  e.itens.push(it)
  clearTimeout(e.timer)
  e.timer = setTimeout(() => {
    const entry = comandaBuf.get(cid); comandaBuf.delete(cid)
    if (entry && entry.itens.length) {
      log('MESA — ' + entry.itens.length + ' item(ns) na comanda ' + String(cid).slice(0, 8))
      imprimirComandaMesa(cid, entry.itens)
    }
  }, 800) // espera curta só pra juntar itens do mesmo envio; imprime rápido
}

// ---- backup: verifica pedidos a cada 12s (rede de seguranca caso o tempo real
// atrase/caia). Só olha pedidos DESTE turno (created_at >= APP_START) pra nao
// reimprimir os antigos ao ligar. O dedup (mesmos Sets do tempo real) evita 2 vias.
async function verificarPendentes() {
  if (!empresaId || !sessionAtiva || config().pausado) return
  const since = new Date(Math.max(APP_START, Date.now() - 5 * 60 * 1000)).toISOString()
  try {
    const { data: its } = await supabase.from('comanda_itens').select('*')
      .eq('empresa_id', empresaId).eq('status', 'pendente').gte('created_at', since)
    for (const it of (its || [])) if (!comandaItensImpressos.has(it.id)) agendarComandaMesa(it)
    const { data: peds } = await supabase.from('pedidos_delivery').select('*')
      .eq('empresa_id', empresaId).gte('created_at', since)
    for (const p of (peds || [])) {
      if (p.status === 'aguardando_pagamento' || p.status === 'entregue' || p.status === 'cancelado') continue
      if (!pedidosImpressos.has(p.id)) imprimirPedido(p)
    }
  } catch (e) { /* silencioso — proxima rodada tenta de novo */ }
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
  const { data: emp } = await supabase.from('empresas').select('nome, slug, endereco, numero, bairro, cidade, telefone_contato, rodape_cozinha, chave_pix, pix_nome').eq('id', empresaId).single()
  empresa = emp || { nome: prof?.nome || 'Loja' }
  await carregarCategorias()   // pra saber o que é bebida (roteamento cozinha/bar)
  supabase.realtime.setAuth(sess.session.access_token)
  if (canal) { try { supabase.removeChannel(canal) } catch (e) {} }
  canal = supabase.channel('impressora-fwc-' + empresaId)
    // Pedido novo — imprime na hora, MENOS se for PIX ainda não pago.
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'pedidos_delivery', filter: 'empresa_id=eq.' + empresaId },
      payload => {
        const p = payload.new
        if (p.status === 'aguardando_pagamento') {
          log('PIX pendente #' + (p.numero_pedido ?? p.id) + ' — aguardando pagamento, NAO imprimiu')
          return
        }
        imprimirPedido(p)
      })
    // Pedido mudou de status — imprime quando o PIX for confirmado (deixa de ser
    // 'aguardando_pagamento' e vira pedido de verdade). Dedupe evita 2ª via.
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'pedidos_delivery', filter: 'empresa_id=eq.' + empresaId },
      payload => {
        const p = payload.new
        if (p.status === 'aguardando_pagamento') return
        if (p.status === 'entregue' || p.status === 'cancelado') return
        imprimirPedido(p)
      })
    // Pedido de MESA (comanda) — cada item novo vira cupom de cozinha (juntando o envio).
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'comanda_itens', filter: 'empresa_id=eq.' + empresaId },
      payload => { if (!origemLigada('mesa')) return; agendarComandaMesa(payload.new) })
    .subscribe(st => log('Conexao: ' + st + (st === 'SUBSCRIBED' ? ' — imprimindo pedidos (delivery + mesa) automaticamente!' : '')))
  log('Loja: ' + (empresa?.nome || '—'))
  return true
}

// ---- tela de configuracao (localhost) ----
function paginaHtml() {
  const c = config()
  const imps = listarImpressoras()
  const opts = imps.map(i => `<option${i === c.printer ? ' selected' : ''}>${i}</option>`).join('')
  const optsBar = `<option value=""${!c.printerBar ? ' selected' : ''}>(nenhuma — tudo na cozinha)</option>` + imps.map(i => `<option${i === c.printerBar ? ' selected' : ''}>${i}</option>`).join('')
  const empOpts = empresasDisponiveis.map(e => `<option value="${e.id}"${e.id === c.empresa_id ? ' selected' : ''}>${e.nome}</option>`).join('')
  // Card de escolher a impressora — aparece SEMPRE que estiver logado.
  const semLista = imps.length === 0
  const cardImpressora = `
<div class="card">
  <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-weight:800;font-size:14px;margin:0 0 4px">
    <input type="checkbox" id="duasImp" style="width:auto"${c.printerBar ? ' checked' : ''}> Usar 2 impressoras (cozinha e bar separados)
  </label>
  <div class="sub" style="margin:0 0 10px">Desmarcado = <b>tudo sai numa impressora só</b>. Marque só se tiver uma impressora separada pro bar.</div>
  <form method="POST" action="/printer">
    <label id="lblCoz">Impressora (tudo sai aqui)</label>
    <select name="printer">${opts || '<option value="">(nenhuma encontrada)</option>'}</select>
    <div id="rowBar" style="display:${c.printerBar ? 'block' : 'none'}">
      <label>Impressora do BAR (bebidas)</label>
      <select name="printerBar">${optsBar}</select>
    </div>
    ${semLista ? `<label style="margin-top:10px">Nenhuma impressora foi detectada — digite o nome EXATO</label>
    <input name="printerManual" placeholder="Ex.: POS-80 / Generic / EPSON TM-T20"
      value="${(c.printer || '').replace(/"/g, '&quot;')}" style="width:100%;padding:9px;border-radius:8px;border:1px solid #2a3444;background:#0f1420;color:#e5e7eb">` : ''}
    <button>Salvar impressora</button>
  </form>
  <div class="sub" style="margin:8px 0 0">${semLista ? '⚠️ Nenhuma impressora foi detectada. Copie o nome EXATO (Windows: Configurações → Impressoras) e cole no campo acima.' : 'Com 2 impressoras: as <b>bebidas</b> saem no bar e a <b>comida</b> na cozinha.'}</div>
  <form method="POST" action="/teste"><button style="background:#16a34a">Imprimir cupom de teste</button></form>
  <script>(function(){var cb=document.getElementById('duasImp'),row=document.getElementById('rowBar'),lbl=document.getElementById('lblCoz');if(!cb)return;function u(){var on=cb.checked;row.style.display=on?'block':'none';lbl.textContent=on?'Impressora da COZINHA (comida)':'Impressora (tudo sai aqui)';if(!on){var s=row.querySelector('select');if(s)s.value='';}}cb.addEventListener('change',u);u();})();</script>
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
  <div style="margin-top:6px;font-size:12px;color:#9ca3af">Versão do app: <b>v${APP_VERSION}</b></div>
  <form method="POST" action="/atualizar" onsubmit="this.querySelector('button').textContent='⏳ Buscando atualização... o app reinicia sozinho se tiver versão nova.'">
    <button style="background:#2563eb">↻ Atualizar app agora</button>
  </form>
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
    const Ff = config().filtros || {}
    const tg = (k, lbl) => `<label class="tg"><span>${lbl}</span><input type="checkbox" name="${k}"${Ff[k] === false ? '' : ' checked'}></label>`
    const cardFiltros = `
<div class="card">
  <label style="font-size:14px">O que ESTE computador imprime</label>
  <div class="sub" style="margin:2px 0 10px">Ligue so o que deve sair NESTA impressora. Ex.: PC da cozinha = so Mesa; PC do delivery = tudo menos Mesa.</div>
  <form method="POST" action="/filtros">
    ${tg('mesa', 'Mesa (comandas)')}
    ${tg('whatsapp', 'WhatsApp')}
    ${tg('ifood', 'iFood')}
    ${tg('balcao', 'Balcao')}
    ${tg('cardapio', 'Cardapio (loja online)')}
    ${tg('app', 'App')}
    <button>Salvar o que imprime</button>
  </form>
</div>`
    bloco = cardStatus + cardLoja + cardImpressora + cardFiltros
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
.tg{display:flex;align-items:center;justify-content:space-between;padding:11px 2px;border-bottom:1px solid #232c3a;font-size:15px;font-weight:600;margin:0}
.tg:last-of-type{border-bottom:none}
.tg input{appearance:none;-webkit-appearance:none;width:46px;height:26px;border-radius:20px;background:#2a3444;position:relative;cursor:pointer;flex:0 0 auto;margin:0;transition:.2s}
.tg input:checked{background:#7c3aed}
.tg input::after{content:"";position:absolute;top:3px;left:3px;width:20px;height:20px;border-radius:50%;background:#fff;transition:.2s}
.tg input:checked::after{left:23px}
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
    versao: APP_VERSION,
    logado: sessionAtiva,
    loja: empresa?.nome || null,
    empresaId: empresaId || null,
    empresas: empresasDisponiveis,
    impressora: config().printer || null,
    impressoraBar: config().printerBar || null,
    impressoras: sessionAtiva ? listarImpressoras() : [],
    pausado: !!config().pausado,
    filtros: config().filtros || null,   // o que este PC imprime (null = tudo)
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
      // Botão "Atualizar agora" do gestor — checa/baixa a versão nova na hora.
      if (req.method === 'POST' && req.url === '/api/atualizar') {
        return sendJson(res, await checarAtualizacao(true))
      }
      if (req.method === 'POST' && req.url === '/api/login') {
        const f = await jsonBody(req)
        const { error } = await supabase.auth.signInWithPassword({ email: (f.email || '').trim(), password: f.senha || '' })
        if (error) { log('Login falhou: ' + error.message); return sendJson(res, { ok: false, erro: error.message }) }
        log('Login OK: ' + f.email); await iniciarEscuta(); return sendJson(res, { ok: true, ...statusObj() })
      }
      // Adota a sessão do gestor (o usuário já está logado no navegador) — sem digitar login.
      if (req.method === 'POST' && req.url === '/api/adotar-sessao') {
        const f = await jsonBody(req)
        if (!f.access_token || !f.refresh_token) return sendJson(res, { ok: false, erro: 'sem sessão' })
        const { error } = await supabase.auth.setSession({ access_token: f.access_token, refresh_token: f.refresh_token })
        if (error) { log('Adotar sessão falhou: ' + error.message); return sendJson(res, { ok: false, erro: error.message }) }
        if (f.empresa_id) setConfig({ empresa_id: f.empresa_id })
        log('Sessão do gestor adotada.'); await iniciarEscuta(); return sendJson(res, { ok: true, ...statusObj() })
      }
      if (req.method === 'POST' && req.url === '/api/empresa') {
        const f = await jsonBody(req); setConfig({ empresa_id: f.empresa_id }); empresaId = null; log('Loja escolhida.'); await iniciarEscuta()
        return sendJson(res, { ok: true, ...statusObj() })
      }
      // Imprime/reimprime um pedido (cupom) mandado pelo gestor.
      if (req.method === 'POST' && req.url === '/api/imprimir') {
        const f = await jsonBody(req)
        if (!f.pedido) return sendJson(res, { ok: false, erro: 'sem pedido' })
        // Automatico (pedido novo vindo do navegador): passa pelo MESMO dedupe do
        // tempo real — se o app ja imprimiu esse pedido, NAO bate 2a via (era isso
        // que dobrava a comanda do iFood). Manual (botao reimprimir): sem f.auto,
        // forca a impressao como sempre.
        if (f.auto) {
          if (pedidosImpressos.has(f.pedido.id)) return sendJson(res, { ok: true, jaImpresso: true })
          imprimirPedido(f.pedido)
          return sendJson(res, { ok: true })
        }
        jaImpressos.delete(f.pedido.id) // permite reimprimir
        const ok = imprimirBytes(montarCupom(f.pedido, empresa), 'cupom-' + (f.pedido.id || 're'))
        // roteia bebidas pro bar também (se configurado)
        try { const bar = config().printerBar; if (bar) { const bs = (Array.isArray(f.pedido.itens) ? f.pedido.itens : []).filter(it => ehBebida(it.nome)); if (bs.length) imprimirBytes(montarTexto(bs.map(it => (it.quantidade ?? it.qtd ?? 1) + 'x ' + (it.nome || 'Item')), 'BEBIDAS'), 'bar-re', bar) } } catch (e) {}
        return sendJson(res, { ok, erro: ok ? undefined : 'sem impressora' })
      }
      // Imprime um HTML (conta de mesa etc.) como texto na térmica.
      if (req.method === 'POST' && req.url === '/api/imprimir-html') {
        const f = await jsonBody(req)
        // Respeita o filtro por origem (ex.: conta da mesa vem com origem:'mesa').
        if (f.origem && !origemLigada(f.origem)) { log('  (' + f.origem + ' DESLIGADO — nao imprimiu ' + (f.titulo || 'doc') + ')'); return sendJson(res, { ok: true, filtrado: true }) }
        const ok = imprimirBytes(montarTexto(htmlParaLinhas(f.html || ''), f.titulo), 'doc')
        return sendJson(res, { ok, erro: ok ? undefined : 'sem impressora' })
      }
      // Comanda de MESA nativa (nome da loja + MESA grandes, data, itens com valor).
      // Usada pelo botão manual do gestor pra sair igual ao automático.
      if (req.method === 'POST' && req.url === '/api/imprimir-mesa') {
        const f = await jsonBody(req)
        const nomeLoja = f.nomeLoja || empresa?.nome || ''
        const itens = Array.isArray(f.itens) ? f.itens : []
        // Busca salão/atendente/pessoas se o gestor mandou o comandaId (mesmo visual do auto).
        const info = f.comandaId ? await infoComandaMesa(f.comandaId) : { numero: f.numeroMesa, area: '', atendente: '', pessoas: 0 }
        const numero = info.numero != null && info.numero !== '?' ? info.numero : f.numeroMesa
        const base = { area: info.area, atendente: info.atendente, pessoas: info.pessoas }
        const bar = config().printerBar
        let ok = false
        if (bar) {
          const comida = itens.filter(it => !ehBebida(it.nome))
          const bebida = itens.filter(it => ehBebida(it.nome))
          if (comida.length) ok = imprimirBytes(comandaMesaBytes(numero, comida, nomeLoja, base), 'mesa-man')
          if (bebida.length) imprimirBytes(comandaMesaBytes(numero, bebida, nomeLoja, { ...base, sufixo: ' - BEBIDAS' }), 'mesa-man-bar', bar)
        } else {
          ok = imprimirBytes(comandaMesaBytes(numero, itens, nomeLoja, base), 'mesa-man')
        }
        return sendJson(res, { ok, erro: ok ? undefined : 'sem impressora' })
      }
      // Liga/pausa a impressão automática (atalho do topo do gestor).
      if (req.method === 'POST' && req.url === '/api/pausar') {
        const f = await jsonBody(req)
        setConfig({ pausado: !!f.pausado })
        log(f.pausado ? 'Impressao automatica PAUSADA.' : 'Impressao automatica LIGADA.')
        return sendJson(res, { ok: true, ...statusObj() })
      }
      if (req.method === 'POST' && req.url === '/api/printer') {
        const f = await jsonBody(req)
        const printer = (f.printerManual && String(f.printerManual).trim()) ? String(f.printerManual).trim() : f.printer
        const patch = { printer }
        if ('printerBar' in f) patch.printerBar = f.printerBar || null
        setConfig(patch); log('Impressora: ' + printer + (patch.printerBar ? ' | bar: ' + patch.printerBar : ''))
        return sendJson(res, { ok: true, ...statusObj() })
      }
      // Gestor salva o que ESTE PC imprime (por origem). Body: { filtros: {mesa:true, ifood:false, ...} }
      if (req.method === 'POST' && req.url === '/api/filtros') {
        const f = await jsonBody(req)
        const filtros = {}
        for (const k of ORIGENS_FILTRAVEIS) filtros[k] = f.filtros ? (f.filtros[k] !== false) : true
        setConfig({ filtros })
        log('Imprime neste PC: ' + (ORIGENS_FILTRAVEIS.filter(k => filtros[k]).join(', ') || '(nada)'))
        verificarPendentes().catch(() => {}) // ligou uma origem? pega os pendentes na hora (nao espera 12s)
        return sendJson(res, { ok: true, ...statusObj() })
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
      const f = await body(req)
      const printer = (f.printerManual && f.printerManual.trim()) ? f.printerManual.trim() : f.printer
      setConfig({ printer, printerBar: f.printerBar || null }); log('Impressora: ' + printer + (f.printerBar ? ' | bar: ' + f.printerBar : ''))
    } else if (req.method === 'POST' && req.url === '/empresa') {
      const f = await body(req); setConfig({ empresa_id: f.empresa_id }); empresaId = null; log('Loja escolhida.'); await iniciarEscuta()
    } else if (req.method === 'POST' && req.url === '/logout') {
      await supabase.auth.signOut(); empresaId = null; empresa = null; sessionAtiva = false; empresasDisponiveis = []
      setConfig({ empresa_id: null }); if (canal) { try { supabase.removeChannel(canal) } catch (e) {} } log('Desconectado.')
    } else if (req.method === 'POST' && req.url === '/atualizar') {
      // Botão "Atualizar app agora" da tela local — busca/baixa a versão nova (se
      // houver) e se reinicia sozinho. Fire-and-forget pra a página redirecionar já.
      checarAtualizacao(true).catch(() => {})
    } else if (req.method === 'POST' && req.url === '/teste') {
      jaImpressos.delete('teste')
      imprimir({ id: 'teste', numero_pedido: '0000', cliente_nome: 'TESTE', tipo_entrega: 'retirada', origem: 'teste',
        itens: [{ nome: 'Cupom de teste', qtd: 1 }], subtotal: 0, total: 0, forma_pagamento: 'dinheiro' })
    } else if (req.method === 'POST' && req.url === '/filtros') {
      const f = await body(req)
      const filtros = {}
      for (const k of ORIGENS_FILTRAVEIS) filtros[k] = (k in f)
      setConfig({ filtros })
      log('Imprime neste PC: ' + (ORIGENS_FILTRAVEIS.filter(k => filtros[k]).join(', ') || '(nada)'))
      verificarPendentes().catch(() => {}) // ligou uma origem? pega os pendentes na hora
    }
    res.writeHead(302, { Location: '/' }); res.end()
  } catch (e) { res.writeHead(500); res.end(String(e.message)) }
})
// Uma instância só: se a porta já está em uso, outro app FWC já roda — sai quieto.
server.on('error', e => { if (e && e.code === 'EADDRINUSE') process.exit(0) })
server.listen(PORT, '127.0.0.1', () => {
  log('=== Impressora FWC v' + APP_VERSION + ' ===')
  log('Configuracao: http://localhost:' + PORT)
  criarAtalhoStartup(process.execPath)  // mantém o "ligar com o Windows" no lugar certo
  iniciarEscuta()                       // conecta e escuta os pedidos
  setInterval(verificarPendentes, 12000)            // backup: pega pedidos que o tempo real atrasar
  setTimeout(checarAtualizacao, 20000)              // checa atualização 20s após ligar
  setInterval(checarAtualizacao, 3 * 60 * 60 * 1000) // e a cada 3 horas
})
