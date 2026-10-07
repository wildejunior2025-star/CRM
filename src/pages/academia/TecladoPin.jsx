import { useEffect, useState } from 'react'
// O estilo vem junto: o teclado aparece no login, antes de a área do aluno
// (que é quem carregava este css) existir na tela.
import './aluno.css'

// Teclado de 4 números, do jeito que a pessoa já conhece do celular.
//
// As 4 bolinhas são o recado: a senha dela tem 4 dígitos. Só por existirem,
// ninguém mais fica tentando lembrar "era uma palavra ou um número?".

export default function TecladoPin({ titulo, subtitulo, erro, carregando, onCompleto, onVoltar, rodape }) {
  const [pin, setPin] = useState('')

  // Limpa as bolinhas quando o erro aparece E quando a pergunta muda (de
  // "nova senha" pra "repita a senha"): elas ficavam cheias da etapa anterior
  // e o teclado parava de responder.
  useEffect(() => { setPin('') }, [titulo, erro])

  function digitar(n) {
    if (carregando || pin.length >= 4) return
    const novo = pin + n
    setPin(novo)
    if (novo.length === 4) onCompleto(novo)
  }

  return (
    <div className="pin-tela">
      <div className="pin-topo">
        <h1>{titulo}</h1>
        {subtitulo && <p>{subtitulo}</p>}
      </div>

      <div className="pin-bolinhas" aria-label={`${pin.length} de 4 números`}>
        {[0, 1, 2, 3].map(i => <span key={i} className={i < pin.length ? 'cheia' : ''} />)}
      </div>

      {erro && <div className="pin-erro">{erro}</div>}
      {carregando && <div className="pin-aviso">Entrando...</div>}

      <div className="pin-teclado">
        {[1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => (
          <button key={n} type="button" onClick={() => digitar(String(n))} disabled={carregando}>{n}</button>
        ))}
        <button type="button" className="pin-vazio" tabIndex={-1} aria-hidden="true" />
        <button type="button" onClick={() => digitar('0')} disabled={carregando}>0</button>
        <button type="button" className="pin-apagar" onClick={() => setPin(pin.slice(0, -1))} disabled={carregando || !pin}>
          ⌫
        </button>
      </div>

      {rodape}
      {onVoltar && <button type="button" className="al-botao texto" onClick={onVoltar}>Voltar</button>}
    </div>
  )
}
