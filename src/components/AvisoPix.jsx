import { useEffect, useRef } from 'react'
import './AvisoPix.css'

// O aviso de "caiu o PIX" da mesa (mig 0193).
//
// Era um alert() do navegador: cola no topo, letra miúda, o valor perdido no
// meio da frase — e quem lê isso está de pé, no meio do movimento, segurando o
// celular numa mão só. Aqui o valor é a maior coisa da tela, o botão tem tamanho
// de dedo e, no celular, a folha sobe de baixo (onde o polegar alcança).
//
// Três acabamentos, porque as três notícias são diferentes:
//   'pago'    → caiu tudo, a mesa fechou. Verde, é festa.
//   'parcial' → caiu uma parte da conta rachada. Verde também, mas falta gente.
//   'alerta'  → dinheiro caiu numa mesa já fechada. Âmbar: alguém tem que olhar.
export default function AvisoPix({ tipo = 'pago', valor, titulo, texto, onFechar }) {
  const botaoRef = useRef(null)

  // O foco vai pro botão: no PC fecha no Enter/Espaço sem procurar o mouse.
  useEffect(() => { botaoRef.current?.focus() }, [])

  useEffect(() => {
    function onKey(e) { if (e.key === 'Escape' || e.key === 'Enter') onFechar() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onFechar])

  const fmt = (v) => `R$ ${Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`

  return (
    <div className="avpix-fundo" onMouseDown={e => { if (e.target === e.currentTarget) onFechar() }}>
      <div className={`avpix avpix--${tipo}`} role="alertdialog" aria-modal="true">
        <div className="avpix-selo" aria-hidden="true">{tipo === 'alerta' ? '!' : '✓'}</div>

        <h2 className="avpix-titulo">
          {titulo ?? (tipo === 'alerta' ? 'PIX em mesa já fechada' : 'PIX recebido')}
        </h2>

        {valor != null && <div className="avpix-valor">{fmt(valor)}</div>}

        {texto && <p className="avpix-texto">{texto}</p>}

        <button ref={botaoRef} type="button" className="avpix-botao" onClick={onFechar}>
          {tipo === 'alerta' ? 'Entendi' : 'Beleza'}
        </button>
      </div>
    </div>
  )
}
