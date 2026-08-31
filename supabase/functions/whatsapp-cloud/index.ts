// whatsapp-cloud — "cano" novo do WhatsApp via Cloud API oficial da Meta.
//
// Por que existe: o Evolution segura cada número na RAM e só aguenta ~5-10 lojas
// ao mesmo tempo. No Cloud API a Meta hospeda as conexões → escala pra 50-100+.
//
// Arquitetura (sem duplicar o cérebro e sem tocar no Evolution):
//   1. Recebe o webhook da Meta.
//   2. Acha a loja pelo cloud_phone_number_id (whatsapp_config).
//   3. Chama o whatsapp-webhook em modo _test — ele roda TODO o cérebro
//      (Claude, carrinho, cadastro, CEP, fechar pedido) e devolve a resposta
//      SEM enviar pelo Evolution.
//   4. Envia a resposta ao cliente pela Graph API da Meta.
//
// MVP: trata texto. Áudio/imagem/PIX-QR entram numa próxima etapa (precisam do
// download/upload de mídia pela Graph API).

import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const SUPABASE_URL  = Deno.env.get("SUPABASE_URL") ?? ""
const SUPABASE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
const CLOUD_TOKEN   = Deno.env.get("WHATSAPP_CLOUD_TOKEN") ?? ""       // token permanente (System User)
const VERIFY_TOKEN  = Deno.env.get("WHATSAPP_VERIFY_TOKEN") ?? ""      // token que a gente define no webhook
const GRAPH_VERSION = Deno.env.get("WHATSAPP_GRAPH_VERSION") ?? "v21.0"
const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY") ?? ""            // Whisper (transcrição de áudio)

// ── Baixa mídia da Graph API (por media id) → base64 + mimetype ───────────────
// `token` é o da loja quando ela veio pelo Cadastro Incorporado; senão o global.
async function baixarMidiaCloud(mediaId: string, token: string): Promise<{ base64: string; mimetype: string } | null> {
  try {
    // 1. pega a URL temporária da mídia
    const metaRes = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${mediaId}`, {
      headers: { "Authorization": `Bearer ${token}` },
    })
    if (!metaRes.ok) { console.error("[cloud media] meta erro", metaRes.status, (await metaRes.text()).slice(0, 300)); return null }
    const meta = await metaRes.json()
    const mediaUrl = meta?.url
    const mimetype = String(meta?.mime_type ?? "audio/ogg").split(";")[0]
    if (!mediaUrl) return null
    // 2. baixa o binário (a URL da Meta também exige o token)
    const binRes = await fetch(mediaUrl, { headers: { "Authorization": `Bearer ${token}` } })
    if (!binRes.ok) { console.error("[cloud media] download erro", binRes.status); return null }
    const buf = new Uint8Array(await binRes.arrayBuffer())
    let bin = ""
    for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i])
    return { base64: btoa(bin), mimetype }
  } catch (e) { console.error("[cloud media] exceção", String(e)); return null }
}

// ── Transcreve áudio com Whisper (OpenAI) ─────────────────────────────────────
async function transcreverAudio(base64: string, mimetype: string): Promise<string | null> {
  if (!OPENAI_API_KEY) { console.error("[cloud whisper] sem OPENAI_API_KEY"); return null }
  try {
    const binary = Uint8Array.from(atob(base64), c => c.charCodeAt(0))
    const ext = mimetype.includes("ogg") ? "ogg"
      : (mimetype.includes("mp4") || mimetype.includes("m4a")) ? "mp4"
      : mimetype.includes("mpeg") ? "mp3" : "ogg"
    const form = new FormData()
    form.append("file", new Blob([binary], { type: mimetype }), `audio.${ext}`)
    form.append("model", "whisper-1")
    form.append("language", "pt")
    const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${OPENAI_API_KEY}` },
      body: form,
    })
    if (!res.ok) { console.error("[cloud whisper] erro", (await res.text()).slice(0, 300)); return null }
    const data = await res.json()
    return data.text ?? null
  } catch (e) { console.error("[cloud whisper] exceção", String(e)); return null }
}

// ── 9º dígito do Brasil ───────────────────────────────────────────────────────
// A Meta manda o wa_id de celular BR SEM o 9º dígito (ex.: 55 84 8180-774 →
// 558498180774). Pra ENVIAR de volta, muitas vezes precisa do 9 (55 84 9 xxxx).
// Só normaliza o número de ENVIO — não mexe no `from` usado no cérebro/banco.
function normalizeBrNumber(n: string): string {
  const d = String(n ?? "").replace(/\D/g, "")
  // 55 + DDD(2) + 8 dígitos = 12 → celular sem o 9. Fixo (começa 2-5) não recebe o 9.
  if (d.startsWith("55") && d.length === 12) {
    const ddd = d.slice(2, 4)
    const local = d.slice(4)
    if (/^[6-9]/.test(local)) return `55${ddd}9${local}`
  }
  return d
}

// Espelha a mensagem no chat do painel (a aba Mensagens), pra loja atender tudo
// num lugar só — WhatsApp e link da Loja Online na mesma conversa.
//
// Se o cliente já tinha falado pelo link, a mensagem entra NAQUELA conversa,
// não numa nova: duas linhas do mesmo cliente fariam o atendente responder na
// errada e o cliente receber pela metade. O casamento é pelos 8 últimos
// dígitos, porque o WhatsApp entrega o número com e sem o 9 do celular.
async function espelharNoChat(
  supabase: any, empresaId: string, phone: string, texto: string, remetente: "cliente" | "loja",
) {
  try {
    const digitos = String(phone ?? "").replace(/\D/g, "")
    const chave = digitos.slice(-8)
    if (!empresaId || !chave || !texto) return
    const { data: existente } = await supabase
      .from("mensagens_chat")
      .select("canal, cliente_ref, cliente_nome")
      .eq("empresa_id", empresaId)
      .like("cliente_ref", `%${chave}`)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle()
    let nome = existente?.cliente_nome ?? null
    if (!nome) {
      const { data: cli } = await supabase
        .from("clientes").select("nome")
        .eq("empresa_id", empresaId)
        .like("telefone_digitos", `%${chave}`)
        .limit(1).maybeSingle()
      nome = cli?.nome ?? null
    }
    await supabase.from("mensagens_chat").insert({
      empresa_id: empresaId,
      canal: existente?.canal ?? "whatsapp",
      cliente_ref: existente?.cliente_ref ?? digitos,
      cliente_nome: nome,
      remetente,
      texto,
    })
  } catch (_e) {
    // O espelho é bônus: se falhar, o atendimento pelo WhatsApp segue igual.
  }
}

// O que guardar da mensagem quando o robô está desligado (ver whatsapp-webhook).
function textoParaRegistroCloud(message: any): string {
  const t = message?.type
  if (t === "text") return String(message.text?.body ?? "").trim()
  if (t === "interactive") {
    return String(message.interactive?.button_reply?.title ?? message.interactive?.list_reply?.title ?? "").trim()
  }
  if (t === "button") return String(message.button?.text ?? "").trim()
  if (t === "audio") return "🎤 Áudio"
  if (t === "image") {
    const cap = String(message.image?.caption ?? "").trim()
    return cap ? `📷 Foto — ${cap}` : "📷 Foto"
  }
  if (t === "document") return "📄 Documento"
  if (t === "location") return "📍 Localização"
  if (t === "sticker") return "🙂 Figurinha"
  if (t === "video") return "🎬 Vídeo"
  return ""
}

// ── Envio de texto pela Graph API ────────────────────────────────────────────
async function sendText(phoneNumberId: string, to: string, text: string, token: string) {
  try {
    const dest = normalizeBrNumber(to)
    const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: dest,
        type: "text",
        text: { body: text, preview_url: true },
      }),
    })
    if (!res.ok) console.error("[cloud send] erro", res.status, (await res.text()).slice(0, 400))
  } catch (e) {
    console.error("[cloud send] exceção", String(e))
  }
}

// ── Processa uma mensagem recebida ───────────────────────────────────────────
async function processar(body: any) {
  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

  const value   = body?.entry?.[0]?.changes?.[0]?.value
  const phoneNumberId = value?.metadata?.phone_number_id

  // ── Aviso de entrega (mig 0150) ──
  // A Meta responde 200 na hora ("aceitei") e só aqui diz se ENTREGOU ou falhou,
  // com o motivo. Antes isto era descartado, então a tela dizia "enviado" pra
  // mensagem que morreu no caminho (número errado, 9º dígito, bloqueio, 24h).
  const statuses = value?.statuses
  if (Array.isArray(statuses) && statuses.length) {
    for (const st of statuses) {
      const err = st.errors?.[0]
      await supabase.from("whatsapp_envios").update({
        status:    st.status === "failed" ? "falhou" : st.status,
        erro_code: err?.code ?? null,
        erro_msg:  err ? (err.error_data?.details ?? err.title ?? err.message ?? null) : null,
        updated_at: new Date().toISOString(),
      }).eq("message_id", st.id)
      if (st.status === "failed") {
        console.error("[cloud] mensagem falhou", st.id, JSON.stringify(err))
      }
    }
    return
  }

  const message = value?.messages?.[0]
  if (!phoneNumberId || !message) return          // outros eventos: ignora

  const from = String(message.from ?? "").replace(/\D/g, "")
  if (!from) return

  // Acha a loja dona desse número
  const { data: cfg } = await supabase
    .from("whatsapp_config")
    .select("empresa_id, instance_name, cloud_phone_number_id, ativo, ia_ativo")
    .eq("cloud_phone_number_id", phoneNumberId)
    .eq("ativo", true)
    .maybeSingle()
  if (!cfg) { console.error("[cloud] nenhuma loja para phone_number_id", phoneNumberId); return }
  const instanceName = cfg.instance_name ?? `cloud_${phoneNumberId}`

  // Token: o da loja (Cadastro Incorporado) quando existir; senão o do app.
  // Sem isso, número conectado pela própria loja não responderia.
  let token = CLOUD_TOKEN
  if (cfg.empresa_id) {
    const { data: tok } = await supabase
      .from("whatsapp_cloud_tokens")
      .select("token")
      .eq("empresa_id", cfg.empresa_id)
      .maybeSingle()
    if (tok?.token) token = tok.token
  }
  if (!token) { console.error("[cloud] sem token para phone_number_id", phoneNumberId); return }

  // RESPOSTA DA CAMPANHA — vem antes de tudo, inclusive do interruptor da IA.
  //
  // Quem clica num botão de resposta rápida de TEMPLATE não chega aqui como
  // "interactive": a Meta manda type "button", com o texto em message.button.
  // Sem este trecho a resposta caía no "só consigo te atender por texto" — e o
  // cliente que pediu pra não receber ficaria sem registro nenhum, recebendo
  // tudo de novo na campanha seguinte. É assim que se ganha uma denúncia.
  // O rodapé do template promete "responda SAIR" — então SAIR digitado tem que
  // valer tanto quanto o botão, senão a promessa é mentira.
  const textoBotao = message.type === "button"
    ? String(message.button?.text ?? message.button?.payload ?? "").trim()
    : message.type === "text" && /^\s*sair[.!]?\s*$/i.test(String(message.text?.body ?? ""))
      ? "prefiro não receber"
      : ""
  if (textoBotao) {
    const t = textoBotao.toLowerCase()
    const querSim  = t.includes("pode mandar") || t.includes("quero receber")
    const querNao  = t.includes("prefiro n")  || t.includes("não receber") || t.includes("nao receber")

    if (querSim || querNao) {
      // O `from` da Meta vem SEM o 9º dígito no Nordeste (5584 8774-7166) e o
      // cadastro guarda COM o 9. Comparar o texto cru não achava ninguém: o
      // cliente recebia o "Show!" e o banco continuava sem resposta nenhuma.
      // O RPC casa pelas duas formas e guarda a resposta mesmo se não casar.
      const { data: marcados } = await supabase.rpc("campanha_registrar_resposta", {
        p_empresa_id: cfg.empresa_id, p_telefone: from,
        p_texto: textoBotao, p_aceita: querSim,
      })
      if (!marcados) {
        console.error("[cloud] resposta de campanha sem cadastro casado", from, textoBotao)
      }

      await sendText(
        phoneNumberId, from,
        querSim
          ? "Show! 🙌 Toda vez que sair o cardápio do dia eu te aviso por aqui. Se um dia enjoar, é só responder *SAIR*."
          : "Beleza, não te mando mais o cardápio. 👍 Quando quiser pedir, é só chamar aqui que eu te atendo.",
        token
      )
      return
    }

    // Botão que o código não soube ler (rótulo mudou no template, campanha
    // nova com outra pergunta). Guarda assim mesmo: se a gente reescrever o
    // template amanhã e esquecer desta lista, a resposta do cliente fica no
    // banco pra ser recuperada, em vez de sumir sem deixar rastro.
    if (message.type === "button") {
      await supabase.rpc("campanha_registrar_resposta", {
        p_empresa_id: cfg.empresa_id, p_telefone: from,
        p_texto: textoBotao, p_aceita: null,
      })
      console.error("[cloud] botão de campanha não reconhecido", from, textoBotao)
    }
  }

  // Vendedor IA desligado: não responde NADA. Sem esta linha, as respostas de
  // "só entendo texto" (áudio e foto) saíam mesmo com o interruptor desligado,
  // porque elas são enviadas aqui, antes de chamar o cérebro.
  if (!cfg.ia_ativo) {
    // Mesma razão do whatsapp-webhook: robô desligado não pode significar
    // mensagem perdida. A loja atende pelo gestor, e pra isso precisa ter o
    // que o cliente escreveu.
    const conteudo = textoParaRegistroCloud(message)
    if (cfg.empresa_id && conteudo) {
      await supabase.from("whatsapp_conversas").insert({
        empresa_id: cfg.empresa_id, phone: from, role: "user", content: conteudo,
      })
      await espelharNoChat(supabase, cfg.empresa_id, from, conteudo, "cliente")
    }
    return
  }

  // Extrai o texto (MVP: texto e botões/listas)
  let text = ""
  if (message.type === "text") {
    text = String(message.text?.body ?? "").trim()
  } else if (message.type === "interactive") {
    text = String(
      message.interactive?.button_reply?.title ??
      message.interactive?.list_reply?.title ?? ""
    ).trim()
  } else if (message.type === "audio") {
    // Áudio/nota de voz: baixa da Graph API e transcreve com Whisper.
    const mediaId = message.audio?.id
    const midia = mediaId ? await baixarMidiaCloud(String(mediaId), token) : null
    const transcricao = midia ? await transcreverAudio(midia.base64, midia.mimetype) : null
    if (transcricao?.trim()) {
      text = transcricao.trim()
      console.log("[cloud audio] transcrito:", text)
    } else {
      await sendText(phoneNumberId, from, "Oi! 😊 Não consegui entender o áudio. Pode escrever por texto?", token)
      return
    }
  } else {
    // imagem/documento ainda não suportados por aqui
    await sendText(phoneNumberId, from, "Oi! 😊 Por enquanto consigo te atender melhor por *texto*. Pode escrever o que você precisa?", token)
    return
  }
  if (!text) return

  // Chama o cérebro (whatsapp-webhook) em modo _test — roda tudo e devolve a
  // resposta, sem enviar pelo Evolution.
  const payload = {
    event: "messages.upsert",
    instance: instanceName,
    _test: true,
    data: {
      key: { remoteJid: `${from}@s.whatsapp.net`, fromMe: false },
      messageType: "conversation",
      message: { conversation: text },
    },
  }

  let resposta = ""
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/whatsapp-webhook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${SUPABASE_KEY}`,
        "x-bot-test": "1",
      },
      body: JSON.stringify(payload),
    })
    const data = await res.json().catch(() => ({} as any))
    resposta = data?.resposta ?? ""
    // Loja fechada: o cérebro salva a mensagem mas não a devolve no corpo — busca a última do bot
    if (!resposta && data?.fechado) {
      const { data: ult } = await supabase
        .from("whatsapp_conversas")
        .select("content")
        .eq("phone", from)
        .eq("role", "assistant")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle()
      resposta = ult?.content ?? ""
    }
  } catch (e) {
    console.error("[cloud] erro ao chamar o cérebro", String(e))
  }

  if (resposta) await sendText(phoneNumberId, from, resposta, token)
}

// ── serve ────────────────────────────────────────────────────────────────────
serve(async (req) => {
  const url = new URL(req.url)

  // Verificação do webhook exigida pela Meta (GET com hub.challenge)
  if (req.method === "GET") {
    const mode      = url.searchParams.get("hub.mode")
    const token     = url.searchParams.get("hub.verify_token")
    const challenge = url.searchParams.get("hub.challenge")
    if (mode === "subscribe" && token === VERIFY_TOKEN) {
      return new Response(challenge ?? "", { status: 200 })
    }
    return new Response("forbidden", { status: 403 })
  }

  if (req.method !== "POST") return new Response("ok", { status: 200 })

  let body: any = null
  try { body = await req.json() } catch { return new Response("ok", { status: 200 }) }

  // A Meta exige 200 rápido — responde já e processa em background.
  const work = processar(body).catch((e) => console.error("[cloud] processar exceção", String(e)))
  // @ts-ignore EdgeRuntime existe no runtime Deno da Supabase
  if (typeof EdgeRuntime !== "undefined" && EdgeRuntime.waitUntil) {
    // @ts-ignore
    EdgeRuntime.waitUntil(work)
  } else {
    await work
  }

  return new Response("ok", { status: 200 })
})
