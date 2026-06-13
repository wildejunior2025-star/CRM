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

    const { data: saldos } = await supabase
      .from('estoque_saldo')
      .select('nome, quantidade_atual, estoque_minimo')
      .gt('estoque_minimo', 0)

    if (!saldos?.length) return

    const baixos = saldos.filter(s => Number(s.quantidade_atual) <= Number(s.estoque_minimo))

    if (!baixos.length) return

    const lista = baixos
      .map(s => `• ${s.nome}: ${Number(s.quantidade_atual)} un (mínimo: ${s.estoque_minimo})`)
      .join('\n')

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
