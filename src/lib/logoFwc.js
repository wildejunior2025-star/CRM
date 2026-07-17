import logoRoxo from '../assets/logo-fwc-icone.png'
import logoBranco from '../assets/logo-fwc-icone-branco.png'

// O portal (portal.fwcinter.com) usa a logo BRANCA (invertida).
// Todos os outros domínios (gestor, admin, app, fwcinter.com...) usam a ROXA.
export const isPortalDomain =
  typeof window !== 'undefined' && window.location.hostname === 'portal.fwcinter.com'

export const logoFwcIcone = isPortalDomain ? logoBranco : logoRoxo
