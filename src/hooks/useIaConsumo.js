// Quanto da IA a loja já usou neste mês.
//
// Fica num hook porque dois lugares mostram o mesmo número: a barrinha no pé do
// menu e a tela de Assistente IA. Cada um buscando por conta daria contas
// diferentes na mesma tela quando uma pergunta acontecesse no meio.

import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../lib/supabaseClient'
import { useAuth } from './useAuth'

export function useIaConsumo() {
  const { profile } = useAuth()
  const empresaId = profile?.empresa_id
  const [dados, setDados] = useState(null)
  const [carregando, setCarregando] = useState(true)

  const carregar = useCallback(async () => {
    if (!empresaId) return
    const mesIni = new Date()
    mesIni.setDate(1); mesIni.setHours(0, 0, 0, 0)

    const [mes, emp] = await Promise.all([
      // O gasto é da LOJA inteira: a franquia é uma só, e dois gerentes
      // perguntando dividem o mesmo bolo.
      supabase.from('assistente_conversas').select('custo_brl')
        .gte('created_at', mesIni.toISOString()),
      supabase.from('empresas').select('ia_saldo_centavos, ia_franquia_centavos')
        .eq('id', empresaId).maybeSingle(),
    ])

    const franquia = Number(emp.data?.ia_franquia_centavos ?? 500) / 100
    const saldo = Number(emp.data?.ia_saldo_centavos ?? 0) / 100
    const usado = (mes.data ?? []).reduce((s, r) => s + Number(r.custo_brl || 0), 0)
    const restaFranquia = Math.max(0, franquia - usado)
    const perguntas = (mes.data ?? []).length

    setDados({
      franquia, saldo, usado, perguntas,
      restaFranquia,
      disponivel: restaFranquia + saldo,
      pct: franquia > 0 ? Math.min(100, Math.round((usado / franquia) * 100)) : 100,
      // Não existe "quantas perguntas faltam": o custo depende do tamanho de
      // cada pergunta, e qualquer contagem seria um chute que o dono cobraria
      // da gente depois. O que a tela mostra é quanto ainda dá pra usar.
    })
    setCarregando(false)
  }, [empresaId])

  useEffect(() => { carregar() }, [carregar])

  return { ...(dados ?? {}), carregando, recarregar: carregar }
}
