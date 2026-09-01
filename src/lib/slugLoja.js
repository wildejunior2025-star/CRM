// O "apelido" da loja no link público: lojaonline.fwcinter.com/{slug}.
//
// Regras: só minúsculas, números e hífen. Sem acento (o cliente digita errado
// e o WhatsApp quebra o link), sem espaço, sem hífen dobrado nem nas pontas.

export function gerarSlug(texto) {
  return String(texto ?? '')
    .normalize('NFD').replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
}

// Diz o que está errado no que o dono digitou — ou null se está bom.
export function erroDoSlug(slug) {
  if (!slug) return 'Escreva o final do link.'
  if (slug.length < 3) return 'Muito curto: use pelo menos 3 letras.'
  if (slug.length > 60) return 'Muito longo: no máximo 60 letras.'
  if (!/^[a-z0-9-]+$/.test(slug)) return 'Só letras minúsculas, números e hífen (sem acento e sem espaço).'
  if (/^-|-$/.test(slug)) return 'Não pode começar nem terminar com hífen.'
  // Rotas do próprio site: uma loja chamada "login" sequestraria a tela de login.
  const reservados = new Set(['login', 'entrar', 'cadastro', 'portal', 'painel', 'admin',
    'super-admin', 'assets', 'lojas', 'app', 'api', 'gestor', 'mesa', 'pedido'])
  if (reservados.has(slug)) return 'Esse nome é reservado pelo sistema. Escolha outro.'
  return null
}
