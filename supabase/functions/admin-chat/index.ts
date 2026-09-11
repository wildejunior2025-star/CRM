// admin-chat — o Super ADM conversa com os lojistas pelo número oficial da FWC.
//
// Por que existe: o número "FWC Inter" é Cloud API pura, não tem celular com
// WhatsApp. Sem esta função não havia como responder quem escrevia pra ele —
// nem o lojista que respondia a cobrança da mensalidade (mig 0257).
//
// Ações (só super admin):
//   enviar         → texto livre. A Meta só aceita até 24h depois da última
//                    mensagem da pessoa; fora disso devolve o motivo em português.
//   modelos        → lista os modelos (templates) APROVADOS da conta.
//   enviar_modelo  → modelo aprovado com os valores de {{1}}, {{2}}… É o único
//                    jeito de escrever primeiro, ou depois que a janela fechou.
//   foto_perfil    → troca a foto do número oficial (JPG/PNG em base64).
//   criar_modelo   → manda um modelo novo pra análise da Meta.
//
// Tudo que sai daqui entra em admin_chat, com o id da Meta: é por ele que o
// whatsapp-cloud marca depois se ENTREGOU, se foi LIDO ou se falhou.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const SUPABASE_URL  = Deno.env.get("SUPABASE_URL") ?? ""
const SUPABASE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
const CLOUD_TOKEN   = Deno.env.get("WHATSAPP_CLOUD_TOKEN") ?? ""
const GRAPH_VERSION = Deno.env.get("WHATSAPP_GRAPH_VERSION") ?? "v21.0"

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
}

// Mesma regra do whatsapp-cloud: a Meta entrega o celular BR sem o 9º dígito,
// mas pra ENVIAR costuma exigir o 9.
function normalizeBrNumber(n: string): string {
  const d = String(n ?? "").replace(/\D/g, "")
  if (d.startsWith("55") && d.length === 12) {
    const ddd = d.slice(2, 4)
    const local = d.slice(4)
    if (/^[6-9]/.test(local)) return `55${ddd}9${local}`
  }
  return d
}

// Número digitado à mão ("84 99999-0000") ainda não tem o 55 do país.
function comDDI(n: string): string {
  const d = String(n ?? "").replace(/\D/g, "")
  return d.startsWith("55") ? d : `55${d}`
}

// Parâmetro de modelo não aceita quebra de linha, tab nem 4+ espaços seguidos.
function limparParam(v: string): string {
  return String(v ?? "").replace(/\s+/g, " ").trim()
}

// Troca {{1}}, {{2}}… pelos valores, pra conversa mostrar o que o lojista leu.
function montarTexto(corpo: string, params: string[]): string {
  return String(corpo ?? "").replace(/\{\{(\d+)\}\}/g, (_, i) => params[Number(i) - 1] ?? `{{${i}}}`)
}

// O motivo que a Meta dá vem em inglês e com código. Quem está atendendo
// precisa saber o que FAZER — um "erro" seco faz a pessoa tentar pra sempre.
function motivoEmPortugues(data: any, status: number): string {
  const code = data?.error?.code
  const msg = String(data?.error?.error_data?.details ?? data?.error?.message ?? "")
  if (code === 131047 || /24 ?h|re-?engagement/i.test(msg)) {
    return "Passou de 24h desde a última mensagem dele. Fora dessa janela o WhatsApp oficial só deixa mandar um MODELO aprovado."
  }
  if (code === 131026) return "Esse número não recebeu: pode não ter WhatsApp ou ter bloqueado a FWC."
  if (code === 132000) return "O modelo pede outra quantidade de campos. Preencha todos."
  if (code === 132001) return "Esse modelo não existe mais nesse idioma ou ainda não foi aprovado."
  if (code === 131056) return "Muitas mensagens seguidas pra mesma pessoa. Espere um pouco."
  return msg || `erro ${status}`
}

// deno-lint-ignore-next-line no-explicit-any
async function empresaDoTelefone(supabase: any, telefone: string): Promise<string | null> {
  const chave = String(telefone ?? "").replace(/\D/g, "").slice(-8)
  if (chave.length < 8) return null
  const { data } = await supabase.from("empresas").select("id, telefone_contato").not("telefone_contato", "is", null)
  const achou = (Array.isArray(data) ? data : [])
    .find((e: Record<string, unknown>) => String(e.telefone_contato ?? "").replace(/\D/g, "").endsWith(chave))
  return (achou?.id as string) ?? null
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders })

  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } })

  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

    // Só o super admin fala em nome da FWC. A chave de serviço também passa:
    // é o próprio servidor (script de manutenção), e quem tem ela já manda no
    // banco inteiro — não abre porta nenhuma que já não estivesse aberta.
    const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "")
    // A chave do ambiente e a do painel podem vir em formatos diferentes, então
    // vale também qualquer JWT com papel service_role. Olhar só o papel é seguro
    // PORQUE esta função roda com verify_jwt ligado: o portão da Supabase já
    // conferiu a assinatura antes de a chamada chegar aqui.
    let papel = ""
    try {
      const p = jwt.split(".")[1] ?? ""
      papel = JSON.parse(atob(p.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (p.length % 4)) % 4)))?.role ?? ""
    } catch { /* não é JWT */ }
    if (!jwt || (jwt !== SUPABASE_KEY && papel !== "service_role")) {
      const { data: u } = await supabase.auth.getUser(jwt)
      if (!u?.user) return json({ ok: false, erro: "Sessão expirada. Entre de novo." }, 401)
      const { data: perfil } = await supabase.from("profiles").select("perfil").eq("id", u.user.id).maybeSingle()
      if (perfil?.perfil !== "super_admin") return json({ ok: false, erro: "Só o super admin pode usar." }, 403)
    }

    const { data: cfgs } = await supabase.from("config_global").select("chave, valor")
      .in("chave", ["admin_cloud_phone_number_id", "admin_cloud_waba_id"])
    const cfg: Record<string, string> = {}
    for (const r of cfgs ?? []) cfg[r.chave] = String(r.valor ?? "").trim()
    const phoneId = cfg.admin_cloud_phone_number_id
    const wabaId  = cfg.admin_cloud_waba_id
    if (!CLOUD_TOKEN || !phoneId) {
      return json({ ok: false, erro: "O número oficial não está configurado (admin_cloud_phone_number_id)." }, 503)
    }

    const body = await req.json().catch(() => ({}))
    const acao = String(body?.acao ?? "")

    // ── Modelos aprovados ────────────────────────────────────────────────────
    if (acao === "modelos") {
      if (!wabaId) return json({ ok: false, erro: "Falta admin_cloud_waba_id no config_global." }, 503)
      const res = await fetch(
        `https://graph.facebook.com/${GRAPH_VERSION}/${wabaId}/message_templates?fields=name,status,category,language,components&limit=200`,
        { headers: { Authorization: `Bearer ${CLOUD_TOKEN}` } },
      )
      const data = await res.json().catch(() => ({}))
      if (!res.ok) return json({ ok: false, erro: motivoEmPortugues(data, res.status) })

      const modelos = (Array.isArray(data?.data) ? data.data : [])
        .filter((t: any) => t.status === "APPROVED")
        .map((t: any) => {
          const comps = Array.isArray(t.components) ? t.components : []
          const corpo = String(comps.find((c: any) => c.type === "BODY")?.text ?? "")
          const cab = comps.find((c: any) => c.type === "HEADER")
          const rodape = String(comps.find((c: any) => c.type === "FOOTER")?.text ?? "")
          const botoes = comps.find((c: any) => c.type === "BUTTONS")?.buttons ?? []
          const campos = new Set((corpo.match(/\{\{(\d+)\}\}/g) ?? []).map((m: string) => m)).size
          // Cabeçalho com foto/vídeo/documento ou com campo, e botão de link com
          // campo, pedem mais coisa no envio. Aparecem na lista, mas travados:
          // melhor avisar do que mandar e a Meta recusar.
          const cabecalhoSimples = !cab || (cab.format === "TEXT" && !/\{\{\d+\}\}/.test(String(cab.text ?? "")))
          const botoesSimples = !botoes.some((b: any) => b.type === "URL" && /\{\{\d+\}\}/.test(String(b.url ?? "")))
          return {
            nome: t.name,
            idioma: t.language,
            categoria: t.category,
            cabecalho: cab?.format === "TEXT" ? String(cab.text ?? "") : "",
            corpo,
            rodape,
            botoes: botoes.map((b: any) => String(b.text ?? "")).filter(Boolean),
            campos,
            suportado: cabecalhoSimples && botoesSimples,
          }
        })
      return json({ ok: true, modelos })
    }

    // ── Foto do perfil do número oficial ─────────────────────────────────────
    // O número não tem celular, então a foto só troca por aqui. A Meta não
    // recebe a imagem direto no perfil: ela sobe antes pelo "upload retomável"
    // do app dono da chave, que devolve um handle — é o handle que vai pro perfil.
    if (acao === "foto_perfil") {
      const tipo = String(body?.tipo ?? "image/jpeg")
      if (tipo !== "image/jpeg" && tipo !== "image/png") return json({ ok: false, erro: "Use JPG ou PNG." }, 400)
      const base64 = String(body?.imagem_base64 ?? "").replace(/^data:[^,]+,/, "")
      if (!base64) return json({ ok: false, erro: "Mande a imagem." }, 400)
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
      if (bytes.length > 5 * 1024 * 1024) return json({ ok: false, erro: "A imagem passa de 5 MB." }, 400)

      const graph = `https://graph.facebook.com/${GRAPH_VERSION}`
      const auth = { Authorization: `Bearer ${CLOUD_TOKEN}` }

      const app = await fetch(`${graph}/app`, { headers: auth }).then((r) => r.json()).catch(() => ({}))
      const appId = String(app?.id ?? Deno.env.get("WHATSAPP_APP_ID") ?? "")
      if (!appId) return json({ ok: false, erro: "Não achei o app dono da chave da Meta." })

      const resSessao = await fetch(
        `${graph}/${appId}/uploads?file_name=perfil-fwc&file_length=${bytes.length}&file_type=${encodeURIComponent(tipo)}`,
        { method: "POST", headers: auth },
      )
      const sessao = await resSessao.json().catch(() => ({}))
      if (!resSessao.ok || !sessao?.id) return json({ ok: false, erro: motivoEmPortugues(sessao, resSessao.status) })

      // Nesse passo a Meta pede "OAuth", não "Bearer".
      const resUpload = await fetch(`${graph}/${sessao.id}`, {
        method: "POST",
        headers: { Authorization: `OAuth ${CLOUD_TOKEN}`, file_offset: "0", "Content-Type": tipo },
        body: bytes,
      })
      const upload = await resUpload.json().catch(() => ({}))
      if (!resUpload.ok || !upload?.h) return json({ ok: false, erro: motivoEmPortugues(upload, resUpload.status) })

      const res = await fetch(`${graph}/${phoneId}/whatsapp_business_profile`, {
        method: "POST",
        headers: { ...auth, "Content-Type": "application/json" },
        body: JSON.stringify({ messaging_product: "whatsapp", profile_picture_handle: upload.h }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) return json({ ok: false, erro: motivoEmPortugues(data, res.status) })

      const perfilNovo = await fetch(`${graph}/${phoneId}/whatsapp_business_profile?fields=profile_picture_url`, { headers: auth })
        .then((r) => r.json()).catch(() => ({}))
      return json({ ok: true, foto: perfilNovo?.data?.[0]?.profile_picture_url ?? null })
    }

    // ── Criar modelo (vai pra análise da Meta) ───────────────────────────────
    // Sai com exemplo pra cada {{n}} — sem isso a Meta recusa na hora — e os
    // botões são de resposta rápida: um toque do lojista já abre as 24h de
    // conversa livre. A Meta pode trocar a categoria na análise (Utilidade que
    // ela acha promocional vira Marketing); a resposta diz qual ficou.
    if (acao === "criar_modelo") {
      if (!wabaId) return json({ ok: false, erro: "Falta admin_cloud_waba_id no config_global." }, 503)
      const nome = String(body?.nome ?? "").trim().toLowerCase()
      const categoria = String(body?.categoria ?? "UTILITY").toUpperCase()
      const idioma = String(body?.idioma ?? "pt_BR").trim()
      const corpo = String(body?.corpo ?? "").trim()
      const exemplos = (Array.isArray(body?.exemplos) ? body.exemplos : []).map((e: unknown) => limparParam(String(e ?? "")))
      const rodape = String(body?.rodape ?? "").trim()
      const botoes = (Array.isArray(body?.botoes) ? body.botoes : []).map((b: unknown) => String(b ?? "").trim()).filter(Boolean)
      if (!/^[a-z0-9_]{1,512}$/.test(nome)) return json({ ok: false, erro: "Nome só com letras minúsculas, números e _." }, 400)
      if (!["UTILITY", "MARKETING"].includes(categoria)) return json({ ok: false, erro: "Categoria: UTILITY ou MARKETING." }, 400)
      if (!corpo) return json({ ok: false, erro: "Escreva o texto do modelo." }, 400)
      const campos = new Set(corpo.match(/\{\{(\d+)\}\}/g) ?? []).size
      if (exemplos.length !== campos || exemplos.some((e: string) => !e)) {
        return json({ ok: false, erro: `O texto tem ${campos} campo(s): mande um exemplo pra cada.` }, 400)
      }

      const componentes: Record<string, unknown>[] = [
        campos ? { type: "BODY", text: corpo, example: { body_text: [exemplos] } } : { type: "BODY", text: corpo },
      ]
      if (rodape) componentes.push({ type: "FOOTER", text: rodape })
      if (botoes.length) componentes.push({ type: "BUTTONS", buttons: botoes.map((t: string) => ({ type: "QUICK_REPLY", text: t })) })

      const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${wabaId}/message_templates`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${CLOUD_TOKEN}` },
        body: JSON.stringify({ name: nome, language: idioma, category: categoria, components: componentes }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) return json({ ok: false, erro: motivoEmPortugues(data, res.status), detalhe: data?.error ?? null })
      return json({ ok: true, id: data?.id ?? null, status: data?.status ?? null, categoria: data?.category ?? categoria })
    }

    const telefone = comDDI(String(body?.telefone ?? ""))
    if (telefone.length < 12) return json({ ok: false, erro: "Telefone inválido." }, 400)

    // ── Texto livre (dentro das 24h) ─────────────────────────────────────────
    if (acao === "enviar") {
      const texto = String(body?.texto ?? "").trim()
      if (!texto) return json({ ok: false, erro: "Escreva a mensagem." }, 400)

      const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${phoneId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${CLOUD_TOKEN}` },
        body: JSON.stringify({
          messaging_product: "whatsapp", recipient_type: "individual",
          to: normalizeBrNumber(telefone), type: "text", text: { body: texto, preview_url: true },
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) return json({ ok: false, erro: motivoEmPortugues(data, res.status) })

      const empresaId = await empresaDoTelefone(supabase, telefone)
      await supabase.from("admin_chat").insert({
        telefone, empresa_id: empresaId, remetente: "fwc", texto, tipo: "texto",
        message_id: data?.messages?.[0]?.id ?? null, status: "enviado", lida: true,
      })
      // Respondeu: o que ele tinha mandado sai das não lidas.
      await supabase.from("admin_chat").update({ lida: true })
        .eq("remetente", "cliente").eq("lida", false).like("telefone", `%${telefone.slice(-8)}`)
      return json({ ok: true })
    }

    // ── Modelo aprovado (fora das 24h ou pra puxar conversa) ─────────────────
    if (acao === "enviar_modelo") {
      const nome = String(body?.nome ?? "").trim()
      const idioma = String(body?.idioma ?? "pt_BR").trim()
      const params = (Array.isArray(body?.params) ? body.params : []).map((p: unknown) => limparParam(String(p ?? "")))
      if (!nome) return json({ ok: false, erro: "Escolha o modelo." }, 400)
      if (params.some((p: string) => !p)) return json({ ok: false, erro: "Preencha todos os campos do modelo." }, 400)

      const template: Record<string, unknown> = { name: nome, language: { code: idioma } }
      if (params.length) {
        template.components = [{ type: "body", parameters: params.map((p: string) => ({ type: "text", text: p })) }]
      }
      const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${phoneId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${CLOUD_TOKEN}` },
        body: JSON.stringify({
          messaging_product: "whatsapp", recipient_type: "individual",
          to: normalizeBrNumber(telefone), type: "template", template,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) return json({ ok: false, erro: motivoEmPortugues(data, res.status) })

      const corpo = String(body?.corpo ?? "")
      const empresaId = await empresaDoTelefone(supabase, telefone)
      await supabase.from("admin_chat").insert({
        telefone, empresa_id: empresaId, remetente: "fwc",
        texto: corpo ? montarTexto(corpo, params) : `Modelo "${nome}"`,
        tipo: "modelo", message_id: data?.messages?.[0]?.id ?? null, status: "enviado", lida: true,
      })
      return json({ ok: true })
    }

    return json({ ok: false, erro: "Ação inválida." }, 400)
  } catch (e) {
    console.error("[admin-chat] erro:", (e as Error)?.message)
    return json({ ok: false, erro: String((e as Error)?.message ?? e) }, 500)
  }
})
