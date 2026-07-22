// Funcionalidades do CRM que o Super Admin liga/desliga por loja.
//
// TRÊS ESTADOS, gravados em empresas.modulos (jsonb):
//
//   true (ou ausente) → LIBERADO. A loja vê no menu e usa normalmente.
//   'bloqueado'       → BLOQUEADO. Aparece no menu com 🔒; ao clicar, cai na
//                       tela de upgrade. Serve pra vender o plano de cima:
//                       quem não sabe que existe não compra.
//   false             → OCULTO. Some do menu e da URL. Pra loja que já sabe
//                       que existe e não quer — deixa a tela dela limpa.
//
// Loja antiga (modulos = {}) fica com tudo liberado: o padrão é permitir.
//
// A `key` é a mesma do menu (Layout.jsx) e do bloqueio de rota
// (ProtectedRoute.jsx), então tudo sai desta lista única.

export const MODULOS = [
  { key: 'vendas',       label: 'Vendas',             descricao: 'Registro de vendas / PDV' },
  { key: 'caixa',        label: 'Caixa',              descricao: 'Abertura e fechamento de caixa' },
  { key: 'clientes',     label: 'Clientes',           descricao: 'Cadastro de clientes' },
  { key: 'produtos',     label: 'Catálogo',           descricao: 'Produtos e categorias' },
  { key: 'estoque',      label: 'Estoque',            descricao: 'Controle de estoque' },
  { key: 'presencial',   label: 'Serviço Presencial', descricao: 'Mesas, Salão e Cozinha (KDS)' },
  { key: 'delivery',     label: 'Delivery',           descricao: 'Minha Loja, raio de entrega e pedidos delivery' },
  { key: 'whatsapp',     label: 'WhatsApp / Bot',     descricao: 'WhatsApp, créditos do bot e teste do bot' },
  { key: 'financeiro',   label: 'Financeiro',         descricao: 'Contas, despesas e fluxo de caixa' },
  { key: 'relatorios',   label: 'Relatórios',         descricao: 'Relatórios e curva ABC' },
  { key: 'funcionarios', label: 'Funcionários',       descricao: 'Gestão dos usuários da loja' },
]

export const BLOQUEADO = 'bloqueado'

// Texto do convite de upgrade por módulo. Fala do que a loja GANHA, não do
// que ela não pode — é o que faz o dono querer subir de plano.
export const UPGRADE_PITCH = {
  whatsapp: {
    titulo: 'Seu Vendedor 24h por IA está esperando',
    resumo: 'Atenda no WhatsApp automaticamente, tire pedido e responda dúvida — inclusive de madrugada, sem ninguém no celular.',
    itens: [
      'Responde e fecha pedido sozinho, 24 horas por dia',
      'Cliente não fica esperando — nem no domingo, nem de madrugada',
      'Você acompanha tudo e assume a conversa quando quiser',
    ],
  },
}
export const UPGRADE_PADRAO = {
  titulo: 'Disponível em um plano superior',
  resumo: 'Essa funcionalidade não está incluída no seu plano atual.',
  itens: [],
}

function estado(empresa, key) {
  if (!key) return true
  return empresa?.modulos?.[key]
}

// A loja PODE USAR o módulo? (menu clicável + acesso pela rota)
// Só libera quando não está oculto nem bloqueado.
export function moduloAtivo(empresa, key) {
  const v = estado(empresa, key)
  return v !== false && v !== BLOQUEADO
}

// O item APARECE no menu? Bloqueado aparece (com cadeado); oculto não.
export function moduloVisivel(empresa, key) {
  return estado(empresa, key) !== false
}

// Aparece, mas com cadeado e leva pra tela de upgrade.
export function moduloBloqueado(empresa, key) {
  return estado(empresa, key) === BLOQUEADO
}

export function pitchUpgrade(key) {
  return UPGRADE_PITCH[key] ?? UPGRADE_PADRAO
}

export function labelModulo(key) {
  return MODULOS.find(m => m.key === key)?.label ?? 'Essa funcionalidade'
}
