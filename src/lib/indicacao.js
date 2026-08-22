import { supabase } from './supabaseClient'

// Indicação: guarda quem mandou o link até o amigo comprar (mig 0176).
//
// CHAVE ÚNICA, sem empresa no nome. A primeira versão usava uma chave por loja
// e o par guardar/ler acabou em telas diferentes — guardava numa página e lia
// noutra, então a indicação nunca era registrada. Uma chave só não tem como
// desencontrar. Token de outra loja não é risco: o `indicacao_registrar` recusa
// quando indicador e indicado não são da mesma empresa.
const CHAVE = 'fwc_indicacao'

// O token tem 10 hex (clientes.token). Validar aqui evita gravar sujeira que
// veio na URL e ter que tratar lá na frente.
const VALIDO = /^[a-f0-9]{10}$/

// Chegou por `?ind=`? Guarda. NÃO sobrescreve o que já está guardado: quem
// indicou primeiro é quem leva, senão o último link aberto roubaria a
// indicação de quem realmente trouxe o cliente.
export function capturarIndicacao() {
  try {
    const ind = new URLSearchParams(window.location.search).get('ind')
    if (ind && VALIDO.test(ind) && !localStorage.getItem(CHAVE)) {
      localStorage.setItem(CHAVE, ind)
    }
  } catch { /* localStorage indisponível (modo privado restrito) */ }
}

// Amarra o vínculo depois que o cliente foi criado no checkout. O crédito dos
// dois só cai quando ESTE pedido for entregue — aqui é só o vínculo.
//
// Best-effort de propósito: indicação recusada (auto-indicação, mesmo telefone,
// já era cliente) não pode derrubar o pedido, que é o que importa no momento.
export async function registrarIndicacao(clienteId) {
  if (!clienteId) return null
  try {
    const ind = localStorage.getItem(CHAVE)
    if (!ind) return null
    const { data } = await supabase.rpc('indicacao_registrar', {
      p_token_indicador: ind, p_cliente_id: clienteId,
    })
    // Some com a chave em qualquer desfecho: aceita, ou recusada por um motivo
    // que não vai mudar (auto-indicação, já era cliente). Deixar guardado só
    // faria a mesma tentativa se repetir em todo pedido futuro.
    localStorage.removeItem(CHAVE)
    return data ?? null
  } catch {
    return null
  }
}
