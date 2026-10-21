// Avisa no WhatsApp do dono da FWC quando a impressora de uma loja trava.
//
// POR QUE EXISTE
// Em 20/10/2026 a térmica da cozinha do Braseiro parou de receber no meio do
// movimento. O Windows aceitava cada cupom, respondia OK e empilhava: 18
// pedidos presos na fila e nenhum papel. Ninguém soube até o dono reclamar, e
// o conserto levou 10 segundos (desligar e ligar a impressora). A hora perdida
// foi toda em DESCOBRIR o que era.
//
// O app Impressora FWC já roda nas lojas e já sabia disso às 19:10. Esta função
// é o telefone que faltava.
//
// PRA QUEM VAI
// Pro WhatsApp do dono da FWC, não pra loja — a loja não sabe resolver e ia
// ligar pra ele de qualquer jeito. Mesma instância da Evolution que o alerta de
// saúde e o aviso de entrada já usam (`admin_sender_instance`), e o destino é o
// `aviso_fwc_destino`.
//
// POR QUE EVOLUTION E NÃO CLOUD API
// Alerta é texto livre e chega a qualquer hora. A Cloud API, fora da janela de
// 24h, só entrega template aprovado — um alerta que depende de a pessoa ter
// conversado com a gente nas últimas 24h não serve como alerta.
//
// Toda a decisão (quando é problema, o que já foi avisado, o texto) mora na
// RPC `impressora_saude_avisar()` da mig 0355. Aqui só pergunta e entrega.
// Chamada pelo cron de 5 em 5 min. Falhar aqui não pode quebrar nada.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
}

const EVOLUTION_API_URL = (Deno.env.get("EVOLUTION_API_URL") ?? "").replace(/\/$/, "")
const EVOLUTION_API_KEY = Deno.env.get("EVOLUTION_API_KEY") ?? ""
const INSTANCIA_PADRAO  = "crmadmin"

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors })

  const json = (d: unknown, s = 200) =>
    new Response(JSON.stringify(d), { status: s, headers: { ...cors, "Content-Type": "application/json" } })

  try {
    const sb = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    )

    // `?forcar=1` manda uma mensagem de teste mesmo sem problema nenhum, pra
    // provar o cano inteiro sem ter que esperar uma impressora travar de verdade.
    const forcar = new URL(req.url).searchParams.get("forcar") === "1"

    const { data: aviso, error } = await sb.rpc("impressora_saude_avisar")
    if (error) return json({ ok: false, erro: error.message }, 500)

    const mensagens: string[] = [...(aviso?.mensagens ?? [])]

    if (forcar) {
      const { data: pcs } = await sb
        .from("impressora_saude")
        .select("pc, filas, visto_em, empresas(nome)")
        .order("visto_em", { ascending: false })
        .limit(10)

      const linhas = (pcs ?? []).map((p: Record<string, unknown>) => {
        const filas = (p.filas as Array<Record<string, unknown>>) ?? []
        const resumo = filas.length
          ? filas.map((f) => `${f.nome}: ${f.presos ?? 0} na fila`).join(" · ")
          : "sem impressora configurada"
        const loja = (p.empresas as { nome?: string } | null)?.nome ?? "?"
        return `• ${loja} (${p.pc}) — ${resumo}`
      })

      mensagens.push(
        "🔎 *Teste do alerta de impressora*\n\n" +
        (linhas.length ? linhas.join("\n") : "Nenhum PC reportou ainda.") +
        "\n\n_Se você recebeu isto, o aviso automático está funcionando._",
      )
    }

    if (!mensagens.length) return json({ ok: true, enviado: 0 })

    const numero = String(aviso?.telefone ?? "").replace(/\D/g, "")
    if (!numero) return json({ ok: false, erro: "sem aviso_fwc_destino configurado" }, 400)

    if (!EVOLUTION_API_URL || !EVOLUTION_API_KEY) {
      // Sem o cano, o alerta ainda fica no log — melhor do que sumir calado.
      console.warn("[impressora-alerta] sem Evolution. Mensagens:", mensagens.join(" || "))
      return json({ ok: false, erro: "sem_evolution", mensagens })
    }

    const { data: cfgInst } = await sb
      .from("config_global").select("valor").eq("chave", "admin_sender_instance").maybeSingle()
    const instancia = (cfgInst?.valor ?? "").trim() || INSTANCIA_PADRAO

    let enviadas = 0
    for (const texto of mensagens) {
      const r = await fetch(`${EVOLUTION_API_URL}/message/sendText/${instancia}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: EVOLUTION_API_KEY },
        body: JSON.stringify({ number: numero, text: texto }),
      })
      if (r.ok) { enviadas++; continue }
      // A RPC já marcou como avisado; se o envio falhar, esta mensagem se perde.
      // É de propósito: repetir pra sempre o que não entrega viraria enxurrada
      // quando a Evolution voltasse. O log guarda o que não saiu.
      console.error("[impressora-alerta] Evolution recusou:", (await r.text()).slice(0, 300), "|", texto.slice(0, 120))
    }

    return json({ ok: true, enviado: enviadas, de: mensagens.length, para: numero })
  } catch (e) {
    console.error("[impressora-alerta] erro:", e)
    return json({ ok: false, erro: String(e).slice(0, 300) }, 500)
  }
})
