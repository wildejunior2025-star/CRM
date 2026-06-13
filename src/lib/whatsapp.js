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
