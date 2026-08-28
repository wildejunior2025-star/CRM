import { useEffect, useState } from 'react'
import { diagnosticar, servidorVoltou } from '../lib/diagnosticoConexao'
import './CarregandoOuFalha.css'

// Espera antes de desconfiar. 20s é folgado de propósito: internet de loja é
// ruim e uma tela que grita "fora do ar" no primeiro tropeço vira mentirosa —
// e mensagem que mente todo dia ninguém lê mais no dia que importa.
const ESPERA_S = 20
// Depois de diagnosticado, checa sozinho de tempos em tempos.
const RECHECAR_MS = 15_000

/**
 * Fica em "Carregando..." e, se passar do prazo, DESCOBRE o motivo e conta.
 * Quando o servidor volta, recarrega sozinho — ninguém precisa ficar
 * apertando botão.
 */
export default function CarregandoOuFalha({ espera = ESPERA_S }) {
  // carregando → checando → sem-internet | fora-do-ar
  const [estado, setEstado] = useState('carregando')

  useEffect(() => {
    let vivo = true
    const prazo = setTimeout(async () => {
      if (!vivo) return
      setEstado('checando')
      const motivo = await diagnosticar()
      if (vivo) setEstado(motivo)
    }, espera * 1000)
    return () => { vivo = false; clearTimeout(prazo) }
  }, [espera])

  useEffect(() => {
    if (estado !== 'sem-internet' && estado !== 'fora-do-ar') return
    let vivo = true
    const id = setInterval(async () => {
      if (!vivo) return
      // Voltou o banco = voltou tudo (pra alcançar o banco a internet tem que
      // estar de pé). Recarrega e a pessoa continua o que estava fazendo.
      if (await servidorVoltou()) { window.location.reload(); return }
      const motivo = await diagnosticar()
      if (vivo) setEstado(motivo)
    }, RECHECAR_MS)
    return () => { vivo = false; clearInterval(id) }
  }, [estado])

  if (estado === 'carregando' || estado === 'checando') {
    return (
      <div className="auth-loading">
        <span className="auth-loading-spinner" aria-hidden="true" />
        <span>{estado === 'checando' ? 'Demorando... vendo o que houve' : 'Carregando...'}</span>
      </div>
    )
  }

  const semInternet = estado === 'sem-internet'

  return (
    <div className="conexao-falha" role="alert">
      <div className="conexao-falha-card">
        <div className="conexao-falha-icone" aria-hidden="true">{semInternet ? '📶' : '🔧'}</div>

        <h1 className="conexao-falha-titulo">
          {semInternet ? 'Você está sem internet' : 'O servidor está fora do ar'}
        </h1>

        <p className="conexao-falha-texto">
          {semInternet ? (
            <>
              O sistema não conseguiu se conectar, e o problema está <strong>na conexão daqui</strong> —
              não é o sistema nem o servidor.
              <br />
              Confere o wi-fi ou os dados do celular.
            </>
          ) : (
            <>
              Não é o seu computador nem a sua internet: o sistema está no ar, mas o
              <strong> servidor não está respondendo</strong>. Não tem o que fazer daqui.
              <br />
              <strong>Anote os pedidos no papel</strong> enquanto isso.
            </>
          )}
        </p>

        <p className="conexao-falha-rodape">
          Estou verificando a cada 15 segundos — quando voltar, a tela abre sozinha.
        </p>

        <button type="button" className="conexao-falha-botao" onClick={() => window.location.reload()}>
          Tentar de novo agora
        </button>
      </div>
    </div>
  )
}
