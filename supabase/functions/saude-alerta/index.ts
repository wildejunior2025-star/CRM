// Avisa no WhatsApp quando a saúde do banco piora.
//
// POR QUE EXISTE
// Em 23/09/2026 o sistema parou no almoço e o dono só soube quando as lojas
// ligaram. O sinal vinha subindo desde 20/09 (CPU de 32% → 99%), mas não havia
// motivo pra alguém abrir o painel e olhar. As barras da mig 0280 resolveram
// metade do problema: mostram — mas só pra quem está olhando. Esta função vai
// atrás da pessoa.
//
// O QUE FAZ
// Só isso: pergunta ao banco se é hora de avisar e, se for, manda. Toda a
// decisão (níveis, anti-repetição, texto) mora em `plataforma_saude_avisar()`,
// na mig 0281 — assim a regra fica ao lado dos dados que ela julga, e o
// WhatsApp do painel nunca discorda das barras da tela.
//
// POR QUE EVOLUTION E NÃO CLOUD API
// O aviso é texto livre e chega a qualquer hora — inclusive de madrugada, que
// é quando a fila costuma crescer sem ninguém ver. A Cloud API oficial, fora da
// janela de 24h, só entrega template aprovado; um alerta que depende de a
// pessoa ter falado com a gente nas últimas 24h não serve como alerta. Mesmo
// caminho que o `admin-alertas` já usa pro resumo do admin.
//
// Chamada pelo cron a cada 10 min (mig 0281). Falhar aqui não pode quebrar
// nada: no pior caso o aviso não sai e o log registra o motivo.

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
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    )

    // `?forcar=1` manda o estado atual mesmo sem mudança — serve pra testar o
    // caminho inteiro sem precisar esperar o sistema passar mal.
    const forcar = new URL(req.url).searchParams.get("forcar") === "1"

    const { data: aviso, error } = await supabase.rpc("plataforma_saude_avisar")
    if (error) return json({ ok: false, erro: error.message }, 500)

    if (!aviso?.enviar && !forcar) {
      return json({ ok: true, enviado: false, motivo: aviso?.motivo, nivel: aviso?.nivel })
    }

    let texto = aviso?.texto
    let telefone = aviso?.telefone

    // No modo forçado a decisão pode ter dito "não mande": monta o texto na mão
    // a partir do estado atual, só pra provar que o cano funciona.
    if (forcar && !aviso?.enviar) {
      const { data: st } = await supabase.rpc("plataforma_saude_status")
      texto = "🔎 *Teste do alerta de saúde*\n\n" +
              `Nível: ${st?.nivel ?? "?"}\n` +
              `Leitura: ${st?.leitura_por_seg ?? "?"}/seg (normal: até 3)\n` +
              `Conexões: ${st?.conexoes ?? "?"} de ${st?.conexoes_max ?? "?"}\n` +
              `Banco: ${st?.banco_mb ?? "?"} MB\n\n` +
              "_Se você recebeu isto, o aviso automático está funcionando._"
      const { data: cfg } = await supabase
        .from("config_global").select("valor").eq("chave", "saude_alerta_phone").maybeSingle()
      telefone = cfg?.valor
    }

    const numero = String(telefone ?? "").replace(/\D/g, "")
    if (!numero) return json({ ok: false, erro: "sem saude_alerta_phone configurado" }, 400)
    if (!EVOLUTION_API_URL || !EVOLUTION_API_KEY) {
      console.warn("[saude-alerta] sem Evolution — aviso não enviado:", texto)
      return json({ ok: false, erro: "sem_evolution", texto })
    }

    const { data: cfgInst } = await supabase
      .from("config_global").select("valor").eq("chave", "admin_sender_instance").maybeSingle()
    const instancia = (cfgInst?.valor ?? "").trim() || INSTANCIA_PADRAO

    const r = await fetch(`${EVOLUTION_API_URL}/message/sendText/${instancia}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: EVOLUTION_API_KEY },
      body: JSON.stringify({ number: numero, text: texto }),
    })

    if (!r.ok) {
      const err = await r.text()
      console.error("[saude-alerta] Evolution recusou:", err.slice(0, 300))
      return json({ ok: false, erro: `evolution: ${err.slice(0, 200)}` }, 502)
    }

    return json({ ok: true, enviado: true, nivel: aviso?.nivel ?? "teste", para: numero })
  } catch (e) {
    console.error("[saude-alerta] erro:", e)
    return json({ ok: false, erro: String(e).slice(0, 300) }, 500)
  }
})
