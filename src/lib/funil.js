// Funil da Loja Online: em que etapa o cliente parou.
//
// A loja enxergava só o pedido que fechou. Quem abriu o cardápio e foi embora
// não deixava rastro: a CD Bom teve ~53 aberturas num dia e nenhum pedido, e
// não dava pra saber se travou no cardápio, no frete ou no cadastro.
//
// São quatro degraus: abriu → sacola → endereco → pedido. A distância entre
// dois degraus é a resposta.
import { supabase } from './supabaseClient'

// Identifica a VISITA, não a pessoa. Vive no sessionStorage: sobrevive a
// recarregar a página (mesma visita) e morre quando a aba fecha. Sem isso, um
// cliente indeciso que recarrega dez vezes viraria dez clientes no relatório.
//
// Nada aqui identifica ninguém — é um número aleatório, não o telefone nem o
// aparelho. Serve só pra ligar "abriu" e "desistiu" da mesma visita.
const CHAVE = 'fwc_funil_sessao'

export function sessaoDaVisita() {
  try {
    let s = sessionStorage.getItem(CHAVE)
    if (!s) {
      s = (crypto?.randomUUID?.() ?? String(Date.now()) + Math.random().toString(36).slice(2))
      sessionStorage.setItem(CHAVE, s)
    }
    return s
  } catch {
    // Navegador com armazenamento bloqueado (aba anônima com restrição): a
    // visita não é rastreada. Melhor perder um número do que quebrar a loja.
    return null
  }
}

// Evita ida ao servidor repetida na mesma aba. O índice único no banco é a
// garantia de verdade; isto aqui é só pra não bater à toa.
const jaEnviadas = new Set()

/**
 * Marca que a visita chegou nesta etapa.
 *
 * É "melhor esforço" de propósito: se falhar, falha calada. Um relatório
 * incompleto é um problema pequeno; uma loja que não abre porque o contador
 * quebrou é um problema grande.
 *
 * @param empresaId loja dona do cardápio
 * @param etapa     'abriu' | 'sacola' | 'endereco' | 'pedido'
 * @param valor     total da sacola, quando fizer sentido
 */
export function marcarEtapa(empresaId, etapa, valor = null) {
  if (!empresaId || !etapa) return
  const sessao = sessaoDaVisita()
  if (!sessao) return
  const chave = `${sessao}:${etapa}`
  if (jaEnviadas.has(chave)) return
  jaEnviadas.add(chave)
  try {
    supabase.from('loja_funil').insert({
      empresa_id: empresaId,
      sessao,
      etapa,
      valor: valor != null ? Number(valor) : null,
    }).then(() => {}, () => {})
  } catch { /* ignora */ }
}

/**
 * Guarda o que a pessoa já digitou no cadastro do checkout: nome, telefone e
 * CEP. Serve pra responder o que o funil sozinho não responde — "essas cinco
 * que travaram no endereço são cinco pessoas ou uma tentando cinco vezes?" e
 * "elas moram fora do raio de entrega?".
 *
 * Grava por uma função no banco (mig 0218), não direto na tabela: assim o
 * visitante anônimo não ganha permissão de mexer em nada. Cada chamada só
 * ACRESCENTA o que veio preenchido — quem digita o nome agora e o CEP daqui a
 * um minuto não perde o nome.
 *
 * Falha calada, igual ao resto do funil: contador quebrado não pode derrubar
 * um checkout.
 */
export function anotarContato(empresaId, { nome, telefone, cep } = {}) {
  if (!empresaId) return
  if (!nome && !telefone && !cep) return
  const sessao = sessaoDaVisita()
  if (!sessao) return
  try {
    supabase.rpc('funil_contato', {
      p_empresa: empresaId,
      p_sessao: sessao,
      p_nome: nome || null,
      p_telefone: telefone || null,
      p_cep: cep || null,
    }).then(() => {}, () => {})
  } catch { /* ignora */ }
}
