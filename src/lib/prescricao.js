// A prescrição de UM exercício, escrita em uma linha.
//
// Até aqui as séries e repetições vinham das 8 semanas e valiam pro treino
// inteiro. Não dava pra escrever o que o professor faz na prática — por
// exemplo a progressão: "2 séries de 16, descansa 20 segundos e emenda 8
// repetições com o dobro do peso". Agora cada exercício pode ter a sua, e
// quem fica em branco continua seguindo o microciclo da semana.
export function receita(i) {
  const partes = []
  if (i.series && i.repeticoes) partes.push(`${i.series}x ${i.repeticoes}`)
  else if (i.series) partes.push(`${i.series} séries`)
  else if (i.repeticoes) partes.push(i.repeticoes)
  if (i.descanso_seg) partes.push(`descanso ${i.descanso_seg}s`)
  if (i.metodo) partes.push(i.metodo)
  return partes.join(' · ')
}

// Métodos que o professor usa na prática. O campo é livre — isto é só pra ele
// não ter que digitar os de sempre.
export const METODOS = [
  'Progressão',
  'Bi-set',
  'Tri-set',
  'Drop-set',
  'Pirâmide crescente',
  'Pirâmide decrescente',
  'Rest-pause',
  'Negativa (excêntrica)',
  'Isometria',
  'Até a falha',
]
