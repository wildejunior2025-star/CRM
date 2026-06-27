// "Meus pedidos" sem login: guardamos no próprio aparelho (localStorage) os
// pedidos que o cliente fez, por loja. Some 48h depois de concluído (entregue
// ou cancelado) para não acumular à toa.

const KEY = 'meus_pedidos_v1'
export const EXPIRA_CONCLUIDO_MS = 48 * 60 * 60 * 1000 // 48 horas

export function listarPedidosSalvos() {
  try { return JSON.parse(localStorage.getItem(KEY) || '[]') } catch { return [] }
}

export function salvarPedidosSalvos(arr) {
  try { localStorage.setItem(KEY, JSON.stringify(arr)) } catch { /* indisponível */ }
}

// Registra um pedido recém-feito (chamado no checkout)
export function registrarPedido(id, empresaId) {
  if (!id) return
  const arr = listarPedidosSalvos()
  if (!arr.some(p => p.id === id)) {
    arr.push({ id, empresaId: empresaId ?? null, createdAt: Date.now() })
    salvarPedidosSalvos(arr)
  }
}
