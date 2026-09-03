import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabaseClient'
import { tocarChamado } from '../lib/somChamado'

// Chamados de atendente abertos no WhatsApp (mig 0228).
//
// O robô só responde o que sabe (cardápio, horário, endereço, taxa). O resto
// ele não inventa: pergunta se pode chamar uma pessoa, e o "sim" do cliente
// vira uma linha aqui. Do lado da loja isso não pode ser um número discreto num
// canto — tem gente esperando resposta no WhatsApp — então toca.
//
// Fica tocando de tempo em tempo enquanto houver chamado aberto. Tocar uma vez
// só é o mesmo que não tocar: o balcão está de costas pro computador.
const REPETE_MS = 30000

export function useChamados(empresaId, ativo = true) {
  const [chamados, setChamados] = useState([])
  const vistosRef = useRef(new Set())
  // O menu lateral e a tela de Conversas usam este hook AO MESMO TEMPO. Se os
  // dois pedirem o canal pelo mesmo nome, o cliente devolve o canal que já foi
  // assinado e o segundo `.on()` estoura ("cannot add postgres_changes callbacks
  // after subscribe"), derrubando a tela inteira. Cada instância tem o seu.
  const canalIdRef = useRef(Math.random().toString(36).slice(2))

  const carregar = useCallback(async () => {
    if (!empresaId || !ativo) return
    const { data } = await supabase
      .from('whatsapp_chamados')
      .select('id, phone, nome, motivo, criado_em')
      .eq('empresa_id', empresaId)
      .is('atendido_em', null)
      .order('criado_em', { ascending: false })
      .limit(20)
    setChamados(data ?? [])
  }, [empresaId, ativo])

  useEffect(() => { carregar() }, [carregar])

  // Chamado novo chega sem recarregar a tela — é o ponto todo do alarme.
  useEffect(() => {
    if (!empresaId || !ativo) return
    const canal = supabase
      .channel(`chamados-${empresaId}-${canalIdRef.current}`)
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'whatsapp_chamados', filter: `empresa_id=eq.${empresaId}` },
        () => carregar())
      .subscribe()
    // removeChannel, não unsubscribe: unsubscribe deixa o canal registrado no
    // cliente, e o próximo `supabase.channel(mesmo nome)` devolve esse zumbi.
    return () => { supabase.removeChannel(canal) }
  }, [empresaId, ativo, carregar])

  // Toca no chamado que ainda não tinha aparecido nesta tela.
  useEffect(() => {
    const novos = chamados.filter(c => !vistosRef.current.has(c.id))
    if (novos.length) {
      novos.forEach(c => vistosRef.current.add(c.id))
      tocarChamado()
    }
  }, [chamados])

  // E continua tocando enquanto ninguém atender.
  useEffect(() => {
    if (!chamados.length) return
    const id = setInterval(tocarChamado, REPETE_MS)
    return () => clearInterval(id)
  }, [chamados.length])

  const atender = useCallback(async (chamadoId) => {
    await supabase.from('whatsapp_chamados')
      .update({ atendido_em: new Date().toISOString() })
      .eq('id', chamadoId)
    setChamados(prev => prev.filter(c => c.id !== chamadoId))
  }, [])

  return { chamados, atender, recarregar: carregar }
}
