// Purga o cache da Cloudflare depois do deploy — e CONFERE se pegou.
//
// O problema que isto resolve
// --------------------------
// A Cloudflare cacheia o index.html na borda mesmo com `Cache-Control: no-store`
// (o _headers manda no-store e ela responde CF-Cache-Status: HIT assim mesmo).
// Como o purge rodava logo depois do `wrangler deploy`, ele acontecia ANTES da
// versão nova terminar de se espalhar: a borda recacheava o index.html VELHO e
// ele ficava preso até o próximo deploy. Resultado clássico: "fiz o deploy e o
// site continua igual" — o JS novo estava no servidor, mas o HTML apontava pro
// antigo.
//
// Agora o script não confia na resposta do purge: ele lê qual bundle o build
// gerou, purga, e fica batendo no site até o HTML servido apontar pra esse
// bundle. Se depois de todas as tentativas ainda não bater, ele AVISA em vez de
// dizer que deu certo.
import { readFileSync } from 'node:fs'

const HOSTS = ['gestor.fwcinter.com', 'lojaonline.fwcinter.com']
// A borda às vezes leva mais de um minuto pra parar de servir o HTML antigo.
// Com 6×8s (~48s) o script já deu alarme falso num deploy que estava certo —
// e alarme falso ensina a ignorar o aviso, que é justamente o que não pode.
const TENTATIVAS = 10
const ESPERA_MS = 12000

function envDoArquivo() {
  try {
    const txt = readFileSync(new URL('../.env', import.meta.url), 'utf8')
    const out = {}
    for (const linha of txt.split('\n')) {
      const m = linha.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '')
    }
    return out
  } catch { return {} }
}

/** Qual bundle este build gerou? É o que o site TEM que estar servindo. */
function bundleEsperado() {
  try {
    const html = readFileSync(new URL('../dist/client/index.html', import.meta.url), 'utf8')
    const m = html.match(/\/assets\/index-[\w-]+\.js/)
    return m ? m[0] : null
  } catch { return null }
}

/**
 * Confere um host de verdade: pede o HTML VÁRIAS vezes (cada nó da borda tem a
 * sua cópia, e eles se atualizam em tempos diferentes — conferir uma vez só dá
 * falso positivo) e, em cada uma, checa se o bundle que o HTML pede realmente
 * BAIXA. Um 500/404 aqui é tela preta pro cliente: o HTML antigo aponta pra um
 * arquivo que a versão nova não serve mais.
 */
async function hostOk(host, esperado, rodadas = 4) {
  for (let i = 0; i < rodadas; i++) {
    try {
      const r = await fetch(`https://${host}/?v=${Date.now()}-${i}`, {
        headers: { 'Cache-Control': 'no-cache', Pragma: 'no-cache' },
      })
      const html = await r.text()
      const bundle = (html.match(/\/assets\/index-[\w-]+\.js/) ?? [])[0]
      if (bundle !== esperado) return { ok: false, motivo: `HTML pede ${bundle ?? '?'}` }

      const a = await fetch(`https://${host}${bundle}`, { method: 'HEAD' })
      if (!a.ok) return { ok: false, motivo: `${bundle} respondeu ${a.status}` }
    } catch (e) {
      return { ok: false, motivo: String(e.message ?? e) }
    }
  }
  return { ok: true }
}

const espera = ms => new Promise(r => setTimeout(r, ms))

// Rotas que a borda costuma segurar: são as URLs que o pessoal abre direto.
// Uma rota nunca acessada já vem certa — o problema é sempre a entrada velha.
const ROTAS_PRESAS = ['/', '/index.html', '/login', '/painel', '/whatsapp', '/vendas', '/caixa']

async function chamarPurge(token, zone, body) {
  const res = await fetch(`https://api.cloudflare.com/client/v4/zones/${zone}/purge_cache`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const json = await res.json().catch(() => ({}))
  if (!json.success) console.warn('⚠️  Purge não confirmado:', JSON.stringify(json.errors ?? json))
  return json.success
}

/**
 * Purga duas vezes, e a segunda é a que resolve.
 *
 * Em 08/08/2026 o `purge_everything` respondeu success dez vezes seguidas e o
 * `/` continuou servindo o index.html antigo — enquanto uma rota nunca acessada
 * já vinha com o bundle novo, provando que o deploy estava certo e o preso era
 * só a entrada de cache daquelas URLs. O purge POR URL soltou na hora.
 */
async function purgar(token, zone) {
  const tudo = await chamarPurge(token, zone, { purge_everything: true })
  const files = HOSTS.flatMap(h => ROTAS_PRESAS.map(r => `https://${h}${r}`))
  const porUrl = await chamarPurge(token, zone, { files })
  return tudo || porUrl
}

const env = { ...envDoArquivo(), ...process.env }
const token = env.CF_PURGE_TOKEN
const zone = env.CF_ZONE_ID

if (!token || !zone) {
  console.warn('⚠️  CF_PURGE_TOKEN/CF_ZONE_ID ausentes no .env — pulei o purge do cache.')
  process.exit(0)
}

const esperado = bundleEsperado()
if (!esperado) {
  // Sem saber o alvo não dá pra conferir; purga uma vez e sai.
  await purgar(token, zone)
  console.warn('⚠️  Não achei o bundle em dist/client/index.html — purguei sem conferir.')
  process.exit(0)
}

console.log(`🔎 Esperando o site servir ${esperado}`)

let ok = false
for (let i = 1; i <= TENTATIVAS; i++) {
  await purgar(token, zone)
  await espera(ESPERA_MS)

  const res = await Promise.all(HOSTS.map(h => hostOk(h, esperado)))
  const ruins = HOSTS.map((h, k) => ({ h, ...res[k] })).filter(r => !r.ok)

  if (ruins.length === 0) { ok = true; break }
  console.log(`   tentativa ${i}/${TENTATIVAS} — ${ruins.map(r => `${r.h}: ${r.motivo}`).join(' | ')}`)
}

if (ok) {
  console.log('✅ Cache purgado e CONFERIDO — o site já está servindo a versão nova.')
} else {
  console.warn(
    '⚠️  O site AINDA está servindo a versão antiga depois de ' + TENTATIVAS + ' tentativas.\n' +
    '   Os arquivos novos subiram, mas a borda da Cloudflare está presa no index.html velho.\n' +
    '   Rode `npm run deploy` de novo, ou purgue na mão no painel (Caching → Configuration → Purge Everything).'
  )
  process.exitCode = 1
}
