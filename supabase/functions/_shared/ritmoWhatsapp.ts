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
// O QUE ELE FAZ
//   1. Duas mensagens automáticas pra NÚMEROS DIFERENTES nunca saem coladas:
//      guarda um intervalo mínimo entre elas.
//   2. Dá um tempo de digitação antes de responder. Resposta em 300 ms é
//      carimbo de robô; alguns segundos é gente.
//
// O QUE ELE NÃO FAZ
//   - Não segura mensagem que a LOJA digitou (origem = "loja"). Aquilo é gente
//     de verdade respondendo e não pode esperar.
//   - Não segura a segunda mensagem pra MESMA pessoa: no meio de uma conversa,
//     duas falas seguidas é o normal. Segurar 20 s ali deixaria o robô estranho
//     sem ganhar nada — a rajada que pega mal é a que varre vários números.

type Sb = {
  from: (t: string) => any
}

/** Intervalo mínimo entre duas automáticas pra números DIFERENTES. */
const INTERVALO_MS = 20_000
/** Teto da espera. Aviso de pedido é hora marcada: não pode ficar preso. */
const TETO_MS = 20_000
/** Tempo de digitação, pra resposta não sair instantânea. */
const HUMANO_MIN_MS = 1_500
const HUMANO_MAX_MS = 5_000

const dormir = (ms: number) => new Promise(r => setTimeout(r, ms));

/**
 * Última mensagem AUTOMÁTICA que a loja mandou, e pra quem.
 * Janela curta de propósito: só interessa o que acabou de sair.
 */
async function ultimaAutomatica(
  supabase: Sb, empresaId: string,
): Promise<{ quando: number; phone: string } | null> {
  try {
    const desde = new Date(Date.now() - 3 * 60_000).toISOString()
    const { data } = await supabase.from("whatsapp_conversas")
      .select("created_at, phone")
      .eq("empresa_id", empresaId).eq("role", "assistant").is("origem", null)
      .gte("created_at", desde)
      .order("created_at", { ascending: false }).limit(1)
    const linha = Array.isArray(data) ? data[0] : null
    if (!linha?.created_at) return null
    return { quando: Date.parse(String(linha.created_at)), phone: String(linha.phone ?? "") }
  } catch (e) {
    // Freio é proteção, não é portão: se não dá pra consultar, deixa passar.
    console.error("[ritmo] não consegui olhar o histórico, liberando:", e)
    return null
  }
}

/** Os 8 últimos dígitos, que é como o resto do sistema compara telefone. */
const chave8 = (t: string) => String(t ?? "").replace(/\D/g, "").slice(-8)

/**
 * Espera o tempo necessário antes de uma mensagem AUTOMÁTICA sair.
 *
 * @param humano  false nos avisos de pedido: ali o cliente está esperando a
 *                informação, não uma conversa. O espaçamento continua valendo.
 */
export async function respirarAntesDeEnviar(
  supabase: Sb, empresaId: string, phone: string, humano = true,
): Promise<void> {
  if (!empresaId) return
  const ultima = await ultimaAutomatica(supabase, empresaId)

  let espera = 0
  if (ultima && chave8(ultima.phone) !== chave8(phone)) {
    // Outro número recebeu agora há pouco: completa o intervalo.
    espera = INTERVALO_MS - (Date.now() - ultima.quando)
  }
  if (humano) {
    espera += HUMANO_MIN_MS + Math.random() * (HUMANO_MAX_MS - HUMANO_MIN_MS)
  }

  espera = Math.min(Math.max(espera, 0), TETO_MS)
  if (espera > 0) await dormir(espera)
}

/**
 * Quantas automáticas a loja mandou nos últimos N minutos, e pra quantos
 * números. É o que o vigia (monitor-whatsapp) usa pra avisar ANTES da punição.
 */
export async function ritmoDaLoja(
  supabase: Sb, empresaId: string, minutos = 60,
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
