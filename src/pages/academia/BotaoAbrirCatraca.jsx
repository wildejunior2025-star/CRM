import { useEffect, useRef, useState } from 'react'
import { supabase } from '../../lib/supabaseClient'
import { useAuth } from '../../hooks/useAuth'
import { serialSuportado, liberarCatraca, fecharPorta } from '../../lib/catracaSerial'

// Botão da barra de cima: abre a catraca na mão, pra visitante, aluno que
// ainda não cadastrou o rosto e prestador de serviço (mig 0295).
//
// No computador ligado na catraca, abre direto. Em qualquer outro aparelho,
// avisa o computador que está com a tela /porta aberta — o mesmo caminho que
// a Recepção do celular usa.

export default function BotaoAbrirCatraca() {
  const { empresa } = useAuth()
  const [estado, setEstado] = useState('') // '' | 'abrindo' | 'ok' | mensagem de erro
  const canal = useRef(null)

  useEffect(() => {
    if (!empresa?.id) return
    const c = supabase.channel(`catraca-${empresa.id}`)
    c.subscribe(st => { if (st === 'SUBSCRIBED') canal.current = c })
    return () => { supabase.removeChannel(c); canal.current = null }
  }, [empresa?.id])

  async function abrir() {
    setEstado('abrindo')
    try {
      if (serialSuportado()) {
        try {
          await liberarCatraca()
        } catch {
          await fecharPorta()
          await liberarCatraca()
        }
      } else {
        if (!canal.current) throw new Error('Abra a tela "Porta" no computador da catraca.')
        await canal.current.send({
          type: 'broadcast', event: 'liberar', payload: { nome: 'Liberação manual' },
        })
      }
      const { data: user } = await supabase.auth.getUser()
      supabase.from('academia_liberacoes').insert({
        empresa_id: empresa.id, motivo: 'Botão da recepção', criado_por: user?.user?.id ?? null,
      }).then(() => {})
      setEstado('ok')
      setTimeout(() => setEstado(''), 2500)
    } catch (e) {
      setEstado(e.message || 'Não consegui abrir.')
      setTimeout(() => setEstado(''), 6000)
    }
  }

  const texto = estado === 'abrindo' ? 'Abrindo...' : estado === 'ok' ? 'Aberta ✓' : '🔓 Abrir catraca'
  const classe = estado === 'ok' ? ' ok' : estado && estado !== 'abrindo' ? ' erro' : ''

  return (
    <div className="ac-abrir-caixa">
      <button type="button" className={`ac-abrir${classe}`} onClick={abrir} disabled={estado === 'abrindo'}>
        {texto}
      </button>
      {estado && estado !== 'abrindo' && estado !== 'ok' && <span className="ac-abrir-erro">{estado}</span>}
    </div>
  )
}
