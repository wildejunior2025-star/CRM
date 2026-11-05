// O dia da semana do treino vinha gravado de DUAS formas: o seletor do
// professor salvava "Qui" e o rascunho da IA salvava "Quinta". Quem comparava
// (o "treino de hoje" do aluno) só conhecia a forma curta — então nenhum
// treino montado pela IA aparecia como o do dia, e o aluno via "você não tem
// treino marcado" numa quinta em que tinha.
//
// Aqui tudo vira a forma curta antes de comparar, com ou sem acento.

export const DIAS_CURTOS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb']

export function curto(dia) {
  if (!dia) return null
  const limpo = String(dia).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().slice(0, 3)
  return DIAS_CURTOS.find(d =>
    d.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase() === limpo) || null
}

export const diaDeHoje = () => DIAS_CURTOS[new Date().getDay()]

export const ehHoje = dia => curto(dia) === diaDeHoje()
