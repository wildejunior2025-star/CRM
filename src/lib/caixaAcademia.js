// Liberação do caixa da academia, guardada só na memória desta aba.
//
// Depois de acertar o código, fica liberado por alguns minutos: quem recebe
// de cinco alunos seguidos não digita cinco vezes. Fechou a aba ou
// recarregou, pede de novo — de propósito, pra computador esquecido na
// recepção não ficar aberto.
//
// A academia usa UM login só no balcão (eles não se dão bem com computador),
// então quem diz QUEM está ali é o código: cada pessoa tem o seu, e é o nome
// dela que vai junto do recebimento.

const LIBERADO_MINUTOS = 10

let liberadoAte = 0
let quem = null // { id, nome } de quem abriu o caixa

export const caixaLiberado = () => Date.now() < liberadoAte
export const quemAbriuOCaixa = () => (caixaLiberado() ? quem : null)

export function liberarCaixa(pessoa = null) {
  liberadoAte = Date.now() + LIBERADO_MINUTOS * 60000
  quem = pessoa && pessoa.nome ? pessoa : null
}

export function trancarCaixa() {
  liberadoAte = 0
  quem = null
}
