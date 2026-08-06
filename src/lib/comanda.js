// Rótulo de uma comanda, do mesmo jeito em toda a tela e no papel.
//
// A comanda de BALCÃO (mig 0143) não pertence a mesa nenhuma e tem numeração
// própria, que zera todo dia. Ou seja: a "Comanda 3" e a "Mesa 3" podem existir
// ao mesmo tempo — é o rótulo que separa as duas no Salão, na Cozinha, no painel
// do gestor, na conta impressa e no histórico. Espelha rotulo_comanda() do banco.
export function rotuloComanda(c, { comNome = true } = {}) {
  if (!c) return 'Mesa —'
  if (c.tipo === 'balcao') {
    const nome = comNome ? String(c.nome_cliente ?? '').trim() : ''
    return `Comanda ${String(c.numero_mesa ?? '').padStart(2, '0')}${nome ? ` · ${nome}` : ''}`
  }
  return `Mesa ${c.numero_mesa ?? '—'}`
}

export const ehComandaBalcao = (c) => c?.tipo === 'balcao'
