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
const TENTATIVAS = 6
const ESPERA_MS = 8000

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

/** Qual bundle o site está servindo agora? */
async function bundleServido(host) {
  try {
    const r = await fetch(`https://${host}/`, {
      headers: { 'Cache-Control': 'no-cache', Pragma: 'no-cache' },
    })
    const html = await r.text()
    const m = html.match(/\/assets\/index-[\w-]+\.js/)
    return m ? m[0] : null
  } catch { return null }
}

const espera = ms => new Promise(r => setTimeout(r, ms))

async function purgar(token, zone) {
  const res = await fetch(`https://api.cloudflare.com/client/v4/zones/${zone}/purge_cache`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ purge_everything: true }),
  })
  const json = await res.json()
  if (!json.success) console.warn('⚠️  Purge não confirmado:', JSON.stringify(json.errors ?? json))
  return json.success
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

  const servidos = await Promise.all(HOSTS.map(bundleServido))
  const faltando = HOSTS.filter((_, k) => servidos[k] !== esperado)

  if (faltando.length === 0) { ok = true; break }
  console.log(`   tentativa ${i}/${TENTATIVAS} — ainda antigo em: ${faltando.join(', ')} (servindo ${servidos.find(s => s !== esperado) ?? '?'})`)
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
