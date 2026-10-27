import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

// =====================================================================
// nfce-auto  —  emite a NFC-e sozinha, pras lojas que ligaram (27/10/2026)
// ---------------------------------------------------------------------
// Roda de minuto em minuto (cron). Pra cada loja com `nfce_auto` ligado:
//   1. acha vendas ja FECHADAS (comanda fechada, pedido entregue, balcao pronto)
//      depois do momento em que a loja ligou, ha mais de `nfce_auto_espera_min`
//      minutos (tempo de corrigir forma de pagamento errada);
//   2. so as de forma de pagamento marcada na loja (cartao, pix, dinheiro, vale);
//   3. que ainda nao tem nota autorizada/processando;
//   4. e chama a MESMA emissao do botao manual (emitir-nfce), que ja nao duplica.
//
// Falha nunca trava venda: tenta de novo com intervalo crescente e, na 4a vez,
// desiste e avisa o WhatsApp do dono da FWC (nao a loja: ela nao resolve).
// Chamada pelo cron; nao usa login (deploy com --no-verify-jwt).
// =====================================================================

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? ""
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
const EVOLUTION_API_URL = (Deno.env.get("EVOLUTION_API_URL") ?? "").replace(/\/$/, "")
const EVOLUTION_API_KEY = Deno.env.get("EVOLUTION_API_KEY") ?? ""

const MAX_POR_RODADA = 10
const MAX_TENTATIVAS = 4

const GRUPOS: Record<string, string[]> = {
  cartao: ["credito", "debito", "cartao"],
  pix: ["pix", "pix_entrega", "online"],
  dinheiro: ["dinheiro"],
  vale: ["vale", "pluxee", "alelo", "vr", "ticket"],
}

// Todas as partes do pagamento precisam estar nos grupos marcados. Fiado, vazio
// e "outro" nunca emitem sozinhos.
function formasPermitidas(venda: any, marcados: string[]): boolean {
  const ok = new Set(marcados.flatMap((g) => GRUPOS[g] ?? []))
  const partes: string[] =
    Array.isArray(venda.pagamentos) && venda.pagamentos.length > 0
      ? venda.pagamentos.map((p: any) => String(p?.forma ?? "").toLowerCase())
      : [String(venda.forma_pagamento ?? "").toLowerCase()]
  return partes.length > 0 && partes.every((f) => ok.has(f))
}

async function avisarDono(sb: any, texto: string) {
  try {
    if (!EVOLUTION_API_URL || !EVOLUTION_API_KEY) { console.warn("[nfce-auto] sem Evolution:", texto); return }
    const { data: cfg } = await sb.from("config_global").select("chave, valor").in("chave", ["aviso_fwc_destino", "admin_sender_instance"])
    const v = (k: string) => String((cfg ?? []).find((c: any) => c.chave === k)?.valor ?? "")
    const numero = v("aviso_fwc_destino").replace(/\D/g, "")
    const instancia = v("admin_sender_instance").trim() || "crmadmin"
    if (!numero) return
    await fetch(`${EVOLUTION_API_URL}/message/sendText/${instancia}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: EVOLUTION_API_KEY },
      body: JSON.stringify({ number: numero, text: texto }),
    })
  } catch (e) { console.error("[nfce-auto] aviso falhou:", e) }
}

Deno.serve(async () => {
  const sb = createClient(SUPABASE_URL, SERVICE_KEY)
  const resumo: Record<string, unknown>[] = []
  let emitidas = 0

  try {
    const { data: lojas } = await sb.from("empresa_fiscal")
      .select("empresa_id, nfce_auto_formas, nfce_auto_espera_min, nfce_auto_desde, empresas(nome)")
      .eq("ativo", true).eq("nfce_auto", true).eq("focus_registrada", true)
      .not("nfce_auto_desde", "is", null)

    for (const loja of lojas ?? []) {
      if (emitidas >= MAX_POR_RODADA) break
      const marcados: string[] = loja.nfce_auto_formas ?? []
      if (!marcados.length) continue
      const nome = (loja as any).empresas?.nome ?? loja.empresa_id
      const desde = loja.nfce_auto_desde
      const ate = new Date(Date.now() - Math.max(1, Number(loja.nfce_auto_espera_min) || 2) * 60 * 1000).toISOString()

      const cand: { tipo: "pedido" | "comanda"; id: string; rotulo: string }[] = []

      const { data: coms } = await sb.from("comandas")
        .select("id, forma_pagamento, fechada_at")
        .eq("empresa_id", loja.empresa_id).eq("status", "fechada")
        .gte("fechada_at", desde).lte("fechada_at", ate).limit(60)
      for (const c of coms ?? []) if (formasPermitidas(c, marcados)) cand.push({ tipo: "comanda", id: c.id, rotulo: "mesa" })

      const { data: peds } = await sb.from("pedidos_delivery")
        .select("id, status, origem, forma_pagamento, pagamentos, updated_at")
        .eq("empresa_id", loja.empresa_id).in("status", ["entregue", "pronto"])
        .gte("updated_at", desde).lte("updated_at", ate).limit(100)
      for (const p of peds ?? []) {
        if (p.status === "pronto" && p.origem !== "balcao") continue   // delivery 'pronto' ainda nao saiu
        if (formasPermitidas(p, marcados)) cand.push({ tipo: "pedido", id: p.id, rotulo: p.origem ?? "pedido" })
      }
      if (!cand.length) continue

      // Quem ja tem nota (autorizada ou em andamento) fica de fora.
      const idsPed = cand.filter((c) => c.tipo === "pedido").map((c) => c.id)
      const idsCom = cand.filter((c) => c.tipo === "comanda").map((c) => c.id)
      const feitos = new Set<string>()
      if (idsPed.length) {
        const { data } = await sb.from("nfce_notas").select("pedido_id").in("pedido_id", idsPed).in("status", ["autorizada", "processando"])
        for (const n of data ?? []) feitos.add(n.pedido_id)
      }
      if (idsCom.length) {
        const { data } = await sb.from("nfce_notas").select("comanda_id").in("comanda_id", idsCom).in("status", ["autorizada", "processando"])
        for (const n of data ?? []) feitos.add(n.comanda_id)
      }
      const { data: tents } = await sb.from("nfce_auto_tentativas").select("*")
        .or(`pedido_id.in.(${idsPed.join(",") || "00000000-0000-0000-0000-000000000000"}),comanda_id.in.(${idsCom.join(",") || "00000000-0000-0000-0000-000000000000"})`)
      const tentPorId = new Map<string, any>()
      for (const t of tents ?? []) tentPorId.set(t.pedido_id ?? t.comanda_id, t)

      for (const c of cand) {
        if (emitidas >= MAX_POR_RODADA) break
        if (feitos.has(c.id)) continue
        const t = tentPorId.get(c.id)
        if (t && (t.desistiu || new Date(t.proxima_em).getTime() > Date.now())) continue

        emitidas++
        let ok = false, erro = ""
        try {
          const r = await fetch(`${SUPABASE_URL}/functions/v1/emitir-nfce`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${SERVICE_KEY}`, apikey: SERVICE_KEY },
            body: JSON.stringify(c.tipo === "comanda" ? { acao: "emitir", comanda_id: c.id } : { acao: "emitir", pedido_id: c.id }),
          })
          const d = await r.json().catch(() => ({}))
          ok = d?.ok === true
          erro = String(d?.mensagem ?? d?.error ?? `HTTP ${r.status}`).slice(0, 300)
        } catch (e) { erro = String(e).slice(0, 300) }

        if (ok) { resumo.push({ loja: nome, id: c.id, emitida: true }); continue }

        const n = (t?.tentativas ?? 0) + 1
        const desistiu = n >= MAX_TENTATIVAS
        const proxima = new Date(Date.now() + n * 5 * 60 * 1000).toISOString()   // 5, 10, 15 min
        // Indice unico PARCIAL nao serve de alvo do upsert: insere ou atualiza na mao.
        if (t) {
          await sb.from("nfce_auto_tentativas").update({ tentativas: n, ultimo_erro: erro, proxima_em: proxima, desistiu }).eq("id", t.id)
        } else {
          await sb.from("nfce_auto_tentativas").insert({
            empresa_id: loja.empresa_id,
            pedido_id: c.tipo === "pedido" ? c.id : null,
            comanda_id: c.tipo === "comanda" ? c.id : null,
            tentativas: n, ultimo_erro: erro, proxima_em: proxima, desistiu,
          })
        }
        resumo.push({ loja: nome, id: c.id, emitida: false, tentativa: n, erro })

        if (desistiu && !t?.avisado) {
          await sb.from("nfce_auto_tentativas").update({ avisado: true })
            .eq(c.tipo === "pedido" ? "pedido_id" : "comanda_id", c.id)
          await avisarDono(sb,
            `⚠️ *NFC-e automática falhou* — ${nome}\n\nA venda (${c.rotulo}) não conseguiu emitir depois de ${MAX_TENTATIVAS} tentativas.\nMotivo: ${erro}\n\n_A loja pode emitir à mão em Notas Fiscais._`)
        }
      }
    }
  } catch (e) {
    console.error("[nfce-auto] erro:", e)
    return new Response(JSON.stringify({ ok: false, erro: String(e).slice(0, 300) }), { status: 500 })
  }
  return new Response(JSON.stringify({ ok: true, tentadas: emitidas, resumo }), { headers: { "Content-Type": "application/json" } })
})
