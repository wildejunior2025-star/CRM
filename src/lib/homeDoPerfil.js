// A tela inicial de cada perfil, num lugar só.
//
// Existiam DUAS listas: uma no ProtectedRoute (pra onde devolver quem entrou
// onde não devia) e outra espalhada no HostnameRedirect (pra onde empurrar quem
// chega no domínio do gestor). Elas discordavam sobre o garçom — o redirect
// mandava ele pro /painel, e o /painel devolvia ele pro salão. Os dois ficavam
// se empurrando pra sempre: a URL piscava entre /painel e /presencial/salao e a
// tela apagava (Wilde, 23/08/2026).
//
// Com uma fonte só, elas não têm como discordar de novo.
export function homeDoPerfil(perfil) {
  switch (perfil) {
    case 'super_admin': return '/super-admin'
    case 'admin':       return '/'
    case 'vendedor':    return '/painel'
    case 'garcom':      return '/presencial/salao'
    case 'cozinheiro':  return '/presencial/cozinha'
    case 'entregador':  return '/entregas'
    default:            return '/portal'
  }
}

// Quem usa o gestor de pedidos (/painel). Garçom e cozinheiro NÃO usam: cada um
// tem a tela dele. Precisa bater com os `roles` da rota /painel no App.jsx.
export function usaPainelDePedidos(perfil) {
  return perfil === 'admin' || perfil === 'super_admin' || perfil === 'vendedor'
}
