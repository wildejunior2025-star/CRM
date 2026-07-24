// Configuração das páginas "Ver por dentro" (fwcinter.com/ver/:sistema).
//
// Cada item vira um botão na página. Clicar abre o vídeo cadastrado naquela
// `chave` (tabela videos_tutorial, gerenciado no Super Admin → Vídeos). Item
// sem vídeo mostra "vídeo em breve" — dá pra publicar aos poucos.
//
// São 2 sistemas com página:
//  • PORTAL  (FWC Portal, abre em /) — o admin completo. O menu espelha a
//    lateral real (src/components/Layout.jsx). Mexeu na lateral? Reflita aqui.
//  • GESTOR  (FWC Gestor, abre em /painel) — a TELA DE PEDIDOS (fila/kanban).
//    Não tem lateral: os "itens" são as ações da tela.

export const SISTEMAS = {
  gestor: {
    titulo: 'Gestor',
    emoji: '📋',
    subtitulo: 'A tela onde os pedidos caem e andam — do iFood, WhatsApp, balcão e cardápio numa fila só. Clique em cada ação para ver como funciona.',
    // Todos os botões da tela (a pedido do Wilde). Depois a gente tira o que não
    // precisar. Espelha PainelPedidos.jsx: topo, colunas, origens, ações do card
    // e a barra lateral direita.
    menu: [
      { group: 'Barra de topo' },
      { chave: 'gestor-vender', label: 'Vender (balcão)' },
      { chave: 'gestor-buscar', label: 'Buscar pedido' },
      { chave: 'gestor-auto-imprimir', label: 'Auto-imprimir (ligar/desligar)' },
      { chave: 'gestor-aceitar-auto', label: 'Aceitar automático' },
      { chave: 'gestor-loja-aberta', label: 'Loja aberta / fechada' },
      { chave: 'gestor-tema', label: 'Modo claro / escuro' },
      { chave: 'gestor-sair', label: 'Sair' },

      { group: 'Colunas (status)' },
      { chave: 'gestor-na-cozinha', label: 'Na cozinha' },
      { chave: 'gestor-em-rota', label: 'Em rota' },
      { chave: 'gestor-retirada-col', label: 'Retirada' },
      { chave: 'gestor-concluidos', label: 'Concluídos' },
      { chave: 'gestor-cancelados', label: 'Cancelados' },

      { group: 'Filtrar por origem' },
      { chave: 'gestor-origem-whatsapp', label: 'WhatsApp' },
      { chave: 'gestor-origem-ifood', label: 'iFood' },
      { chave: 'gestor-origem-balcao', label: 'Balcão' },
      { chave: 'gestor-origem-cardapio', label: 'Cardápio (loja online)' },
      { chave: 'gestor-origem-app', label: 'App' },

      { group: 'Ações do pedido' },
      { chave: 'gestor-aceitar', label: 'Aceitar pedido' },
      { chave: 'gestor-recusar', label: 'Recusar pedido' },
      { chave: 'gestor-pronto', label: 'Marcar pronto p/ entrega' },
      { chave: 'gestor-pronto-retirada', label: 'Pronto para retirada' },
      { chave: 'gestor-despachar', label: 'Chamar / despachar entregador' },
      { chave: 'gestor-confirmar-entrega', label: 'Confirmar entrega (código)' },
      { chave: 'gestor-confirmar-retirada', label: 'Confirmar retirada (código)' },
      { chave: 'gestor-cancelar', label: 'Cancelar pedido' },
      { chave: 'gestor-editar', label: 'Editar pedido / itens' },
      { chave: 'gestor-complementos', label: 'Ver e pausar complementos' },
      { chave: 'gestor-whatsapp-cliente', label: 'Enviar WhatsApp ao cliente' },

      { group: 'Impressão' },
      { chave: 'gestor-imprimir-cupom', label: 'Imprimir cupom' },
      { chave: 'gestor-reimprimir', label: 'Reimprimir cupom' },
      { chave: 'gestor-imprimir-bluetooth', label: 'Impressora do celular (Bluetooth)' },
      { chave: 'gestor-comanda-cozinha', label: 'Comanda na cozinha' },
      { chave: 'gestor-nfce', label: 'Emitir NFC-e (nota fiscal)' },

      { group: 'Barra lateral' },
      { chave: 'gestor-impressora', label: 'Impressora (configuração)' },
      { chave: 'gestor-pedidos-lista', label: 'Pedidos' },
      { chave: 'gestor-mesas', label: 'Mesas / Salão' },
      { chave: 'gestor-mensagens', label: 'Mensagens' },
      { chave: 'gestor-catalogo-atalho', label: 'Catálogo' },
      { chave: 'gestor-hoje', label: 'Resumo de hoje' },
      { chave: 'gestor-entregadores', label: 'Entregadores' },
    ],
  },

  portal: {
    titulo: 'Portal',
    emoji: '🖥️',
    subtitulo: 'O sistema completo de gestão da distribuidora. Clique em qualquer item do menu para ver como funciona.',
    menu: [
      { group: 'Operações' },
      { chave: 'portal-dashboard', label: 'Dashboard' },
      {
        chave: 'portal-vendas', label: 'Vendas', children: [
          { chave: 'portal-vendas-fisica', label: 'Vendas física' },
          { chave: 'portal-vendas-delivery', label: 'Vendas delivery' },
          { chave: 'portal-entregadores', label: 'Entregadores' },
        ],
      },
      { chave: 'portal-clientes', label: 'Clientes' },
      { chave: 'portal-funcionarios', label: 'Funcionários' },
      {
        chave: 'portal-presencial', label: 'Serviço Presencial', children: [
          { chave: 'portal-salao', label: 'Salão' },
          { chave: 'portal-caixa', label: 'Caixa' },
          { chave: 'portal-cozinha', label: 'Cozinha (KDS)' },
          { chave: 'portal-reservas', label: 'Reservas e fila' },
          { chave: 'portal-presencial-historico', label: 'Histórico' },
          { chave: 'portal-mesas', label: 'Mesas' },
        ],
      },
      {
        chave: 'portal-catalogo', label: 'Catálogo', children: [
          { chave: 'portal-produtos', label: 'Produtos' },
          { chave: 'portal-complementos', label: 'Complementos' },
          { chave: 'portal-ficha-tecnica', label: 'Ficha Técnica' },
          { chave: 'portal-estoque', label: 'Estoque' },
        ],
      },
      { group: 'Delivery' },
      {
        chave: 'portal-minha-loja', label: 'Minha Loja', children: [
          { chave: 'portal-raio', label: 'Raio de Entrega' },
          { chave: 'portal-horarios', label: 'Horários' },
          { chave: 'portal-pagamento', label: 'Pagamento' },
          { chave: 'portal-integracoes', label: 'Integrações' },
          { chave: 'portal-fiscal', label: 'Nota Fiscal' },
          { chave: 'portal-conta', label: 'Conta' },
        ],
      },
      { group: 'Automação' },
      {
        chave: 'portal-whatsapp', label: 'WhatsApp', children: [
          { chave: 'portal-whatsapp-config', label: 'Conexão / Config' },
          { chave: 'portal-whatsapp-conversas', label: 'Conversas do bot' },
          { chave: 'portal-whatsapp-creditos', label: 'Créditos Bot' },
          { chave: 'portal-bot-teste', label: 'Teste Bot' },
        ],
      },
      { group: 'Financeiro' },
      { chave: 'portal-financeiro', label: 'Financeiro' },
      { chave: 'portal-relatorios', label: 'Relatórios' },
    ],
  },

  entregas: {
    titulo: 'Aplicativo de Entregas',
    emoji: '🛵',
    subtitulo: 'O app do entregador — aceitar a corrida, seguir a rota, falar com o cliente e dar baixa. Clique em cada ação para ver como funciona.',
    // Todos os botões do app (espelha PainelEntregador.jsx). Poda depois.
    menu: [
      { group: 'Abas' },
      { chave: 'entregas-disponiveis', label: 'Disponíveis' },
      { chave: 'entregas-aceitas', label: 'Aceitas' },
      { chave: 'entregas-historico', label: 'Histórico' },

      { group: 'Fila de chegada' },
      { chave: 'entregas-online', label: 'Ficar online (entrar na fila)' },
      { chave: 'entregas-pausar', label: 'Pausar / sair da fila' },

      { group: 'Aceitar e sair' },
      { chave: 'entregas-buscar', label: 'Buscar entrega' },
      { chave: 'entregas-atualizar', label: 'Atualizar' },
      { chave: 'entregas-aceitar', label: 'Aceitar entrega' },
      { chave: 'entregas-sair', label: 'Sair para entrega' },
      { chave: 'entregas-sair-todas', label: 'Sair com todas' },
      { chave: 'entregas-largar', label: 'Largar entrega' },

      { group: 'Rota' },
      { chave: 'entregas-rota', label: 'Rota (uma entrega)' },
      { chave: 'entregas-rota-todas', label: 'Rota de todas (várias paradas)' },
      { chave: 'entregas-tirar-rota', label: 'Tirar da rota / voltar pra rota' },
      { chave: 'entregas-posicao', label: 'Posição na rota (1ª parada, 2ª...)' },

      { group: 'Contato e baixa' },
      { chave: 'entregas-ligar', label: 'Ligar' },
      { chave: 'entregas-zap', label: 'Zap (WhatsApp)' },
      { chave: 'entregas-itens', label: 'Ver itens do pedido' },
      { chave: 'entregas-confirmar', label: 'Confirmar entrega (código)' },
      { chave: 'entregas-confirmar-ifood', label: 'Confirmar entrega iFood' },

      { group: 'Ganhos' },
      { chave: 'entregas-periodo', label: 'Período (Hoje / 7 / 30 / Tudo)' },
      { chave: 'entregas-ganhos', label: 'A receber e recebido' },
    ],
  },
}

// Qual card da landing abre qual página. (chave do data-video → id do sistema)
export const CARD_PARA_SISTEMA = {
  'gestor-pedidos': 'gestor',
  'portal': 'portal',
  'entregador': 'entregas',
}

// Lista chata (chave + rótulo "Sistema · X") p/ o Super Admin de vídeos.
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
