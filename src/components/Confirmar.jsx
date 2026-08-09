import { useEffect, useRef } from 'react'
import './Confirmar.css'

// Aviso de confirmação no visual do sistema, no lugar do confirm() do navegador.
//
// O confirm() nativo é feio, cola no topo da tela (no celular fica pior ainda),
// não tem cor de perigo e não deixa destacar o que vai ser apagado. Aqui a loja
// vê o título, a lista do que some e dois botões do tamanho do dedo.
//
// Na prática você não monta esta tela na mão: usa o hook useConfirmar()
// (src/hooks/useConfirmar.jsx), que devolve uma Promise<boolean> igual ao
// confirm() — a troca no código fica direta.

export default function Confirmar({ pedido, onResposta }) {
  const okRef = useRef(null)
  const cancelarRef = useRef(null)
  const {
    titulo,
    texto,
    itens,          // lista do que vai ser apagado (opcional)
    aviso,          // observação que acalma ("o cardápio não é apagado") (opcional)
    textoOk = 'Excluir',
    textoCancelar = 'Cancelar',
    perigo = true,
    icone,
  } = pedido

  // Foco começa no Cancelar: se a loja apertar Enter sem ler, não apaga nada.
  useEffect(() => { cancelarRef.current?.focus() }, [])

  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape') onResposta(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onResposta])

  return (
    <div className="confirmar-fundo" onMouseDown={e => { if (e.target === e.currentTarget) onResposta(false) }}>
      <div className={`confirmar${perigo ? ' perigo' : ''}`} role="alertdialog" aria-modal="true">
        <div className="confirmar-topo">
          <span className="confirmar-icone">{icone ?? (perigo ? '🗑' : '❓')}</span>
          <h2>{titulo}</h2>
        </div>

        {texto && <p className="confirmar-texto">{texto}</p>}

        {itens?.length > 0 && (
          <div className="confirmar-itens">
            {itens.map((it, i) => <span key={i}>{it}</span>)}
          </div>
        )}

        {aviso && <p className="confirmar-aviso">{aviso}</p>}

        <div className="confirmar-botoes">
          <button ref={cancelarRef} type="button" className="btn btn-secondary" onClick={() => onResposta(false)}>
            {textoCancelar}
          </button>
          <button ref={okRef} type="button" className={`btn ${perigo ? 'btn-danger' : 'btn-primary'}`} onClick={() => onResposta(true)}>
            {textoOk}
          </button>
        </div>
      </div>
    </div>
  )
}

