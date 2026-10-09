import { supabase } from './supabaseClient'

// Mensalidade da academia (mig 0294). "Renovar" grava o pagamento E empurra o
// vencimento; cancelar desfaz os dois.

export const FORMAS = [
  { id: 'dinheiro', nome: 'Dinheiro' },
  { id: 'pix', nome: 'PIX' },
  { id: 'cartao', nome: 'Cartão' },
  { id: 'outro', nome: 'Outro' },
]

export const hojeIso = () => new Date().toISOString().slice(0, 10)

// Soma meses no vencimento. Aluno em dia ganha a partir do vencimento dele;
// aluno vencido conta de hoje, senão ele pagaria por um mês que já passou.
export function somarMeses(vencimento, meses = 1, apartirDe = hojeIso()) {
  const base = vencimento && vencimento >= apartirDe ? vencimento : apartirDe
  const d = new Date(base + 'T00:00:00')
  const dia = d.getDate()
  d.setDate(1)
  d.setMonth(d.getMonth() + meses)
  // 31 de janeiro + 1 mês = 28/29 de fevereiro, não 3 de março.
  const ultimo = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()
  d.setDate(Math.min(dia, ultimo))
  return d.toISOString().slice(0, 10)
}

// `partes`: pagamento em duas formas, ex. metade dinheiro e metade cartao.
// Fica UM pagamento so (uma mensalidade), com as partes guardadas dentro;
// assim a conta por forma sai certa sem contar a mensalidade duas vezes.
export async function registrarPagamento({ empresaId, aluno, valor, forma, meses = 1, data = hojeIso(), observacao = null, partes = null }) {
  const vencimentoDepois = somarMeses(aluno.vencimento, meses, data)
  const { data: user } = await supabase.auth.getUser()
  const { error: e1 } = await supabase.from('academia_pagamentos').insert({
    empresa_id: empresaId,
    aluno_id: aluno.id,
    valor,
    forma: partes ? 'dividido' : forma,
    partes,
    meses,
    data,
    vencimento_antes: aluno.vencimento,
    vencimento_depois: vencimentoDepois,
    observacao,
    criado_por: user?.user?.id ?? null,
  })
  if (e1) throw e1
  const { error: e2 } = await supabase
    .from('academia_alunos')
    .update({ vencimento: vencimentoDepois, ativo: true })
    .eq('id', aluno.id)
  if (e2) throw e2
  return vencimentoDepois
}

// Cancelar devolve o vencimento ao que era antes — só faz sentido no último
// pagamento do aluno, então é isso que a tela oferece.
export async function cancelarPagamento(pagamento) {
  const { error: e1 } = await supabase
    .from('academia_pagamentos')
    .update({ cancelado: true })
    .eq('id', pagamento.id)
  if (e1) throw e1
  const { error: e2 } = await supabase
    .from('academia_alunos')
    .update({ vencimento: pagamento.vencimento_antes })
    .eq('id', pagamento.aluno_id)
  if (e2) throw e2
}

export const dinheiro = v => `R$ ${Number(v || 0).toFixed(2).replace('.', ',')}`
export const dataBr = iso => (iso ? iso.split('-').reverse().join('/') : '')
