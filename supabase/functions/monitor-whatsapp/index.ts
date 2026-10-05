// VIGIA DO WHATSAPP DAS LOJAS — pergunta ao Evolution e avisa quando cai.
//
// POR QUE EXISTE
// Em 30/09/2026 o Railway pausou o Evolution (teste grátis vencido + fatura
// atrasada) e as lojas ficaram ~19 horas sem WhatsApp sem ninguém perceber. O
// Zebu fez 20 pedidos naquela manhã e nenhum cliente recebeu aviso.
//
// POR QUE O AVISO NÃO PODE SAIR PELO EVOLUTION
// É ele que a gente está vigiando. O `saude-alerta` (banco) avisa pelo Evolution
// e está certo pro caso dele; aqui seria um alarme que só toca quando não
// precisa. Então a ordem aqui é a inversa:
//   1. Cloud API da Meta, texto livre  → funciona dentro da janela de 24h
//   2. Cloud API, modelo aprovado      → é o que escreve primeiro / fora da janela
//   3. Evolution                       → só serve quando o servidor está de pé
//      (loja com o celular desconectado), e é a última tentativa de propósito.
//
// O QUE É AVISADO
// Só MUDANÇA de estado: caiu, e depois quando voltou. Servidor fora vira UMA
// mensagem ("o Evolution caiu, N lojas mudas"), não uma por loja.
//
// Chamado pelo cron de 5 em 5 min (mig 0291). Deploy com --no-verify-jwt.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
}

const EVOLUTION_API_URL = (Deno.env.get("EVOLUTION_API_URL") ?? "").replace(/\/$/, "")
const EVOLUTION_API_KEY = Deno.env.get("EVOLUTION_API_KEY") ?? ""
const CLOUD_TOKEN       = Deno.env.get("WHATSAPP_CLOUD_TOKEN") ?? ""
const GRAPH_VERSION     = Deno.env.get("WHATSAPP_GRAPH_VERSION") ?? "v21.0"
const MODELO_ALERTA     = "alerta_plataforma"
const MODELO_IDIOMA     = "pt_BR"

type Estado = "aberto" | "desconectado" | "servidor_fora"

// A Meta entrega o celular BR sem o 9º dígito, mas pra ENVIAR costuma exigir.
function numeroBr(n: string): string {
  const d = String(n ?? "").replace(/\D/g, "")
  if (d.startsWith("55") && d.length === 12 && /^[6-9]/.test(d.slice(4))) {
    return `55${d.slice(2, 4)}9${d.slice(4)}`
  }
  return d
}

// Parâmetro de modelo não aceita quebra de linha, tab nem 4+ espaços seguidos.
const limparParam = (v: string) => String(v ?? "").replace(/\s+/g, " ").trim()

/**
 * Estado real de uma instância.
 *
 * A diferença que importa: servidor DE PÉ dizendo "close" é problema de UMA
 * loja (QR a ler); servidor que não responde — ou responde "Application not
 * found", que é o Railway dizendo que o serviço não existe — é problema de
 * TODAS. Confundir os dois foi o que fez a tela mostrar "Conectado" com tudo
 * parado.
 */
async function estadoDaInstancia(instancia: string): Promise<{ estado: Estado; detalhe: string }> {
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 12000)
    const res = await fetch(`${EVOLUTION_API_URL}/instance/connectionState/${instancia}`, {
      headers: { apikey: EVOLUTION_API_KEY },
      signal: ctrl.signal,
    }).finally(() => clearTimeout(t))
    const corpo = await res.text()
    // "Application not found" é o Railway dizendo que o serviço inteiro sumiu.
    // 404 com outro texto é o próprio Evolution dizendo que AQUELA instância não
    // existe — problema de uma loja só, não do servidor. Confundir os dois faria
    // o vigia gritar "tudo fora do ar" por causa de um cadastro velho.
    if (/application not found/i.test(corpo) || res.status >= 500) {
      return { estado: "servidor_fora", detalhe: `HTTP ${res.status}: ${corpo.slice(0, 120)}` }
    }
    if (res.status === 404) {
      return { estado: "desconectado", detalhe: `instância não existe no servidor (404)` }
    }
    let dados: Record<string, unknown> = {}
    try { dados = JSON.parse(corpo) } catch { /* corpo não-JSON: trata abaixo */ }
    const st = String((dados as any)?.instance?.state ?? (dados as any)?.state ?? "")
    if (st === "open") return { estado: "aberto", detalhe: "" }
    return { estado: "desconectado", detalhe: st || corpo.slice(0, 120) }
  } catch (e) {
    // Servidor fora do ar, DNS caído, tempo esgotado: ninguém está sendo atendido.
    return { estado: "servidor_fora", detalhe: String(e).slice(0, 160) }
  }
}

// ── O aviso ──────────────────────────────────────────────────────────────────
// deno-lint-ignore-next-line no-explicit-any
async function avisar(supabase: any, texto: string): Promise<{ ok: boolean; via: string; erro?: string }> {
  const { data: cfgs } = await supabase.from("config_global").select("chave, valor")
    .in("chave", ["saude_alerta_phone", "super_admin_phone", "admin_cloud_phone_number_id", "admin_sender_instance"])
  const cfg: Record<string, string> = {}
  for (const r of cfgs ?? []) cfg[r.chave] = String(r.valor ?? "").trim()

  const destino = numeroBr(cfg.saude_alerta_phone || cfg.super_admin_phone || "")
  if (!destino) return { ok: false, via: "-", erro: "sem telefone de destino" }

  const phoneId = cfg.admin_cloud_phone_number_id
  const graph = (corpo: Record<string, unknown>) =>
    fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${phoneId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${CLOUD_TOKEN}` },
      body: JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", to: destino, ...corpo }),
    })

  // 1. Texto livre pela Meta — passa se você falou com o número oficial nas
  //    últimas 24h.
  if (phoneId && CLOUD_TOKEN) {
    try {
      const r = await graph({ type: "text", text: { body: texto, preview_url: false } })
      if (r.ok) return { ok: true, via: "cloud" }
      console.error("[monitor] cloud texto recusou:", (await r.text()).slice(0, 200))
    } catch (e) { console.error("[monitor] cloud texto falhou:", String(e).slice(0, 160)) }

    // 2. Modelo aprovado — é o que escreve primeiro, fora da janela de 24h.
    try {
      const r = await graph({
        type: "template",
        template: {
          name: MODELO_ALERTA, language: { code: MODELO_IDIOMA },
          components: [{ type: "body", parameters: [{ type: "text", text: limparParam(texto).slice(0, 900) }] }],
        },
      })
      if (r.ok) return { ok: true, via: "cloud_modelo" }
      console.error("[monitor] cloud modelo recusou:", (await r.text()).slice(0, 250))
    } catch (e) { console.error("[monitor] cloud modelo falhou:", String(e).slice(0, 160)) }
  }

  // 3. Evolution — só funciona quando o servidor está de pé; serve pro caso de
  //    uma loja só ter caído.
  if (EVOLUTION_API_URL && EVOLUTION_API_KEY) {
    try {
      const r = await fetch(`${EVOLUTION_API_URL}/message/sendText/${cfg.admin_sender_instance || "crmadmin"}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: EVOLUTION_API_KEY },
        body: JSON.stringify({ number: destino, text: texto }),
      })
      if (r.ok) return { ok: true, via: "evolution" }
      return { ok: false, via: "evolution", erro: (await r.text()).slice(0, 200) }
    } catch (e) { return { ok: false, via: "evolution", erro: String(e).slice(0, 160) } }
  }
  return { ok: false, via: "-", erro: "nenhum caminho de envio disponível" }
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors })
  const json = (d: unknown, s = 200) =>
    new Response(JSON.stringify(d), { status: s, headers: { ...cors, "Content-Type": "application/json" } })

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  )

  try {
    // `?teste=1` manda uma mensagem agora, sem esperar nada cair — serve pra
    // provar que o cano do aviso funciona (foi o que faltou descobrir antes).
    if (new URL(req.url).searchParams.get("teste") === "1") {
      const r = await avisar(supabase,
        "🔎 *Teste do vigia do WhatsApp*\n\nSe você recebeu isto, o aviso de queda está funcionando.")
      return json({ ok: r.ok, teste: true, via: r.via, erro: r.erro })
    }

    // As instâncias do Evolution que estão no ar hoje + a da própria FWC.
    const { data: lojas } = await supabase
      .from("whatsapp_config")
      .select("empresa_id, instance_name, ativo, cloud_phone_number_id, empresas(nome)")
      .eq("ativo", true)
    const alvos = (lojas ?? [])
      // Loja na Cloud API da Meta não depende do Evolution — a Meta hospeda. O
      // nome `cloud_...` também é da Meta: o depósito do Thiago tem esse nome
      // sem phone_number_id (conexão pela metade) e o Evolution respondia 404,
      // o que virou "servidor fora" no primeiro teste.
      .filter((l: any) => {
        const nome = String(l.instance_name ?? "").trim()
        return nome && !l.cloud_phone_number_id && !nome.startsWith("cloud_")
      })
      .map((l: any) => ({
        instancia: String(l.instance_name).trim(),
        empresa_id: l.empresa_id as string,
        loja: (l.empresas?.nome ?? "").trim() || "(sem nome)",
      }))
    const { data: cfgInst } = await supabase.from("config_global")
      .select("valor").eq("chave", "admin_sender_instance").maybeSingle()
    const instAdmin = String(cfgInst?.valor ?? "crmadmin").trim()
    if (instAdmin && !alvos.some(a => a.instancia === instAdmin)) {
      alvos.push({ instancia: instAdmin, empresa_id: null as any, loja: "FWC (número da plataforma)" })
    }
    if (!alvos.length) return json({ ok: true, nada: "nenhuma instância Evolution ativa" })

    const agora = new Date().toISOString()
    const resultado: Record<string, unknown>[] = []
    const caiu: string[] = []        // como aparece na mensagem (com o tempo parado)
    const caiuLojas: string[] = []   // só o nome, pra marcar o avisado_em
    const voltou: string[] = []
    let servidorFora = 0

    for (const alvo of alvos) {
      const { estado, detalhe } = await estadoDaInstancia(alvo.instancia)
      if (estado === "servidor_fora") servidorFora++

      const { data: antes } = await supabase.from("monitor_whatsapp")
        .select("estado, avisado_em, mudou_em").eq("instancia", alvo.instancia).maybeSingle()
      const mudou = (antes?.estado ?? "desconhecido") !== estado

      await supabase.from("monitor_whatsapp").upsert({
        instancia: alvo.instancia, empresa_id: alvo.empresa_id, loja: alvo.loja,
        estado, detalhe: detalhe || null, checado_em: agora,
        ...(mudou ? { mudou_em: agora } : {}),
      }, { onConflict: "instancia" })

      // Avisa de novo de 6 em 6 horas enquanto continuar caída. Avisar só na
      // mudança deixou a CDBom 3 dias muda: o aviso saiu às 19:50 de uma
      // quinta, passou batido, e ninguém mais foi lembrado (05/10/2026).
      const SEIS_HORAS = 6 * 60 * 60 * 1000
      const insistir = estado !== "aberto" && !mudou
        && (!antes?.avisado_em || Date.now() - new Date(antes.avisado_em).getTime() > SEIS_HORAS)

      if ((mudou || insistir) && estado !== "aberto") {
        // Há quanto tempo está assim: "caiu agora" e "caiu anteontem" pedem
        // reações diferentes de quem lê.
        const desde = new Date(mudou ? agora : (antes?.mudou_em ?? agora)).getTime()
        const h = Math.floor((Date.now() - desde) / 3600000)
        const quanto = h < 1 ? "agora" : h < 24 ? `há ${h}h` : `há ${Math.floor(h / 24)} dia(s)`
        caiu.push(`${alvo.loja} (${quanto})`)
        caiuLojas.push(alvo.loja)
      }
      if (mudou && estado === "aberto" && antes?.estado && antes.estado !== "desconhecido") voltou.push(alvo.loja)
      resultado.push({ loja: alvo.loja, instancia: alvo.instancia, estado, mudou })
    }

    // Uma mensagem só. Servidor fora derruba todo mundo ao mesmo tempo: avisar
    // loja por loja seria o celular apitando dez vezes pelo mesmo problema.
    let texto = ""
    if (caiu.length && servidorFora >= alvos.length && alvos.length > 1) {
      texto = "🚨 *WhatsApp fora do ar*\n\n" +
        `O servidor (Evolution) não está respondendo — *${alvos.length} números* estão mudos, ` +
        "nenhuma loja recebe nem responde mensagem.\n\n" +
        "Costuma ser o Railway: plano, fatura em aberto ou serviço pausado.\n" +
        "👉 railway.com/dashboard"
    } else if (caiu.length) {
      texto = "⚠️ *WhatsApp desconectado*\n\n" +
        caiu.map(l => `• ${l}`).join("\n") +
        "\n\nO servidor está de pé, mas esse(s) número(s) caiu(ram) — precisa ler o QR Code de novo " +
        "no Super ADM → WhatsApp."
    }
    if (voltou.length && !texto) {
      texto = "✅ *WhatsApp normalizado*\n\n" + voltou.map(l => `• ${l}`).join("\n") +
        "\n\nVoltou a enviar e receber."
    }

    let envio: Record<string, unknown> | null = null
    if (texto) {
      const r = await avisar(supabase, texto)
      envio = { via: r.via, ok: r.ok, erro: r.erro }
      if (r.ok) {
        const nomes = caiuLojas.length ? caiuLojas : voltou
        await supabase.from("monitor_whatsapp").update({ avisado_em: agora })
          .in("loja", nomes)
      } else {
        console.error("[monitor] NÃO consegui avisar:", r.erro, "|", texto.slice(0, 120))
      }
    }

    return json({ ok: true, checadas: alvos.length, servidor_fora: servidorFora, caiu, voltou, envio, resultado })
  } catch (e) {
    console.error("[monitor] erro:", e)
    return json({ ok: false, erro: String(e).slice(0, 300) }, 500)
  }
})
