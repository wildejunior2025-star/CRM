// Avisa o dono no WhatsApp quando abrem e quando fecham o caixa.
//
// POR QUE EXISTE (23/10/2026)
// Mesmo motivo do aviso de estoque: o dono não fica na loja e quem mexe no
// caixa é o funcionário. Em 20/10 o Braseiro fechou com R$ 322 na gaveta
// contra R$ 289,48 esperados, e isso só apareceu porque o Wilde foi conferir
// na mão, no dia seguinte. A diferença tem que chegar na hora, não na auditoria.
//
// SÓ ENTREGA. Quem decide se avisa, monta o texto e faz a conta do esperado é
// a RPC `caixa_aviso()` (mig 0375) — a regra fica junto dos dados, e a conta do
// esperado é a MESMA da tela do Caixa. Duas contas do mesmo número sempre
// acabam discordando, e aí o aviso vira motivo de briga em vez de controle.
//
// Chamada pelo gatilho do banco, não por cron: abrir e fechar caixa acontece
// duas vezes por dia, não tem o que ficar vigiando.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
}

const EVOLUTION_API_URL = (Deno.env.get("EVOLUTION_API_URL") ?? "").replace(/\/$/, "")
const EVOLUTION_API_KEY = Deno.env.get("EVOLUTION_API_KEY") ?? ""

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors })

  const json = (d: unknown, s = 200) =>
    new Response(JSON.stringify(d), { status: s, headers: { ...cors, "Content-Type": "application/json" } })

  try {
    const sb = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    )

    const body = await req.json().catch(() => ({}))
    const caixaId = String(body?.caixa_id ?? "")
    const momento = String(body?.momento ?? "")
    // SAO DOIS FECHAMENTOS NO SISTEMA (26/10/2026).
    //
    // `caixas` e a gaveta que abre e fecha. `caixa_dia` e a conferencia do DIA,
    // o botao "Conferir o dia" — e e por ela que a Agv trabalha. A loja fechou
    // R$ 2.692,45 com o aviso LIGADO e ninguem recebeu nada, porque o aviso so
    // conhecia a primeira.
    const diaId = String(body?.caixa_dia_id ?? "")
    if (!diaId && (!caixaId || !["abertura", "fechamento"].includes(momento))) {
      return json({ ok: false, erro: "informe caixa_id + momento, ou caixa_dia_id" }, 400)
    }

    // `?seco=1` devolve o texto sem enviar — pra conferir a mensagem (e a conta
    // do esperado) antes de soltar numa loja de verdade.
    const seco = new URL(req.url).searchParams.get("seco") === "1"

    const { data: aviso, error } = diaId
      ? await sb.rpc("caixa_dia_aviso", { p_id: diaId })
      : await sb.rpc("caixa_aviso", { p_caixa_id: caixaId, p_momento: momento })
    if (error) return json({ ok: false, erro: error.message }, 500)
    // null = loja com o aviso desligado, sem número, ou caixa que não existe.
    if (!aviso?.texto) return json({ ok: true, enviado: false, motivo: "desligado ou sem numero" })
    if (seco) return json({ ok: true, seco: true, ...aviso })

    if (!EVOLUTION_API_URL || !EVOLUTION_API_KEY) {
      console.warn("[caixa-aviso] sem Evolution:", String(aviso.texto).slice(0, 120))
      return json({ ok: false, erro: "sem_evolution", ...aviso })
    }

    // LOJA COM MAIS DE UM DONO (26/10/2026). Antes so dava pra escolher um, e
    // quem tem socio tinha que decidir qual dos dois ia saber do caixa.
    const lista: string[] = Array.isArray(aviso.telefones) && aviso.telefones.length
      ? aviso.telefones.map(String)
      : [String(aviso.telefone ?? "")]
    const numeros = [...new Set(lista
      .map((t) => t.replace(/\D/g, ""))
      .filter((t) => t.length >= 10)
      .map((t) => (t.startsWith("55") ? t : "55" + t)))]
    if (!numeros.length) return json({ ok: false, erro: "sem telefone" }, 400)

    // Um dono que da erro nao pode calar o aviso dos outros.
    const entregues: string[] = []
    const falhou: string[] = []
    for (const numero of numeros) {
      const r = await fetch(`${EVOLUTION_API_URL}/message/sendText/${aviso.instancia}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: EVOLUTION_API_KEY },
        body: JSON.stringify({ number: numero, text: aviso.texto }),
      })
      if (r.ok) entregues.push(numero)
      else {
        falhou.push(numero)
        console.error(`[caixa-aviso] Evolution recusou ${numero}:`, (await r.text()).slice(0, 250))
      }
    }
    if (!entregues.length) return json({ ok: false, erro: "evolution", falhou }, 502)

    return json({ ok: true, enviado: true, momento: diaId ? "dia" : momento, para: entregues, falhou })
  } catch (e) {
    console.error("[caixa-aviso] erro:", e)
    return json({ ok: false, erro: String(e).slice(0, 300) }, 500)
  }
})
