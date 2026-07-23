// Configuração das páginas "Ver por dentro" (fwcinter.com/ver/:sistema).
//
// Cada item do menu vira um botão na página. Clicar abre o vídeo cadastrado
// naquela `chave` (tabela videos_tutorial, gerenciado no Super Admin → Vídeos).
// Item sem vídeo mostra "vídeo em breve" — dá pra publicar aos poucos.
//
// O menu do GESTOR espelha a lateral real do sistema (src/components/Layout.jsx).
// Mexeu na lateral? Reflita aqui pra demonstração ficar fiel.

export const SISTEMAS = {
  gestor: {
    titulo: 'Gestor de Pedidos',
    emoji: '🖥️',
    subtitulo: 'O sistema que roda a distribuidora. Clique em qualquer item do menu para ver como funciona.',
    menu: [
      { group: 'Operações' },
      { chave: 'gestor-dashboard', label: 'Dashboard' },
      {
        chave: 'gestor-vendas', label: 'Vendas', children: [
          { chave: 'gestor-vendas-fisica', label: 'Vendas física' },
          { chave: 'gestor-vendas-delivery', label: 'Vendas delivery' },
          { chave: 'gestor-entregadores', label: 'Entregadores' },
        ],
      },
      { chave: 'gestor-clientes', label: 'Clientes' },
      { chave: 'gestor-funcionarios', label: 'Funcionários' },
      {
        chave: 'gestor-presencial', label: 'Serviço Presencial', children: [
          { chave: 'gestor-salao', label: 'Salão' },
          { chave: 'gestor-caixa', label: 'Caixa' },
          { chave: 'gestor-cozinha', label: 'Cozinha (KDS)' },
          { chave: 'gestor-reservas', label: 'Reservas e fila' },
          { chave: 'gestor-presencial-historico', label: 'Histórico' },
          { chave: 'gestor-mesas', label: 'Mesas' },
        ],
      },
      {
        chave: 'gestor-catalogo', label: 'Catálogo', children: [
          { chave: 'gestor-produtos', label: 'Produtos' },
          { chave: 'gestor-complementos', label: 'Complementos' },
          { chave: 'gestor-ficha-tecnica', label: 'Ficha Técnica' },
          { chave: 'gestor-estoque', label: 'Estoque' },
        ],
      },
      { group: 'Delivery' },
      {
        chave: 'gestor-minha-loja', label: 'Minha Loja', children: [
          { chave: 'gestor-raio', label: 'Raio de Entrega' },
          { chave: 'gestor-horarios', label: 'Horários' },
          { chave: 'gestor-pagamento', label: 'Pagamento' },
          { chave: 'gestor-integracoes', label: 'Integrações' },
          { chave: 'gestor-fiscal', label: 'Nota Fiscal' },
          { chave: 'gestor-conta', label: 'Conta' },
        ],
      },
      { group: 'Automação' },
      {
        chave: 'gestor-whatsapp', label: 'WhatsApp', children: [
          { chave: 'gestor-whatsapp-config', label: 'Conexão / Config' },
          { chave: 'gestor-whatsapp-conversas', label: 'Conversas do bot' },
          { chave: 'gestor-whatsapp-creditos', label: 'Créditos Bot' },
          { chave: 'gestor-bot-teste', label: 'Teste Bot' },
        ],
      },
      { group: 'Financeiro' },
      { chave: 'gestor-financeiro', label: 'Financeiro' },
      { chave: 'gestor-relatorios', label: 'Relatórios' },
    ],
  },
}

// Qual card da landing abre qual página. (chave do data-video → id do sistema)
export const CARD_PARA_SISTEMA = {
  'gestor-pedidos': 'gestor',
}

// Lista chata (chave + rótulo "Gestor · X") p/ o Super Admin de vídeos.
export function itensParaCatalogo() {
  const out = []
  for (const sis of Object.values(SISTEMAS)) {
    const nome = sis.titulo
    for (const it of sis.menu) {
      if (it.group || !it.chave) continue
      out.push({ chave: it.chave, label: `${nome} · ${it.label}` })
      for (const c of (it.children || [])) {
        out.push({ chave: c.chave, label: `${nome} · ${it.label} · ${c.label}` })
      }
    }
  }
  return out
}
