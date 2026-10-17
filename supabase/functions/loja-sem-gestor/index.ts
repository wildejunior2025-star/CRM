// LOJA FECHA QUANDO NÃO TEM NINGUÉM NO GESTOR
//
// Roda de 3 em 3 minutos (cron). Para cada loja com `fecha_sem_gestor` ligado:
//
//   sem sinal de vida há mais de 15 min  -> fecha  (delivery_fechado_por='sem_gestor')
//   sinal de vida voltou                 -> reabre (se estiver no horário)
//
// POR QUE AQUI E NÃO NA TELA: o caso é justamente "não tem ninguém com a tela
// aberta". Se dependesse da tela, nunca rodaria. Quem REABRE pode ser a tela
// (e é, pra ser instantâneo), mas quem FECHA tem que ser o servidor.
//
// A TOLERÂNCIA É FOLGADA DE PROPÓSITO. O Portal pinta "Aberta" com 2 minutos,
// que serve pra uma bolinha; fechar a loja de um cliente por 2 minutos de
// internet ruim seria judiação. 15 minutos é tempo de queda de link, de
// reiniciar o PC, de trocar de aba. Pra ABRIR não tem espera: voltou, abriu.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
const EVOLUTION_API_URL = Deno.env.get("EVOLUTION_API_URL") ?? ""
const EVOLUTION_API_KEY = Deno.env.get("EVOLUTION_API_KEY") ?? ""
const INSTANCIA_PADRAO = "crmadmin"

const MIN_SEM_SINAL = 15        // fecha depois de 15 min sem sinal
const HORAS_ENTRE_AVISOS = 2    // não repete o aviso antes disso

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } })

async function mandarWhats(sb: any, numero: string, texto: string) {
  const n = String(numero ?? "").replace(/\D/g, "")
  if (!n || !EVOLUTION_API_URL || !EVOLUTION_API_KEY) return false
  const { data: cfg } = await sb.from("config_global")
    .select("valor").eq("chave", "admin_sender_instance").maybeSingle()
  const instancia = (cfg?.valor ?? "").trim() || INSTANCIA_PADRAO
  try {
    const r = await fetch(`${EVOLUTION_API_URL}/message/sendText/${instancia}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: EVOLUTION_API_KEY },
      body: JSON.stringify({ number: n, text: texto }),
    })
    if (!r.ok) console.error("[sem-gestor] Evolution recusou:", (await r.text()).slice(0, 200))
    return r.ok
  } catch (e) {
    console.error("[sem-gestor] falha ao enviar:", String(e).slice(0, 200))
    return false
  }
}

Deno.serve(async () => {
  const sb = createClient(SUPABASE_URL, SERVICE_KEY)

  const { data: lojas, error } = await sb
    .from("empresas")
    .select("id, nome, telefone_contato, delivery_ativo, delivery_fechado_por, last_heartbeat_at, sem_gestor_avisado_em")
    .eq("fecha_sem_gestor", true)
  if (error) return json({ ok: false, erro: error.message }, 500)

  // Pra onde vai a cópia de acompanhamento (o dono da plataforma). Fica no
  // config_global pra sair daqui sem deploy quando ele pedir.
  const { data: cfgCopia } = await sb.from("config_global")
    .select("valor").eq("chave", "sem_gestor_copia_phone").maybeSingle()
  const copia = (cfgCopia?.valor ?? "").trim()

  const agora = Date.now()
  const fechadas: string[] = []
  const reabertas: string[] = []

  for (const loja of (lojas ?? [])) {
    const ultimo = loja.last_heartbeat_at ? new Date(loja.last_heartbeat_at).getTime() : 0
    const minSemSinal = (agora - ultimo) / 60000
    const temGente = minSemSinal < MIN_SEM_SINAL

    // Só interessa o horário pra decidir se é hora de alguém estar lá.
    const { data: noHorario } = await sb.rpc("loja_aberta_agora", { p_empresa: loja.id })

    // ── VOLTOU: reabre, mas só o que ESTE mecanismo fechou ──────────────
    // Loja fechada na mão (acabou o produto) continua fechada: quem fechou
    // na mão abre na mão.
    if (temGente && !loja.delivery_ativo && loja.delivery_fechado_por === "sem_gestor") {
      if (noHorario) {
        await sb.from("empresas")
          .update({ delivery_ativo: true, delivery_fechado_por: null, sem_gestor_avisado_em: null })
          .eq("id", loja.id)
        reabertas.push(loja.nome)
      }
      continue
    }
    if (temGente) continue

    // ── SUMIU: fecha se estiver aberta ──────────────────────────────────
    if (loja.delivery_ativo) {
      await sb.from("empresas")
        .update({ delivery_ativo: false, delivery_fechado_por: "sem_gestor" })
        .eq("id", loja.id)
        .eq("delivery_ativo", true)
      fechadas.push(loja.nome)
    }

    // ── AVISA: só quando DEVERIA estar aberta ───────────────────────────
    // Fora do horário não tem o que avisar: ninguém precisa estar no painel
    // de madrugada.
    if (!noHorario) continue
    const avisado = loja.sem_gestor_avisado_em ? new Date(loja.sem_gestor_avisado_em).getTime() : 0
    if (agora - avisado < HORAS_ENTRE_AVISOS * 3600_000) continue

    const texto =
      `⚠️ *${loja.nome}* está no horário de funcionamento, mas *ninguém está com o gestor aberto*.\n\n` +
      `Por isso a loja está *fechada no cardápio* — assim o cliente não faz um pedido que ninguém vai ver.\n\n` +
      `É só abrir o gestor no computador (ou o app) que ela reabre sozinha.`

    const foi = await mandarWhats(sb, loja.telefone_contato ?? "", texto)
    if (copia) await mandarWhats(sb, copia, texto + `\n\n_(cópia de acompanhamento)_`)
    if (foi || copia) {
      await sb.from("empresas").update({ sem_gestor_avisado_em: new Date().toISOString() }).eq("id", loja.id)
    }
  }

  return json({ ok: true, fechadas, reabertas, olhadas: (lojas ?? []).length })
})
