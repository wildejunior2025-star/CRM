import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabaseClient'
import { useAuth } from './useAuth'
import { etapasDaLoja, etapaAtual, obrigatoriasPendentes } from '../lib/configurarLoja'

// Estado do "Configurar Loja" (mig 0273). Usado pelo menu (número vermelho) e
// pela própria tela. Quem muda alguma coisa avisa pelo evento abaixo, e todo
// mundo que usa o hook confere de novo.
export const EVENTO_ATUALIZAR = 'configurar-loja:atualizar'

export function avisarConfigurarLoja() {
  window.dispatchEvent(new Event(EVENTO_ATUALIZAR))
}

export function useConfigurarLoja({ ativo = true } = {}) {
  const { profile, empresa } = useAuth()
  const [status, setStatus] = useState(null)
  const [carregando, setCarregando] = useState(true)
  const podeVer = ativo && !!empresa?.id && profile?.perfil === 'admin'

  const recarregar = useCallback(async () => {
    if (!podeVer) { setStatus(null); setCarregando(false); return }
    const { data } = await supabase.rpc('onboarding_status')
    setStatus(data ?? null)
    setCarregando(false)
  }, [podeVer])

  // Confere ao abrir, quando alguém avisa e quando a aba volta (o dono foi
  // conectar o Mercado Pago em outra aba e voltou).
  useEffect(() => {
    recarregar()
    const onVis = () => { if (document.visibilityState === 'visible') recarregar() }
    window.addEventListener(EVENTO_ATUALIZAR, recarregar)
    document.addEventListener('visibilitychange', onVis)
    return () => {
      window.removeEventListener(EVENTO_ATUALIZAR, recarregar)
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [recarregar])

  const marcar = useCallback(async (acao, etapa = null) => {
    const { error } = await supabase.rpc('onboarding_marcar', { p_acao: acao, p_etapa: etapa })
    if (!error) avisarConfigurarLoja()
    return !error
  }, [])

  const etapas = useMemo(() => etapasDaLoja(status), [status])
  return {
    status,
    carregando,
    etapas,
    atual: etapaAtual(etapas),
    pendentesObrigatorias: obrigatoriasPendentes(etapas),
    concluido: !!status?.onboarding?.concluido_em,
    recarregar,
    marcar,
  }
}
