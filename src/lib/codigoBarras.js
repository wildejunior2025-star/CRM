// LEITOR DE CÓDIGO DE BARRAS (mig 0283).
//
// O leitor USB é um TECLADO: ele "digita" os números do código bem rápido e
// termina com Enter. Não tem driver, não tem instalação — quem plugar já está
// funcionando. O trabalho do sistema é só reconhecer que aquilo foi uma bipada
// e achar o produto dono do número.

/** Normaliza pra comparar: sem espaço e sem zero à esquerda (EAN-8 x EAN-13). */
export function normalizarCodigo(valor) {
  const limpo = String(valor ?? '').trim()
  if (!limpo) return ''
  // Zero à esquerda só some quando o resto é número: código interno com letra
  // ("A0012") continua inteiro.
  return /^[0-9]+$/.test(limpo) ? limpo.replace(/^0+([0-9])/, '$1') : limpo.toUpperCase()
}

/** O produto dono deste código, ou null. */
export function acharPorCodigo(produtos, texto) {
  const alvo = normalizarCodigo(texto)
  if (!alvo || alvo.length < 4) return null
  return (produtos ?? []).find(p => p.codigo_barras && normalizarCodigo(p.codigo_barras) === alvo) ?? null
}

/** O texto digitado combina com o nome OU com o código de barras do produto. */
export function combinaCodigo(produto, texto) {
  const alvo = normalizarCodigo(texto)
  if (!alvo || !produto?.codigo_barras) return false
  return normalizarCodigo(produto.codigo_barras).startsWith(alvo)
}

// PEGA-BIPADA PRA TELA INTEIRA.
//
// O leitor joga as teclas em QUEM ESTIVER com o cursor. Na prática o atendente
// clica em qualquer lugar da tela e bipa — e aí os números iam pro nada, ou pior,
// pro meio do nome do cliente. Este ouvinte fica na tela toda: junta as teclas
// que chegam em rajada (gente não digita 13 números em meio segundo) e entrega o
// código quando vem o Enter.
//
// Só entra em ação quando o cursor NÃO está num campo de digitação — lá o campo
// já recebe a bipada e trata sozinho.
export function ouvirBipada(aoLerCodigo, { minimo = 4 } = {}) {
  let buffer = ''
  let ultima = 0

  function digitando() {
    const el = document.activeElement
    if (!el) return false
    const tag = String(el.tagName || '').toLowerCase()
    return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable
  }

  function onKeyDown(e) {
    if (digitando()) { buffer = ''; return }
    if (e.ctrlKey || e.altKey || e.metaKey) return
    const agora = Date.now()
    // Pausa longa = começou outra coisa. Sem isto, duas bipadas separadas por
    // um minuto grudariam num código só.
    if (agora - ultima > 500) buffer = ''
    ultima = agora

    if (e.key === 'Enter') {
      const codigo = buffer
      buffer = ''
      if (codigo.length >= minimo) { e.preventDefault(); aoLerCodigo(codigo) }
      return
    }
    if (e.key.length !== 1) return
    // Rajada: o leitor manda tecla atrás de tecla. Gente digitando devagar não
    // forma código nenhum aqui — e se formar, só vale com o Enter no fim.
    buffer += e.key
  }

  document.addEventListener('keydown', onKeyDown, true)
  return () => document.removeEventListener('keydown', onKeyDown, true)
}
