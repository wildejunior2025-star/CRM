// Pedaços compartilhados da área de ligações (mig 0292).

export const SIM_NAO = [
  { v: true, t: 'Sim' },
  { v: false, t: 'Não' },
]

export function digitos(s) {
  return String(s || '').replace(/\D/g, '')
}

export function primeiroNome(s) {
  const n = String(s || '').trim().split(/\s+/)[0] || ''
  return n ? n.charAt(0).toUpperCase() + n.slice(1).toLowerCase() : ''
}

export function dataHora(iso) {
  if (!iso) return ''
  return new Date(iso).toLocaleString('pt-BR', {
    weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  })
}
