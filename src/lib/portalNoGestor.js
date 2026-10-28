// Portal dentro do gestor (27/10/2026).
// O gestor (gestor.fwcinter.com) e o Portal são o MESMO site: é o domínio que
// decide o que abre, e no gestor o dono e o vendedor são empurrados pro /painel
// (ver HostnameRedirect em App.jsx). O botão "Portal" da barra do gestor liga
// esta marca e aí o empurrão para — o Portal abre no mesmo domínio, com a mesma
// sessão (sem pedir login) e, no app FWC Gestor, sem precisar de versão nova na
// loja. Voltar pro /painel desliga a marca.
const CHAVE = 'fwc_portal_no_gestor'

export function portalNoGestor() {
  try { return sessionStorage.getItem(CHAVE) === '1' } catch { return false }
}

export function marcarPortalNoGestor(ligado) {
  try {
    if (ligado) sessionStorage.setItem(CHAVE, '1')
    else sessionStorage.removeItem(CHAVE)
  } catch { /* sem storage: o botão só não funciona, nada quebra */ }
}
