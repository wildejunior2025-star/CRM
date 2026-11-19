// FREIO DE RITMO DO WHATSAPP DA LOJA — pra não parecer robô de spam.
//
// POR QUE EXISTE
// Em 19/11/2026 a Sorveteria CDBom levou 24h de restrição da Meta ("parece que
// você pode estar usando ferramentas para enviar mensagens automáticas ou em
// massa"). Não houve disparo nenhum: era atendimento normal. O que derrubou foi
// o RITMO — entre 14:45 e 15:25 a resposta automática do catálogo, com texto e
// link idênticos, saiu pra 11 números diferentes, três deles em 49 segundos.
//
// Nenhuma pessoa digita a mesma mensagem com o mesmo link pra três pessoas
// diferentes em 49 segundos. A Meta nem precisa ler o conteúdo: ela olha a
// cadência e a repetição. Já existia a trava de "um link por hora POR PESSOA"
// (24/10) e ela funcionou direitinho — o que não existia era limite pra LOJA
// INTEIRA, que é onde a rajada aparece.
//
// NINGUÉM DEIXA DE RECEBER. A primeira versão disto segurava a resposta
// dormindo dentro do webhook, por até 20 s. Funcionava, mas prendia a chamada
// e, se o Evolution desistisse de esperar, a mensagem se perdia. Agora o que
// não cabe agora entra NA FILA (mig 0459) e sai na vez dele, pelo carteiro
// `whatsapp-fila`. Espera, mas vai.
//
// O QUE ELE NÃO FAZ
//   - Não segura mensagem que a LOJA digitou (origem = "loja"). Aquilo é gente
//     de verdade respondendo e não pode esperar.
//   - Não segura a segunda mensagem pra MESMA pessoa: no meio de uma conversa,
//     duas falas seguidas é o normal. Segurar ali deixaria o robô estranho sem
//     ganhar nada — a rajada que pega mal é a que varre vários números.

// deno-lint-ignore-file no-explicit-any

/** Intervalo mínimo entre duas automáticas pra números DIFERENTES. */
export const INTERVALO_SEG = 20
/** Tempo de digitação, pra resposta não sair instantânea. */
const HUMANO_MIN_MS = 1_500
const HUMANO_MAX_MS = 5_000

const dormir = (ms: number) => new Promise(r => setTimeout(r, ms))

/**
 * Tenta a vaga da loja AGORA.
 *
 * @returns null  → pode mandar na hora (é o caso da esmagadora maioria:
 *                  a média da rede é 3 automáticas por 10 minutos).
 *          Date  → não cabia; já está na fila, e sai nesse horário.
 */
export async function pegarAVez(
  supabase: any, empresaId: string, phone: string, texto: string, tipo = "robo",
): Promise<Date | null> {
  if (!empresaId || !texto) return null
  try {
    const { data, error } = await supabase.rpc("whatsapp_fila_agendar", {
      p_empresa: empresaId, p_phone: phone, p_texto: texto,
      p_tipo: tipo, p_intervalo: INTERVALO_SEG,
    })
    if (error) {
      // Freio é proteção, não é portão: quebrou, manda na hora. Cliente sem
      // resposta é pior do que o risco de uma mensagem fora de ritmo.
      console.error("[ritmo] fila falhou, mandando direto:", error.message)
      return null
    }
    return data ? new Date(String(data)) : null
  } catch (e) {
    console.error("[ritmo] fila quebrou, mandando direto:", e)
    return null
  }
}

/**
 * O tempo de digitação, pra resposta não sair em 300 ms. Só isso — o
 * espaçamento entre números diferentes é da fila.
 *
 * @param humano  false nos avisos de pedido: ali o cliente está esperando a
 *                informação, não uma conversa.
 */
export async function respirarAntesDeEnviar(
  _supabase: any, _empresaId: string, _phone: string, humano = true,
): Promise<void> {
  if (!humano) return
  await dormir(HUMANO_MIN_MS + Math.random() * (HUMANO_MAX_MS - HUMANO_MIN_MS))
}

/** Os 8 últimos dígitos, que é como o resto do sistema compara telefone. */
const chave8 = (t: string) => String(t ?? "").replace(/\D/g, "").slice(-8)

/**
 * Quantas automáticas a loja mandou nos últimos N minutos, e pra quantos
 * números. É o que o vigia (monitor-whatsapp) usa pra avisar ANTES da punição.
 */
export async function ritmoDaLoja(
  supabase: any, empresaId: string, minutos = 60,
): Promise<{ mensagens: number; numeros: number }> {
  try {
    const desde = new Date(Date.now() - minutos * 60_000).toISOString()
    const { data } = await supabase.from("whatsapp_conversas")
      .select("phone")
      .eq("empresa_id", empresaId).eq("role", "assistant").is("origem", null)
      .gte("created_at", desde).limit(1000)
    const linhas = Array.isArray(data) ? data : []
    return { mensagens: linhas.length, numeros: new Set(linhas.map((l: any) => chave8(l.phone))).size }
  } catch {
    return { mensagens: 0, numeros: 0 }
  }
}
