// Avisa o dono da loja no WhatsApp quando alguém dá ENTRADA no estoque.
//
// POR QUE EXISTE (23/10/2026)
// Pedido do Wilde: "tem dono que quem dá entrada é o funcionário, mas se o
// funcionário bota um a menos ele tem que ficar conferindo". A entrada já fica
// registrada no histórico com quem e quando — só que dono de loja pequena não
// abre histórico, ele está na rua. No zap ele vê na hora e compara com a nota
// do fornecedor sem voltar na loja.
//
// O QUE ESTA FUNÇÃO FAZ
// Só entrega. Quem decide o que é aviso, junta o lote de cada pessoa e escreve
// o texto é a RPC `estoque_entrada_avisos()` (mig 0370) — e é ela que marca os
// movimentos como avisados. Assim a regra fica junto dos dados e não existem
// duas versões da verdade.
//
// PELO ZAP DA PRÓPRIA LOJA, NÃO PELO DA FWC
// Quem fala com o dono é o número que ele já conhece e já tem salvo, o mesmo
// que manda o aviso de pedido. Vindo do número da FWC, viraria mais uma
// mensagem de fornecedor no meio de cem.
//
// Todas as lojas estão na Evolution (conferido em 23/10), então texto livre
// entrega. Se um dia alguma for pra Cloud API, aqui vai precisar de template:
// fora da janela de 24h a Meta recusa texto livre.
//
// Chamada pelo cron de 2 em 2 min. Falhar aqui não pode quebrar nada.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
}

const EVOLUTION_API_URL = (Deno.env.get("EVOLUTION_API_URL") ?? "").replace(/\/$/, "")
const EVOLUTION_API_KEY = Deno.env.get("EVOLUTION_API_KEY") ?? ""

// `telefones` é a lista de donos da loja (mig 0398). `telefone` continua
// vindo pra não quebrar nada que leia um só.
type Aviso = {
  empresa_id: string
  instancia: string
  telefone: string
  telefones?: string[]
  texto: string
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors })

  const json = (d: unknown, s = 200) =>
    new Response(JSON.stringify(d), { status: s, headers: { ...cors, "Content-Type": "application/json" } })

  try {
    const sb = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    )

    // `?seco=1` mostra o que sairia sem mandar nada e SEM marcar como avisado —
    // pra conferir o texto antes de soltar numa loja de verdade.
    const seco = new URL(req.url).searchParams.get("seco") === "1"

    // O gatilho do banco (mig 0371) manda `esperar`. É nessa espera que o lote
    // do fornecedor se junta: a pessoa lança 10 itens em 40 segundos e sai UMA
    // mensagem. Dormir não gasta CPU, só relógio.
    //
    // A chamada da rede de segurança (o cron de 30 min) vem sem `esperar` e
    // processa na hora: ali o lote já acabou faz tempo.
    const corpo = await req.json().catch(() => ({}))
    const esperar = Math.min(Math.max(Number(corpo?.esperar ?? 0) || 0, 0), 90)
    if (esperar && !seco) await new Promise((r) => setTimeout(r, esperar * 1000))
    if (seco) {
      const { data, error } = await sb.rpc("estoque_entrada_avisos_previa")
      if (error) return json({ ok: false, erro: error.message }, 500)
      return json({ ok: true, seco: true, avisos: data ?? [] })
    }

    const { data, error } = await sb.rpc("estoque_entrada_avisos")
    if (error) return json({ ok: false, erro: error.message }, 500)

    const avisos: Aviso[] = (data ?? []) as Aviso[]
    if (!avisos.length) return json({ ok: true, enviado: 0 })

    if (!EVOLUTION_API_URL || !EVOLUTION_API_KEY) {
      // A RPC já marcou como avisado. Sem o cano, estas mensagens se perdem —
      // o log é o que sobra pra saber o que não saiu.
      console.warn("[estoque-entrada] sem Evolution. Perdidas:", avisos.length)
      return json({ ok: false, erro: "sem_evolution", avisos })
    }

    let enviadas = 0
    for (const a of avisos) {
      // Loja com dois sócios: o mesmo aviso vai pra cada um. O laço é por
      // número justamente pra que um número errado não cale os outros.
      const fones = (a.telefones?.length ? a.telefones : [a.telefone])
        .map((t) => String(t ?? "").replace(/\D/g, ""))
        .filter(Boolean)
      for (const bruto of fones) {
        const numero = bruto.startsWith("55") ? bruto : "55" + bruto
        try {
          const r = await fetch(`${EVOLUTION_API_URL}/message/sendText/${a.instancia}`, {
            method: "POST",
            headers: { "Content-Type": "application/json", apikey: EVOLUTION_API_KEY },
            body: JSON.stringify({ number: numero, text: a.texto }),
          })
          if (r.ok) enviadas++
          else console.error("[estoque-entrada] Evolution recusou:", (await r.text()).slice(0, 200))
        } catch (e) {
          console.error("[estoque-entrada] falhou:", String(e).slice(0, 160))
        }
        // Espaça: é o número da própria loja, sem pressa.
        await new Promise((r) => setTimeout(r, 1200))
      }
    }

    return json({ ok: true, enviado: enviadas, de: avisos.length })
  } catch (e) {
    console.error("[estoque-entrada] erro:", e)
    return json({ ok: false, erro: String(e).slice(0, 300) }, 500)
  }
})
