import { useEffect, useState } from 'react'
import { precisaPerguntar, registrarConsentimento } from '../lib/tracking'
import './AvisoCookies.css'

// Aviso de cookies da Loja Online (LGPD).
//
// Só aparece nas lojas que anunciam — quem não tem Google Ads nem Pixel
// configurado não carrega cookie de terceiro e não tem o que perguntar, então o
// cliente dessas lojas nunca vê essa barra.
//
// A resposta é por loja (cada loja é um anunciante diferente) e fica guardada no
// aparelho, então só pergunta uma vez.
export default function AvisoCookies({ loja }) {
  const [aberto, setAberto] = useState(false)
  const [detalhes, setDetalhes] = useState(false)

  useEffect(() => {
    setAberto(precisaPerguntar(loja))
  }, [loja])

  if (!aberto) return null

  function responder(aceito) {
    registrarConsentimento(loja, aceito)
    setAberto(false)
  }

  return (
    <div className="avc-wrap" role="dialog" aria-label="Aviso de cookies">
      <div className="avc-box">
        <p className="avc-texto">
          🍪 Usamos cookies pra entender como você usa a loja e melhorar nossos anúncios.
          {' '}
          <button type="button" className="avc-link" onClick={() => setDetalhes(d => !d)}>
            {detalhes ? 'Ver menos' : 'Saiba mais'}
          </button>
        </p>

        {detalhes && (
          <p className="avc-detalhe">
            Se você aceitar, {loja?.nome || 'a loja'} compartilha com o Google e a Meta
            (Facebook/Instagram) informações sobre o que você visita e compra aqui, pra medir os
            anúncios dela e mostrar ofertas mais parecidas com o que você procura. Recusando, a
            loja continua funcionando igual — você só não recebe anúncio personalizado. Dá pra
            mudar de ideia depois limpando os dados do site no seu navegador.
          </p>
        )}

        <div className="avc-botoes">
          <button type="button" className="avc-btn avc-btn-recusar" onClick={() => responder(false)}>
            Recusar
          </button>
          <button type="button" className="avc-btn avc-btn-aceitar" onClick={() => responder(true)}>
            Aceitar
          </button>
        </div>
      </div>
    </div>
  )
}
