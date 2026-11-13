// A data de HOJE pelo relógio de quem está na frente do computador.
//
// Por que existe: `new Date().toISOString()` devolve a data em UTC, e o
// Brasil está 3 horas atrás. Das 21h à meia-noite o sistema já estava no dia
// seguinte. Na academia, que fecha às 22h, isso jogou 22 mensalidades
// recebidas à noite pro caixa do dia seguinte — e o aviso de "já recebi
// dessa pessoa hoje" parava de funcionar justamente no horário de pico.
export function iso(d = new Date()) {
  const p = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export const hojeIso = () => iso()

// dd/mm/aaaa a partir do ISO, sem passar por Date (que de novo mexeria no
// fuso e mostraria o dia anterior).
export const dataBr = s => (s ? String(s).slice(0, 10).split('-').reverse().join('/') : '')
