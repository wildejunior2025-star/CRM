import { useEffect, useRef } from 'react'
import './AvisoPix.css'

// O aviso de "caiu o PIX" da mesa (mig 0193).
//
// Nasceu como uma folha grande no meio da tela, com o fundo escurecido. Fazia
// sentido quando era só o dono olhando — mas essa tela é o SALÃO: fica aberta
// no balcão o dia inteiro e várias pessoas mexem nela ao mesmo tempo. Um PIX da
// mesa 4 parava o garçom que estava lançando item na mesa 9, e ele tinha que
// fechar o aviso de um pagamento que não era da conta dele.
//
// Agora é uma tarja no ALTO da tela: pequena, sem escurecer nada, sem bloquear
// clique, e sai sozinha depois de alguns segundos. A notícia continua chegando
// — ela só parou de atropelar quem está trabalhando.
//
// Três acabamentos, porque as três notícias são diferentes:
//   'pago'    → caiu tudo, a mesa fechou. Verde.
//   'parcial' → caiu uma parte da conta rachada. Verde, mas falta gente.
//   'alerta'  → dinheiro caiu numa mesa já fechada. Âmbar, e NÃO sai sozinho:
//               esse pede alguém olhando, então espera ser lido.
const SEGUNDOS_NA_TELA = 9

export default function AvisoPix({ tipo = 'pago', valor, titulo, texto, onFechar }) {
  const botaoRef = useRef(null)
  const someSozinho = tipo !== 'alerta'

  // Escape fecha. O foco NÃO vai mais pro botão de propósito: roubar o foco de
  // quem está digitando o pedido é exatamente o atropelo que este aviso deixou
  // de fazer.
  useEffect(() => {
    function onKey(e) { if (e.key === 'Escape') onFechar() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onFechar])

  useEffect(() => {
    if (!someSozinho) return
    const t = setTimeout(onFechar, SEGUNDOS_NA_TELA * 1000)
    return () => clearTimeout(t)
  }, [someSozinho, onFechar])

  const fmt = (v) => `R$ ${Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`

  return (
    <div className="avpix-fundo">
      <div className={`avpix avpix--${tipo}`} role="status" aria-live="polite">
        <div className="avpix-selo" aria-hidden="true">{tipo === 'alerta' ? '!' : '✓'}</div>

        <div className="avpix-corpo">
          <div className="avpix-linha1">
            <h2 className="avpix-titulo">
              {titulo ?? (tipo === 'alerta' ? 'PIX em mesa já fechada' : 'PIX recebido')}
            </h2>
            {valor != null && <span className="avpix-valor">{fmt(valor)}</span>}
          </div>
          {texto && <p className="avpix-texto">{texto}</p>}
        </div>

        <button ref={botaoRef} type="button" className="avpix-botao"
          onClick={onFechar} aria-label="Fechar aviso">
          ×
        </button>

        {someSozinho && (
          <span className="avpix-tempo" aria-hidden="true"
            style={{ animationDuration: `${SEGUNDOS_NA_TELA}s` }} />
        )}
      </div>
    </div>
  )
}
