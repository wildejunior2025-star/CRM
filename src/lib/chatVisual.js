// Pedaços visuais que as duas telas de conversa com cara de WhatsApp dividem:
// o Atendimento FWC (Super Admin) e a caixa de Mensagens do gestor. Estilos em
// src/components/AtendimentoFWC.css (classes .atw-*).

const CORES_AVATAR = ['#6d5ccf', '#0b8f7a', '#c2410c', '#2563eb', '#a21caf', '#b45309', '#0e7490', '#be123c']

// Mesma pessoa, mesma cor sempre.
export function corAvatar(chave) {
  let h = 0
  for (const ch of String(chave ?? '')) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return CORES_AVATAR[h % CORES_AVATAR.length]
}

// A letra do avatar. Nome que começa com número/símbolo (telefone) não vira "(".
export function inicialDe(titulo) {
  const t = String(titulo ?? '').replace(/[^\p{L}\p{N} ]/gu, '').trim()
  // Só telefone (ainda sem nome): o WhatsApp mostra uma silhueta, não um dígito.
  if (!t || /^\d/.test(t)) return '👤'
  return t[0]
}

export const horaCurta = (iso) =>
  new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })

// Hora na lista de conversas: hoje → "14:32", ontem → "Ontem", antes → "12/11/26".
export function horaLista(iso) {
  const d = new Date(iso)
  const hoje = new Date()
  if (d.toDateString() === hoje.toDateString()) return horaCurta(iso)
  const ontem = new Date()
  ontem.setDate(hoje.getDate() - 1)
  if (d.toDateString() === ontem.toDateString()) return 'Ontem'
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit' })
}

// Separador de dia dentro da conversa.
export function diaRotulo(iso) {
  const d = new Date(iso)
  const hoje = new Date()
  if (d.toDateString() === hoje.toDateString()) return 'Hoje'
  const ontem = new Date()
  ontem.setDate(hoje.getDate() - 1)
  if (d.toDateString() === ontem.toDateString()) return 'Ontem'
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' })
}

// Primeira bolha de cada sequência do mesmo lado ganha o "rabinho"; mudou o dia,
// entra o separador. `chaveLado(m)` devolve de que lado a mensagem está.
export function agruparBolhas(msgs, chaveLado) {
  const out = []
  let diaAnt = null
  let ladoAnt = null
  for (const m of msgs ?? []) {
    const dia = new Date(m.created_at).toDateString()
    const lado = chaveLado(m)
    const novoDia = dia !== diaAnt
    out.push({ m, novoDia, cauda: novoDia || ladoAnt !== lado })
    diaAnt = dia
    ladoAnt = lado
  }
  return out
}
