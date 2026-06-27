// Funcionalidades do CRM que o Super Admin pode ligar/desligar por loja.
//
// Semântica: um módulo está SEMPRE ATIVO por padrão. Ele só fica oculto quando
// gravado explicitamente como `false` em empresas.modulos. Assim lojas antigas
// (modulos = {}) continuam com tudo ligado, e basta o Super Admin desligar o que
// a loja não usa (ex: delivery, serviço de mesa, WhatsApp).
//
// A `key` é a mesma usada no menu (Layout.jsx) e no bloqueio de rotas (App.jsx),
// para tudo ficar em sincronia a partir desta lista única.

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

// Um módulo só fica oculto se estiver explicitamente como false.
// Sem `key` (itens fixos como o Dashboard) → sempre ativo.
export function moduloAtivo(empresa, key) {
  if (!key) return true
  return empresa?.modulos?.[key] !== false
}
