import { supabase } from './supabaseClient'

/**
 * Substitui variáveis no template da mensagem.
 * Exemplo: formatWaMessage('Olá {nome}!', { nome: 'João' }) => 'Olá João!'
 * Variáveis sem valor no objeto retornam a chave original (ex: {valor}) para evitar
 * mensagens com campos em branco enviadas ao cliente.
 */
export function formatWaMessage(template, vars) {
  return template.replace(/\{(\w+)\}/g, (_, key) => vars[key] ?? `{${key}}`)
}

/**
 * Dispara a Edge Function send-whatsapp.
 * Lança erro se a requisição falhar (sem WhatsApp configurado, número inválido, etc).
 * O chamador decide se exibe o erro ao usuário ou apenas loga — não engole silenciosamente.
 */
export async function notificarEstoqueBaixo() {
  try {
    const { data: { session } } = await supabase.auth.getSession()
    if (!session) return

    const { data: config } = await supabase
      .from('whatsapp_config')
      .select('admin_phone, ativo, notif_estoque')
      .single()

    if (!config?.ativo || !config?.notif_estoque || !config?.admin_phone) return

    const { data: produtos } = await supabase
      .from('produtos')
      .select('id, nome, estoque_minimo')
      .eq('ativo', true)
      .gt('estoque_minimo', 0)

    if (!produtos?.length) return

    const { data: saldos } = await supabase
      .from('estoque_saldo')
      .select('produto_id, saldo_atual')
      .in('produto_id', produtos.map(p => p.id))

    const baixos = produtos.filter(p => {
      const s = saldos?.find(s => s.produto_id === p.id)
      return s && Number(s.saldo_atual) <= Number(p.estoque_minimo)
    })

    if (!baixos.length) return

    const lista = baixos.map(p => {
      const s = saldos.find(s => s.produto_id === p.id)
      return `• ${p.nome}: ${Number(s.saldo_atual)} un (mínimo: ${p.estoque_minimo})`
    }).join('\n')

    await sendWhatsApp({
      phone: config.admin_phone,
      message: `⚠️ *Alerta de estoque baixo!*\n\nOs seguintes produtos precisam de reposição:\n\n${lista}`,
    })
  } catch (_) {}
}

export async function sendWhatsApp({ phone, message, empresaId }) {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) throw new Error('Não autenticado')

  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
  const res = await fetch(`${supabaseUrl}/functions/v1/send-whatsapp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${session.access_token}`,
    },
    body: JSON.stringify({ phone, message, empresa_id: empresaId }),
  })

  const data = await res.json()
  if (!res.ok) throw new Error(data.error || 'Erro ao enviar WhatsApp')
  return data
}
