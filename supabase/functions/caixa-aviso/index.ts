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
    if (!diaId && (!caixaId || !["abertura", "fechamento", "nao_bateu"].includes(momento))) {
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

    // ZAP DA LOJA CAIU? O AVISO NAO PODE MORRER COM ELE (28/10/2026)
    //
    // La em Casa 24 Hrs fechou o caixa 4 vezes em 2 dias e o dono nao recebeu
    // nada. Nao era o numero: era a instancia Evolution da LOJA, desconectada
    // ha dias. A Evolution devolve um "TypeError: Cannot read properties of
    // undefined (reading 'id')" — erro interno dela, que so aparecia num log
    // que ninguem le.
    //
    // O aviso de caixa e sobre DINHEIRO. Ele sai pelo numero da loja porque e
    // o que o dono reconhece, mas se esse numero esta fora do ar o certo e
    // sair pelo numero da FWC, dizendo por que. Silencio e a unica resposta
    // que nao serve.
    const estado = await fetch(`${EVOLUTION_API_URL}/instance/connectionState/${aviso.instancia}`, {
      headers: { apikey: EVOLUTION_API_KEY },
    }).then((r) => r.json()).catch(() => ({}))
    const ligada = (estado?.instance?.state ?? estado?.state) === "open"

    let instancia: string = String(aviso.instancia)
    let texto: string = String(aviso.texto)
    if (!ligada) {
      const { data: cfg } = await sb.from("config_global")
        .select("valor").eq("chave", "admin_sender_instance").maybeSingle()
      instancia = cfg?.valor ?? "crmadmin"
      texto += "\n\n———\n⚠️ Este aviso veio pelo WhatsApp da FWC porque o " +
               "*WhatsApp da sua loja está desconectado*. Reconecte em " +
               "Configurações › WhatsApp pra voltar a receber pelo número da loja."
      console.warn(`[caixa-aviso] instancia ${aviso.instancia} fora do ar; indo por ${instancia}`)
    }

    // Um dono que da erro nao pode calar o aviso dos outros.
    const entregues: string[] = []
    const falhou: string[] = []
    for (const numero of numeros) {
      const r = await fetch(`${EVOLUTION_API_URL}/message/sendText/${instancia}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: EVOLUTION_API_KEY },
        body: JSON.stringify({ number: numero, text: texto }),
      })
      if (r.ok) entregues.push(numero)
      else {
        falhou.push(numero)
        console.error(`[caixa-aviso] Evolution recusou ${numero}:`, (await r.text()).slice(0, 250))
      }
    }

    // NUMERO QUE NAO EXISTE NO WHATSAPP (28/10/2026). A Agv ficou 2 dias sem
    // aviso porque o numero do dono estava com um digito errado — a Evolution
    // respondia `"exists": false` e ninguem via. Quem cuida da plataforma
    // precisa saber, senao a loja acha que o sistema nao funciona.
    if (!entregues.length) {
      const { data: sa } = await sb.from("config_global")
        .select("valor").eq("chave", "super_admin_phone").maybeSingle()
      const socorro = String(sa?.valor ?? "").replace(/\D/g, "")
      if (socorro) {
        const { data: adm } = await sb.from("config_global")
          .select("valor").eq("chave", "admin_sender_instance").maybeSingle()
        // O nome da loja nao vem na RPC; busca aqui, que e um caminho raro.
        const { data: dono } = diaId
          ? await sb.from("caixa_dia").select("empresa_id").eq("id", diaId).maybeSingle()
          : await sb.from("caixas").select("empresa_id").eq("id", caixaId).maybeSingle()
        const { data: emp } = dono?.empresa_id
          ? await sb.from("empresas").select("nome").eq("id", dono.empresa_id).maybeSingle()
          : { data: null }
        await fetch(`${EVOLUTION_API_URL}/message/sendText/${adm?.valor ?? "crmadmin"}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", apikey: EVOLUTION_API_KEY },
          body: JSON.stringify({
            number: socorro.startsWith("55") ? socorro : "55" + socorro,
            text: `🚨 *Aviso de caixa não entregue*\n\nLoja: *${emp?.nome ?? "—"}*\n` +
                  `Número(s) que falharam: ${falhou.join(", ")}\n` +
                  `Instância usada: ${instancia}${ligada ? "" : " (a da loja está fora do ar)"}\n\n` +
                  `_O dono não recebeu o fechamento. Confira o número em Configurações › WhatsApp._`,
          }),
        }).catch(() => {})
      }
      return json({ ok: false, erro: "evolution", falhou, instancia }, 502)
    }

    return json({ ok: true, enviado: true, momento: diaId ? "dia" : momento, para: entregues, falhou, instancia })
  } catch (e) {
    console.error("[caixa-aviso] erro:", e)
    return json({ ok: false, erro: String(e).slice(0, 300) }, 500)
  }
})
