// Purga o cache da Cloudflare depois do deploy — evita o site travar numa versão
// antiga (a Cloudflare cacheia o index.html/sw.js no edge). Roda no `npm run deploy`.
// Lê CF_PURGE_TOKEN e CF_ZONE_ID do .env (que não vai pro Git).
import { readFileSync } from 'node:fs'

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

const env = { ...envDoArquivo(), ...process.env }
const token = env.CF_PURGE_TOKEN
const zone = env.CF_ZONE_ID

if (!token || !zone) {
  console.warn('⚠️  CF_PURGE_TOKEN/CF_ZONE_ID ausentes no .env — pulei o purge do cache.')
  process.exit(0)
}

try {
  const res = await fetch(`https://api.cloudflare.com/client/v4/zones/${zone}/purge_cache`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ purge_everything: true }),
  })
  const json = await res.json()
  if (json.success) console.log('✅ Cache da Cloudflare purgado — a versão nova já está no ar.')
  else console.warn('⚠️  Purge não confirmado:', JSON.stringify(json.errors ?? json))
} catch (e) {
  console.warn('⚠️  Falha ao purgar o cache (deploy segue ok):', String(e))
}
