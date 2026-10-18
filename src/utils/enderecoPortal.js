// Utilitários de endereço do portal (localStorage)

export const LS_ATIVO     = 'portal_endereco_ativo'
export const LS_HIST      = 'portal_enderecos_historico'
export const LS_REMOVIDOS = 'portal_enderecos_removidos'

// CEP + número + rua: rua achada pelo mapa às vezes vem sem CEP, e só CEP+número juntava endereços diferentes
const chave = e => `${e?.cep ?? ''}|${e?.numero ?? ''}|${e?.endereco ?? ''}`

export function getEnderecoAtivo() {
  try { return JSON.parse(localStorage.getItem(LS_ATIVO) || 'null') } catch { return null }
}

export function getHistorico() {
  try { return JSON.parse(localStorage.getItem(LS_HIST) || '[]') } catch { return [] }
}

function getRemovidos() {
  try { return JSON.parse(localStorage.getItem(LS_REMOVIDOS) || '[]') } catch { return [] }
}

// Endereço que o cliente excluiu: o do perfil (banco) não pode voltar sozinho pra lista
// na próxima vez que o modal abrir.
export function foiRemovido(end) {
  return getRemovidos().includes(chave(end))
}

export function salvarEnderecoAtivo(obj) {
  localStorage.setItem(LS_ATIVO, JSON.stringify(obj))
  window.dispatchEvent(new CustomEvent('endereco-portal-changed'))
}

export function limparEnderecoAtivo() {
  localStorage.removeItem(LS_ATIVO)
  window.dispatchEvent(new CustomEvent('endereco-portal-changed'))
}

export function adicionarAoHistorico(obj) {
  const hist = getHistorico()
  const existe = hist.findIndex(h => chave(h) === chave(obj))
  if (existe >= 0) hist.splice(existe, 1)
  hist.unshift(obj)
  localStorage.setItem(LS_HIST, JSON.stringify(hist.slice(0, 5)))
  // Cadastrou de novo de propósito: deixa de contar como excluído
  localStorage.setItem(LS_REMOVIDOS, JSON.stringify(getRemovidos().filter(k => k !== chave(obj))))
}

// Tira da lista e devolve a lista que sobrou
export function removerDoHistorico(obj) {
  const hist = getHistorico().filter(h => chave(h) !== chave(obj))
  localStorage.setItem(LS_HIST, JSON.stringify(hist))
  const removidos = getRemovidos()
  if (!removidos.includes(chave(obj))) removidos.push(chave(obj))
  localStorage.setItem(LS_REMOVIDOS, JSON.stringify(removidos.slice(-30)))
  return hist
}
