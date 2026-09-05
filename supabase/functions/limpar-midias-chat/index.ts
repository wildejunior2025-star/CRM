// Faxina das mídias do chat (mig 0242).
//
// A foto e o áudio do WhatsApp vivem 24 horas no bucket `chat-midias`. Depois
// disso o arquivo é apagado e a mensagem continua na conversa sem o anexo —
// quem precisar rever abre o WhatsApp, que é onde a conversa mora de verdade.
//
// É esse prazo que deixa o custo CONSTANTE em vez de crescente: não importa
// quantos meses o sistema rode, o bucket guarda sempre mais ou menos o mesmo
// tanto. Sem ele eu precisaria de cota por loja e faxina por tamanho.
//
// Roda de hora em hora pelo pg_cron. Apagar em lote e só então limpar as
// colunas: se o storage falhar no meio, a próxima rodada pega o que sobrou —
// o contrário (limpar a coluna primeiro) deixaria arquivo órfão pra sempre.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? ""
const SUPABASE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders })

  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)
  let apagados = 0
  let falhas = 0

  try {
    // Lotes de 500. Loja movimentada num dia de pico não passa disso, e o teto
    // evita uma rodada que estoure o tempo da função.
    for (let volta = 0; volta < 4; volta++) {
      const { data: vencidas, error } = await supabase.rpc("midias_do_chat_vencidas", { p_limite: 500 })
      if (error) { console.error("[faxina] rpc erro:", error.message); break }
      const lista = Array.isArray(vencidas) ? vencidas : []
      if (!lista.length) break

      const caminhos = lista.map((m: Record<string, unknown>) => String(m.midia_path)).filter(Boolean)
      const { error: errStorage } = await supabase.storage.from("chat-midias").remove(caminhos)
      if (errStorage) {
        // Arquivo que já não existe não é erro pra gente: o objetivo é que ele
        // não esteja lá. Segue e limpa as colunas do mesmo jeito.
        console.error("[faxina] storage:", errStorage.message)
        falhas++
      }

      const ids = lista.map((m: Record<string, unknown>) => String(m.id))
      const { error: errMarca } = await supabase.rpc("marcar_midias_apagadas", { p_ids: ids })
      if (errMarca) { console.error("[faxina] marcar erro:", errMarca.message); break }

      apagados += caminhos.length
      if (lista.length < 500) break
    }

    console.log(`[faxina] ${apagados} mídia(s) apagada(s), ${falhas} aviso(s) do storage`)
    return new Response(JSON.stringify({ ok: true, apagados, falhas }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    })
  } catch (e) {
    console.error("[faxina] erro geral:", (e as Error)?.message)
    return new Response(JSON.stringify({ ok: false, erro: String((e as Error)?.message) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    })
  }
})
