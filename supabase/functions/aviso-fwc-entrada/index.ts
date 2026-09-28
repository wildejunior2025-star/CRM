import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

// Mensagem nova no WhatsApp da FWC (99912-0349, Evolution) vira um aviso no
// WhatsApp pessoal do dono (config_global.aviso_fwc_destino). O número da FWC
// fica num celular que ninguém olha o dia todo, e lojista que chama e não é
// respondido vai embora — é exatamente quem veio do anúncio do Instagram.
//
// O Evolution chama esta função pelo webhook da instância do admin. Deploy com
// --no-verify-jwt (o Evolution não manda JWT); quem protege é o ?token=, que
// fica guardado em config_global.aviso_fwc_token. Quem aponta o webhook pra cá
// é a função aviso-fwc-configurar.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? ""
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
const EVOLUTION_API_URL = (Deno.env.get("EVOLUTION_API_URL") ?? "").replace(/[/]$/, "")
const EVOLUTION_API_KEY = Deno.env.get("EVOLUTION_API_KEY") ?? ""

const JANELA_MIN = 30

const ok = (data: unknown = { ok: true }, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } })

// deno-lint-ignore-next-line no-explicit-any
async function config(sb: any): Promise<Record<string, string>> {
  const { data } = await sb.from("config_global").select("chave, valor")
    .in("chave", ["admin_sender_instance", "aviso_fwc_destino", "aviso_fwc_token"])
  const cfg: Record<string, string> = {}
  for (const r of data ?? []) cfg[r.chave] = String(r.valor ?? "").trim()
  return cfg
}

// deno-lint-ignore-next-line no-explicit-any
function textoDaMensagem(msg: any): string {
  const t = msg?.messageType
  if (t === "conversation" || t === "extendedTextMessage") {
    return String(msg.message?.conversation ?? msg.message?.extendedTextMessage?.text ?? "").trim()
  }
  if (t === "pttMessage" || t === "audioMessage") return "🎤 Áudio"
  if (t === "imageMessage") {
    const cap = String(msg.message?.imageMessage?.caption ?? "").trim()
    return cap ? `📷 Foto — ${cap}` : "📷 Foto"
  }
  if (t === "videoMessage") return "🎬 Vídeo"
  if (t === "documentMessage") return "📄 Documento"
  if (t === "locationMessage" || t === "liveLocationMessage") return "📍 Localização"
  if (t === "stickerMessage") return "🙂 Figurinha"
  return "Mensagem"
}

function formatarTel(d: string): string {
  if (d.length >= 12) return `(${d.slice(2, 4)}) ${d.slice(4, -4)}-${d.slice(-4)}`
  return d
}

serve(async (req) => {
  if (req.method !== "POST") return ok()
  const sb = createClient(SUPABASE_URL, SERVICE_KEY)

  try {
    const body = await req.json().catch(() => ({}))
    const cfg = await config(sb)
    const instancia = cfg.admin_sender_instance || "crmadmin"

    const token = new URL(req.url).searchParams.get("token") ?? ""
    if (!cfg.aviso_fwc_token || token !== cfg.aviso_fwc_token) return ok({ error: "token" }, 401)
    if (body?.event !== "messages.upsert" || body?.instance !== instancia) return ok()

    const msg = body.data
    const jid = String(msg?.key?.remoteJid ?? "")
    if (!msg || msg.key?.fromMe || !jid.endsWith("@s.whatsapp.net")) return ok()

    // Evolution reiniciando reenvia conversa velha: não é mensagem nova.
    const ts = msg.messageTimestamp
    let seg = Number(typeof ts === "object" && ts !== null ? (ts.low ?? 0) : (ts ?? 0))
    if (seg > 1e12) seg = seg / 1000
    if (seg > 0 && Date.now() / 1000 - seg > 600) return ok()

    const de = jid.replace("@s.whatsapp.net", "").replace(/[^0-9]/g, "")
    let destino = (cfg.aviso_fwc_destino ?? "").replace(/[^0-9]/g, "")
    if (!de || !destino) return ok()
    if (!destino.startsWith("55")) destino = "55" + destino
    // O aviso sai deste mesmo número: se o destino escrever pra cá, não avisa
    // ele de si mesmo.
    if (de.slice(-8) === destino.slice(-8)) return ok()

    // Quem manda 5 mensagens seguidas gera 1 aviso só.
    const { data: ultimo } = await sb.from("aviso_fwc_entrada").select("avisado_em").eq("telefone", de).maybeSingle()
    if (ultimo?.avisado_em && Date.now() - new Date(ultimo.avisado_em).getTime() < JANELA_MIN * 60_000) return ok()
    await sb.from("aviso_fwc_entrada").upsert({ telefone: de, avisado_em: new Date().toISOString() })

    const nome = String(msg.pushName ?? "").trim() || "Sem nome"
    const texto = textoDaMensagem(msg)
    const trecho = texto.length > 300 ? texto.slice(0, 300) + "…" : texto
    const aviso = `🔔 *Mensagem nova no WhatsApp da FWC*\n\n*${nome}* · ${formatarTel(de)}\n${trecho}\n\nResponda pelo WhatsApp da FWC (99912-0349).`

    const res = await fetch(`${EVOLUTION_API_URL}/message/sendText/${instancia}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: EVOLUTION_API_KEY },
      body: JSON.stringify({ number: destino, text: aviso }),
    })
    if (!res.ok) console.error("[aviso-fwc] envio falhou:", res.status, (await res.text()).slice(0, 200))
    return ok()
  } catch (e) {
    console.error("[aviso-fwc] erro:", (e as Error)?.message)
    return ok()
  }
})
