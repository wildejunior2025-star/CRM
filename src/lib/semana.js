// Navegação por semana — segunda a domingo, com as setas andando pra trás.
//
// Nasceu no Caixa (histórico de caixas) e virou o padrão do sistema: lista
// longa ninguém lê, e quase sempre a pessoa quer olhar uma semana por vez.
// Hoje é usada também no histórico de despesas e nas compras de insumo.
// (O Caixa ainda tem a cópia dele; quando for mexer lá, passa pra cá.)
//
// offset 0 = esta semana, -1 = a passada, e assim por diante.

const pad = (n) => String(n).padStart(2, '0')
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

// Devolve o intervalo da semana em 'YYYY-MM-DD' (pronto pra comparar com
// coluna date do banco e pra jogar num <input type="date">).
export function semanaDe(offset = 0) {
  const inicio = new Date()
  inicio.setHours(0, 0, 0, 0)
  const diaDaSemana = (inicio.getDay() + 6) % 7   // getDay(): 0=domingo; aqui 0=segunda
  inicio.setDate(inicio.getDate() - diaDaSemana + offset * 7)
  const fim = new Date(inicio)
  fim.setDate(inicio.getDate() + 6)               // domingo da mesma semana
  return { inicio: ymd(inicio), fim: ymd(fim) }
}

const ddmmCurto = (s) => {
  const [, m, d] = s.split('-')
  return `${d}/${m}`
}

// "Esta semana · 17/08 a 23/08" — o nome ajuda quem já andou várias semanas
// pra trás a se localizar sem contar nos dedos.
export function rotuloSemana(offset = 0) {
  const { inicio, fim } = semanaDe(offset)
  const faixa = `${ddmmCurto(inicio)} a ${ddmmCurto(fim)}`
  if (offset === 0) return `Esta semana · ${faixa}`
  if (offset === -1) return `Semana passada · ${faixa}`
  return faixa
}

// Qual semana contém esta data? Serve pra descobrir em que offset o usuário
// está quando ele mexeu nas datas na mão.
export function offsetDaSemana(dataYMD) {
  const alvo = semanaDe(0).inicio
  const d = new Date(dataYMD + 'T00:00:00')
  const dia = (d.getDay() + 6) % 7
  d.setDate(d.getDate() - dia)
  const segundaDela = ymd(d)
  const diffMs = new Date(segundaDela + 'T00:00:00') - new Date(alvo + 'T00:00:00')
  return Math.round(diffMs / (7 * 24 * 60 * 60 * 1000))
}
