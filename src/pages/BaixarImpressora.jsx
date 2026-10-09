import { useEffect } from 'react'

// Endereço curto pra baixar o app Impressora FWC no PC do cliente (digitar o link
// comprido do storage no teclado de outra pessoa é um sofrimento).
// O ?v= só existe pro navegador não reaproveitar um .exe antigo do cache.
const EXE = 'https://ycytrsqdvrviihkqfvno.supabase.co/storage/v1/object/public/downloads/ImpressoraFWC.exe'

export default function BaixarImpressora() {
  useEffect(() => {
    window.location.replace(EXE + '?v=' + Date.now())
  }, [])
  return (
    <div style={{ padding: 24, fontFamily: 'sans-serif', textAlign: 'center' }}>
      <h2>Baixando o app Impressora FWC...</h2>
      <p>Quando terminar, abra o arquivo <b>ImpressoraFWC.exe</b>.</p>
      <p><a href={EXE}>Se não começar sozinho, toque aqui.</a></p>
    </div>
  )
}
