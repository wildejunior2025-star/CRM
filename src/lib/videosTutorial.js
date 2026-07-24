import { itensParaCatalogo } from './tourSistema'

// Catálogo das funcionalidades que podem ter vídeo tutorial.
//
// A `chave` é a MESMA do atributo data-video nos cards do landing.html.
// Mexeu aqui? Confira lá também, senão o vídeo não acha o card.

// Vídeo de apresentação — aparece em destaque no topo da seção de
// funcionalidades, antes dos cards. É onde você explica que cada card tem
// vídeo e que dá pra pedir ajuda à IA a qualquer momento.
export const APRESENTACAO = {
  chave: 'apresentacao',
  label: 'Vídeo de apresentação (topo da página)',
}

export const FUNCIONALIDADES = [
  { chave: 'ifood',                  label: 'Integração iFood' },
  { chave: 'loja-online',            label: 'Loja Online' },
  { chave: 'app-cliente',            label: 'App do Cliente' },
  { chave: 'gestor-pedidos',         label: 'Gestor' },
  { chave: 'entregador',             label: 'Painel do Entregador' },
  { chave: 'salao',                  label: 'Atendimento no Salão' },
  { chave: 'crm-clientes',           label: 'CRM de Clientes' },
  { chave: 'delivery',               label: 'Delivery Integrado' },
  { chave: 'estoque',                label: 'Controle de Estoque' },
  { chave: 'pix',                    label: 'Pagamento PIX' },
  { chave: 'financeiro',             label: 'Financeiro Completo' },
  { chave: 'portal-cliente',         label: 'Portal do Cliente' },
  { chave: 'whatsapp-ia',            label: 'WhatsApp com IA' },
  { chave: 'relatorios',             label: 'Relatórios e Comissões' },
  { chave: 'multi-empresa',          label: 'Multi-empresa' },
  { chave: 'rota-automatica',        label: 'Rota Automática' },
  { chave: 'leitor-print',           label: 'Leitor de Print com IA' },
  { chave: 'cozinha',                label: 'Tela da Cozinha' },
  { chave: 'complementos',           label: 'Complementos e Adicionais' },
  { chave: 'marketplace-pagamentos', label: 'Marketplace de Pagamentos' },
  { chave: 'baixa-ifood',            label: 'Baixa do iFood em 1 Clique' },
  { chave: 'reservas',               label: 'Reservas com Prioridade' },
  { chave: 'horarios',               label: 'Horários Inteligentes' },
  { chave: 'metas',                  label: 'Metas e Resumo Diário' },
  // Itens das páginas "Ver por dentro" (fwcinter.com/ver/:sistema): um vídeo por
  // botão do menu do sistema. Definidos em src/lib/tourSistema.js.
  ...itensParaCatalogo(),
]

// Aceita o que o YouTube der: link normal, encurtado, /embed, /shorts ou o ID
// puro. Guardamos só o ID — assim o player não depende do formato do link.
export function extrairYoutubeId(entrada) {
  const s = String(entrada || '').trim()
  if (!s) return ''
  if (/^[\w-]{11}$/.test(s)) return s                       // já é o ID
  const padroes = [
    /[?&]v=([\w-]{11})/,                                     // watch?v=ID
    /youtu\.be\/([\w-]{11})/,                                // youtu.be/ID
    /\/embed\/([\w-]{11})/,                                  // /embed/ID
    /\/shorts\/([\w-]{11})/,                                 // /shorts/ID
    /\/live\/([\w-]{11})/,                                   // /live/ID
  ]
  for (const p of padroes) {
    const m = s.match(p)
    if (m) return m[1]
  }
  return ''
}
