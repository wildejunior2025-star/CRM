import { useEffect } from 'react'
import landingHtml from '../landing/landing.html?raw'

// Landing pública de marketing servida em fwcinter.com (raiz), quando o
// visitante não está logado. O HTML/CSS vem do site original (FWC geral/
// vendamais-site) importado como raw — todo o CSS é escopado em .fwc-landing
// pra não vazar pro resto do app.
export default function Landing() {
  useEffect(() => {
    const anterior = document.title
    document.title = 'FWC Inter — Sistema de Gestão para Distribuidoras'
    return () => { document.title = anterior }
  }, [])

  return <div dangerouslySetInnerHTML={{ __html: landingHtml }} />
}
