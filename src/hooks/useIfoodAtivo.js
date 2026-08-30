import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabaseClient'

// "Cardápio iFood" só faz sentido pra quem tem loja conectada no iFood — pra
// todo o resto seria um item de menu que só leva a uma tela pedindo pra
// conectar. Como isso mora em outra tabela (ifood_config, não em empresas),
// precisa de uma consulta; ela é minúscula (uma coluna, uma linha) e o
// resultado fica em cache no módulo, então cada loja custa UMA ida ao banco
// por carregamento da página, não uma por render.
//
// Efeito colateral aceito: quem acabou de conectar o iFood só vê o menu
// aparecer no próximo F5.
const cache = new Map()

export function useIfoodAtivo(empresaId) {
  const [ativo, setAtivo] = useState(() => cache.get(empresaId) ?? null)

  useEffect(() => {
    if (!empresaId) return setAtivo(null)
    if (cache.has(empresaId)) return setAtivo(cache.get(empresaId))

    let vivo = true
    supabase
      .from('ifood_config')
      .select('merchant_id')
      .eq('empresa_id', empresaId)
      .maybeSingle()
      .then(({ data }) => {
        const tem = !!data?.merchant_id
        cache.set(empresaId, tem)
        if (vivo) setAtivo(tem)
      })
    return () => { vivo = false }
  }, [empresaId])

  return ativo
}
