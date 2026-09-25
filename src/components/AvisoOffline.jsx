import { useEffect, useState } from 'react'

// FAIXA DE "SEM INTERNET".
//
// Quando a net cai, o sistema só reclama na hora em que a pessoa clica em
// alguma coisa — e o recado vem como erro, que assusta. Esta faixa avisa ANTES:
// enquanto o aparelho estiver sem rede, ela fica à vista dizendo que o problema
// é ali, não no sistema. Sai sozinha quando a internet volta.
//
// `navigator.onLine` é o que o navegador sabe da placa de rede: ele acerta o
// caso comum (Wi-Fi caiu, cabo solto) e não acerta o "conectado mas sem
// internet". Por isso a faixa é um aviso, e não uma trava: a loja continua
// clicando no que quiser.
export default function AvisoOffline() {
  const [offline, setOffline] = useState(() =>
    typeof navigator !== 'undefined' && navigator.onLine === false)

  useEffect(() => {
    const caiu = () => setOffline(true)
    const voltou = () => setOffline(false)
    window.addEventListener('offline', caiu)
    window.addEventListener('online', voltou)
    return () => {
      window.removeEventListener('offline', caiu)
      window.removeEventListener('online', voltou)
    }
  }, [])

  if (!offline) return null
  return (
    <div role="status" style={{
      position: 'fixed', left: 0, right: 0, top: 0, zIndex: 99998,
      padding: '9px 14px', textAlign: 'center',
      background: '#b91c1c', color: '#fff',
      font: '700 13px/1.35 system-ui, -apple-system, sans-serif',
      boxShadow: '0 2px 12px rgba(0,0,0,.35)',
    }}>
      📶 Sem internet neste aparelho — o que você fizer agora pode não salvar.
      <span style={{ fontWeight: 500, opacity: .9 }}> Confira o Wi-Fi ou o cabo; o aviso some sozinho quando voltar.</span>
    </div>
  )
}
