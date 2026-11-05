// Em que semana do ciclo o aluno está.
//
// O professor monta 8 semanas (o quadro do verso do cartão: 3x12-15 na 1,
// 4x8-12 na 7...). Até aqui o app do aluno mostrava sempre a PRIMEIRA — a
// progressão de carga, que é o motivo de existir o microciclo, nunca
// acontecia. Agora a semana é uma conta a partir do dia em que o ciclo
// começou (academia_alunos.microciclo_inicio).
//
// Terminado o ciclo, ele NÃO volta pra semana 1 sozinho: trava na última
// montada e avisa o professor. Recomeçar é decisão de quem prescreve.

export function semanaAtual(inicio, quantasSemanas) {
  if (!inicio || !quantasSemanas) return { numero: 1, terminou: false, total: quantasSemanas || 0 }
  const hoje = new Date(); hoje.setHours(0, 0, 0, 0)
  const [ano, mes, dia] = String(inicio).slice(0, 10).split('-').map(Number)
  const comeco = new Date(ano, mes - 1, dia)
  const dias = Math.floor((hoje - comeco) / 86400000)
  const bruta = Math.floor(Math.max(0, dias) / 7) + 1
  return {
    numero: Math.min(bruta, quantasSemanas),
    terminou: bruta > quantasSemanas,
    total: quantasSemanas,
  }
}

export const hojeIso = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
