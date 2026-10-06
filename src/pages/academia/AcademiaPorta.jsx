import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../../lib/supabaseClient'
import { useAuth } from '../../hooks/useAuth'
import {
  serialSuportado, portaLembrada, escolherPorta, abrirPorta, fecharPorta,
  conectarCatraca, liberarCatraca, lerConfigCatraca,
} from '../../lib/catracaSerial'

// academia.fwcinter.com/porta — o PC vira só o "abridor de porta".
//
// Quem reconhece pode ser o CELULAR (câmera bem melhor que a webcam velha):
// a Recepção no celular reconhece o aluno e manda um aviso pelo servidor;
// esta tela, aberta no computador ligado na catraca, recebe e solta o sinal.
//
// O computador precisa ficar com esta aba aberta e com internet.

export default function AcademiaPorta() {
  const { empresa } = useAuth()
  const [porta, setPorta] = useState(null)
  const [estado, setEstado] = useState('ligando') // ligando | pronto | erro
  const [msg, setMsg] = useState('Preparando...')
  const [log, setLog] = useState([])
  const ocupado = useRef(false)

  const anotar = t => setLog(l => [{ t, hora: new Date() }, ...l].slice(0, 12))

  async function ligar() {
    try {
      setEstado('ligando')
      setMsg('Abrindo a porta da catraca...')
      await conectarCatraca()
      setPorta(true)
      setEstado('pronto')
      setMsg('')
    } catch (e) {
      setEstado('erro')
      setMsg(e.message)
    }
  }

  useEffect(() => {
    if (!serialSuportado()) {
      setEstado('erro')
      setMsg('Esta tela precisa ser aberta no Chrome do COMPUTADOR ligado na catraca.')
      return
    }
    portaLembrada().then(p => { if (p && lerConfigCatraca()) ligar() })
    return () => { fecharPorta() }
  }, [])

  // Fica ouvindo o aviso que a Recepção (celular ou tablet) manda.
  useEffect(() => {
    if (!empresa?.id) return
    const canal = supabase
      .channel(`catraca-${empresa.id}`)
      .on('broadcast', { event: 'liberar' }, async ({ payload }) => {
        const nome = payload?.nome || 'aluno'
        if (ocupado.current) return
        ocupado.current = true
        anotar(`Abrindo para ${nome}...`)
        try {
          await liberarCatraca()
          anotar(`${nome} — catraca aberta ✓`)
        } catch {
          try {
            await fecharPorta()
            await liberarCatraca()
            anotar(`${nome} — catraca aberta ✓`)
          } catch (e2) {
            anotar(`${nome} — FALHOU: ${e2.message}`)
            setEstado('erro')
            setMsg(e2.message)
          }
        }
        ocupado.current = false
      })
      .subscribe()
    return () => { supabase.removeChannel(canal) }
  }, [empresa?.id])

  async function escolher() {
    try {
      const p = await escolherPorta()
      await abrirPorta(p, lerConfigCatraca()?.baudRate || 9600)
      setPorta(true)
      setEstado('pronto')
      setMsg('')
    } catch (e) {
      setEstado('erro')
      setMsg(e.message || 'Nenhuma porta escolhida.')
    }
  }

  return (
    <div className="ac-card ac-form">
      <h2>Abridor da catraca</h2>
      <p className="ac-muted">
        Deixe esta aba <b>aberta neste computador</b>. Quem reconhece o aluno é a Recepção no celular;
        esta tela só recebe o aviso e abre a catraca. O <b>SCA precisa estar fechado</b>.
      </p>

      <div className={estado === 'pronto' ? 'ac-porta ok' : 'ac-porta erro'}>
        <strong>{estado === 'pronto' ? '● Pronto — esperando os alunos' : estado === 'ligando' ? '● Ligando...' : '● Parado'}</strong>
        {msg && <span>{msg}</span>}
      </div>

      {estado !== 'pronto' && serialSuportado() && (
        <div className="ac-form-botoes" style={{ justifyContent: 'flex-start' }}>
          <button className="btn btn-primary" onClick={porta ? ligar : escolher}>
            {porta ? 'Tentar de novo' : 'Escolher a porta da catraca'}
          </button>
        </div>
      )}

      {log.length > 0 && (
        <div className="ac-lista">
          {log.map((l, i) => (
            <div key={i} className="ac-aluno" style={{ padding: '8px 12px' }}>
              <span className="ac-muted" style={{ fontVariantNumeric: 'tabular-nums' }}>
                {l.hora.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
              </span>
              <span style={{ flex: 1 }}>{l.t}</span>
            </div>
          ))}
        </div>
      )}

      <Link to="/" className="ac-muted">← Alunos</Link>
    </div>
  )
}
