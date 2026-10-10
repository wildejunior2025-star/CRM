// Liberação do caixa da academia, guardada só na memória desta aba.
//
// Depois de acertar a senha, fica liberado por alguns minutos: quem recebe de
// cinco alunos seguidos não digita cinco vezes. Fechou a aba ou recarregou,
// pede de novo — de propósito, pra computador esquecido na recepção não
// ficar aberto.

const LIBERADO_MINUTOS = 10

let liberadoAte = 0

export const caixaLiberado = () => Date.now() < liberadoAte
export const liberarCaixa = () => { liberadoAte = Date.now() + LIBERADO_MINUTOS * 60000 }
export const trancarCaixa = () => { liberadoAte = 0 }
