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
// Resposta automática pro contato (mig 0338): no máximo 1 a cada 12 h, e nunca
// se o Wilde já falou com ele à mão nesse período.
const JANELA_RESPOSTA_H = 12
const PREFIXO_AUTOMATICA = "Oi! 👋 Aqui é o Wilde, da FWC Inter."

function respostaAutomatica(): string {
  const hora = Number(new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Fortaleza", hour: "numeric", hourCycle: "h23",
  }).format(new Date()))
  // Versão com resumo e preço (voltou em 19/10): quem recebeu ela continuava
  // a conversa; com a curta ("Com quem eu falo?") os leads paravam de responder.
  const abertura = hora >= 7 && hora < 22 ? "Já te atendo!" : "Logo cedo te respondo!"
  return `${PREFIXO_AUTOMATICA} ${abertura}\n\n` +
    "Enquanto isso, um resumo:\n" +
    "✅ Pedido da mesa, balcão, delivery, iFood e WhatsApp numa tela só\n" +
    "✅ Cozinha recebe no celular, sem papel\n" +
    "✅ Robô no WhatsApp que atende seu cliente e anota o pedido sozinho\n" +
    "✅ Conta e fechamento do dia prontos\n\n" +
    "💰 Planos a partir de *R$ 25 por semana*, com *teste grátis*.\n" +
    "Me conta: qual é a sua loja e como vocês anotam os pedidos hoje?"
}

// Segunda mensagem (mig 0350): 5 min depois do "Com quem eu falo?", se nem o
// lead nem o Wilde escreveram nada, o robô puxa a conversa de novo. Só uma vez
// e só de dia — de noite a primeira já disse "logo cedo te respondo".
const FOLLOWUP_MIN = 5
function saudacao(hora: number): string {
  if (hora < 12) return "Bom dia"
  if (hora < 18) return "Boa tarde"
  return "Boa noite"
}
function textoFollowup(hora: number): string {
  return `${saudacao(hora)}! Como posso te ajudar hoje? Você já usa algum sistema na sua loja?`
}
const FOLLOWUPS = new Set([5, 12, 18].map(textoFollowup))
function horaFortaleza(): number {
  return Number(new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Fortaleza", hour: "numeric", hourCycle: "h23",
  }).format(new Date()))
}

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

// Guarda a conversa do número da Evolution no MESMO lugar do número da Cloud
// (mig 0349), pra ela aparecer no "Atendimento FWC" do Super ADM. Antes daqui
// só sobrava o carimbo de hora em aviso_fwc_entrada: o texto se perdia, e
// responder exigia pegar o celular.
//
// `empresa_id` liga a conversa à loja quando o telefone é de lojista — é o que
// faz a lista mostrar "Zebu Restaurante" em vez de um número solto.
// deno-lint-ignore no-explicit-any
async function guardarNoChat(
  sb: any, telefone: string, remetente: "cliente" | "fwc",
  texto: string, nome?: string,
) {
  try {
    let empresaId: string | null = null
    const chave = telefone.slice(-8)
    const { data: emp } = await sb.from("empresas")
      .select("id").like("telefone_contato", `%${chave}`).limit(1).maybeSingle()
    empresaId = emp?.id ?? null
    if (!empresaId) {
      const { data: prof } = await sb.from("profiles")
        .select("empresa_id").like("telefone", `%${chave}`).limit(1).maybeSingle()
      empresaId = prof?.empresa_id ?? null
    }
    await sb.from("admin_chat").insert({
      telefone, canal: "evolution", empresa_id: empresaId,
      nome: (nome ?? "").trim() || null,
      remetente, texto: String(texto ?? "").slice(0, 4000), tipo: "texto",
      status: remetente === "fwc" ? "enviado" : null,
      lida: remetente === "fwc",
    })
  } catch (e) {
    // Guardar a conversa é um extra: se falhar, o aviso e a resposta automática
    // seguem normalmente. Perder o aviso seria pior que perder o histórico.
    console.error("[aviso-fwc] nao guardou no chat:", String(e).slice(0, 180))
  }
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

    // Aviso pronto vindo do banco (gatilho de pagamento, mig 0288): só entrega.
    if (typeof body?.aviso === "string" && body.aviso.trim()) {
      let para = (cfg.aviso_fwc_destino ?? "").replace(/[^0-9]/g, "")
      if (!para) return ok()
      if (!para.startsWith("55")) para = "55" + para
      const r = await fetch(`${EVOLUTION_API_URL}/message/sendText/${instancia}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: EVOLUTION_API_KEY },
        body: JSON.stringify({ number: para, text: body.aviso.slice(0, 1500) }),
      })
      if (!r.ok) console.error("[aviso-fwc] aviso pronto falhou:", r.status, (await r.text()).slice(0, 200))
      return ok({ ok: r.ok })
    }
    // Chamado pelo cron a cada minuto: manda a segunda mensagem pra quem
    // ficou no vácuo depois do "Com quem eu falo?".
    if (body?.action === "followup") {
      const hora = horaFortaleza()
      if (hora < 7 || hora >= 22) return ok({ enviados: 0, motivo: "noite" })
      const agora = Date.now()
      const { data: linhas } = await sb.from("aviso_fwc_entrada")
        .select("telefone, respondido_em, humano_em, ultima_entrada_em, followup_em")
        .gte("respondido_em", new Date(agora - 60 * 60_000).toISOString())
        .lte("respondido_em", new Date(agora - FOLLOWUP_MIN * 60_000).toISOString())
      let enviados = 0
      for (const l of linhas ?? []) {
        const resp = new Date(l.respondido_em).getTime()
        const depois = (iso: string | null) => !!iso && new Date(iso).getTime() > resp + 15_000
        if (l.followup_em && new Date(l.followup_em).getTime() >= resp) continue // já mandou
        if (l.humano_em && new Date(l.humano_em).getTime() >= resp) continue    // o Wilde respondeu
        if (depois(l.ultima_entrada_em)) continue                                // o lead respondeu
        // Segurança extra: qualquer mensagem do Wilde já gravada no chat depois
        // da resposta automática (por qualquer caminho) também conta.
        const { data: falas } = await sb.from("admin_chat").select("texto")
          .eq("remetente", "fwc").like("telefone", `%${String(l.telefone).slice(-8)}`)
          .gt("created_at", new Date(resp + 5_000).toISOString()).limit(10)
        if ((falas ?? []).some((f: { texto: string }) =>
          !String(f.texto ?? "").startsWith(PREFIXO_AUTOMATICA) && !FOLLOWUPS.has(String(f.texto ?? "")))) continue
        const texto = textoFollowup(hora)
        const r = await fetch(`${EVOLUTION_API_URL}/message/sendText/${instancia}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", apikey: EVOLUTION_API_KEY },
          body: JSON.stringify({ number: l.telefone, text: texto }),
        })
        if (r.ok) {
          await sb.from("aviso_fwc_entrada").update({ followup_em: new Date().toISOString() }).eq("telefone", l.telefone)
          await guardarNoChat(sb, l.telefone, "fwc", texto)
          enviados++
        } else {
          console.error("[aviso-fwc] followup falhou:", r.status, (await r.text()).slice(0, 200))
        }
      }
      return ok({ enviados })
    }

    if (body?.event !== "messages.upsert" || body?.instance !== instancia) return ok()

    const msg = body.data
    const jid = String(msg?.key?.remoteJid ?? "")
    if (!msg || !jid.endsWith("@s.whatsapp.net")) return ok()

    // Mensagem que saiu do próprio número: se foi o Wilde respondendo à mão
    // (e não a resposta automática nem o aviso), anota pra o robô não se meter.
    if (msg.key?.fromMe) {
      const texto = textoDaMensagem(msg)
      const para = jid.replace("@s.whatsapp.net", "").replace(/[^0-9]/g, "")
      if (para && !texto.startsWith(PREFIXO_AUTOMATICA) && !texto.startsWith("🔔") && !FOLLOWUPS.has(texto)) {
        await sb.from("aviso_fwc_entrada").upsert({ telefone: para, humano_em: new Date().toISOString() })
        // Respondeu pelo celular: entra no chat do Super ADM igual, senão a
        // conversa de lá fica pela metade e parece que ninguém respondeu.
        await guardarNoChat(sb, para, "fwc", texto)
      }
      return ok()
    }

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

    // A conversa entra no chat SEMPRE — antes dos freios de aviso. Quem manda
    // 5 mensagens seguidas gera 1 aviso só, mas as 5 têm que aparecer na tela.
    await guardarNoChat(sb, de, "cliente", textoDaMensagem(msg), String(msg.pushName ?? ""))

    const { data: ultimo } = await sb.from("aviso_fwc_entrada")
      .select("avisado_em, respondido_em, humano_em").eq("telefone", de).maybeSingle()
    // Marca que o lead escreveu (a segunda mensagem só sai pra quem ficou calado).
    await sb.from("aviso_fwc_entrada").upsert({ telefone: de, ultima_entrada_em: new Date().toISOString() })
    const ha = (iso: string | null | undefined) => iso ? Date.now() - new Date(iso).getTime() : Infinity

    // Resposta automática pro contato, antes do aviso (quem chamou não pode
    // ficar no vácuo enquanto o Wilde não vê).
    const janelaResp = JANELA_RESPOSTA_H * 3600_000
    if (ha(ultimo?.respondido_em) > janelaResp && ha(ultimo?.humano_em) > janelaResp) {
      const r = await fetch(`${EVOLUTION_API_URL}/message/sendText/${instancia}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: EVOLUTION_API_KEY },
        body: JSON.stringify({ number: de, text: respostaAutomatica() }),
      })
      if (r.ok) {
        await sb.from("aviso_fwc_entrada").upsert({ telefone: de, respondido_em: new Date().toISOString() })
        await guardarNoChat(sb, de, "fwc", respostaAutomatica())
      }
      else console.error("[aviso-fwc] resposta automática falhou:", r.status, (await r.text()).slice(0, 200))
    }

    // Quem manda 5 mensagens seguidas gera 1 aviso só.
    if (ha(ultimo?.avisado_em) < JANELA_MIN * 60_000) return ok()
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
