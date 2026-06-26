// Utilitários de endereço do portal (localStorage)

export const LS_ATIVO = 'portal_endereco_ativo'
export const LS_HIST  = 'portal_enderecos_historico'

export function getEnderecoAtivo() {
  try { return JSON.parse(localStorage.getItem(LS_ATIVO) || 'null') } catch { return null }
}

export function getHistorico() {
  try { return JSON.parse(localStorage.getItem(LS_HIST) || '[]') } catch { return [] }
}

export function salvarEnderecoAtivo(obj) {
  localStorage.setItem(LS_ATIVO, JSON.stringify(obj))
  window.dispatchEvent(new CustomEvent('endereco-portal-changed'))
}

export function adicionarAoHistorico(obj) {
  const hist = getHistorico()
  const existe = hist.findIndex(h => h.cep === obj.cep && h.numero === obj.numero)
  if (existe >= 0) hist.splice(existe, 1)
  hist.unshift(obj)
  localStorage.setItem(LS_HIST, JSON.stringify(hist.slice(0, 5)))
}
