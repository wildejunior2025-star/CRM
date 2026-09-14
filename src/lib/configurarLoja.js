// Etapas do "Configurar Loja" (mig 0273) — o que uma loja nova precisa pra vender.
//
// Cada etapa se confere SOZINHA com os fatos que o onboarding_status() devolve.
// O que o banco não tem como saber (impressora mora no PC) vira "feito" na mão.
//
// OBRIGATÓRIA = sem ela a loja online não vende (horário, entrega, pagamento,
// cardápio). Fica vermelha enquanto falta e não tem "pular". OPCIONAL = a loja
// vende sem (WhatsApp, impressora, logo...): dá pra pular e voltar depois.
// Pulada não é feita: continua na lista, só deixa de ser a etapa da vez.

const temPixOnline = (formas) => Array.isArray(formas) && formas.includes('pix')

export const ETAPAS = [
  {
    id: 'horario',
    titulo: 'Horário de funcionamento',
    curto: 'Revisar horário',
    rota: '/loja-horarios',
    botao: 'Abrir Horários',
    // Loja nova nasce PAUSADA na mão (delivery_ativo false sem ser pelo
    // horário): mesmo com a grade certa o link fica "Fechado". Por isso a etapa
    // só fecha quando a abertura pelo horário está liberada.
    feita: s => s.horario && !s.pausada_manual,
    detalhe: s => (!s.horario ? 'Marque os dias e horários que abre'
      : s.pausada_manual ? 'Falta liberar a loja pra abrir no horário' : 'Abre e fecha sozinha no horário'),
    explica: [
      'A loja abre e fecha sozinha nesse horário. Fora dele o link mostra "Fechado" e ninguém pede sem ter quem atenda.',
      'Dá pra ter dois turnos no mesmo dia (almoço e noite) e marcar feriado.',
    ],
  },
  {
    id: 'entrega',
    titulo: 'Endereço e entrega',
    curto: 'Configurar entrega',
    rota: '/raio-entrega',
    botao: 'Abrir Raio de Entrega',
    feita: s => s.pino && s.aceita_delivery && (!s.aceita_entrega || s.tem_taxa),
    detalhe: s => {
      const falta = []
      if (!s.pino) falta.push('marcar o ponto da loja no mapa')
      if (!s.aceita_delivery) falta.push('ligar o pedido online')
      if (s.aceita_delivery && s.aceita_entrega && !s.tem_taxa) falta.push('definir a taxa de entrega')
      return falta.length ? `Falta ${falta.join(', ')}` : (s.aceita_entrega ? 'Entrega com taxa definida' : 'Só retirada')
    },
    explica: [
      'Primeiro o ponto da loja no mapa: é dele que o sistema mede a distância até o cliente.',
      'Depois a taxa: por km (ex.: até 2 km R$ 5, até 4 km R$ 7) ou por bairro. E ligue "aceita pedido online". Sem isso o link da loja não abre.',
    ],
  },
  {
    id: 'pagamento',
    titulo: 'Formas de pagamento',
    curto: 'Revisar pagamento',
    rota: '/loja-pagamento',
    botao: 'Abrir Pagamento',
    feita: s => Array.isArray(s.formas_pagamento) && s.formas_pagamento.length > 0
      && (!temPixOnline(s.formas_pagamento) || s.mp_conectado),
    detalhe: s => {
      if (!Array.isArray(s.formas_pagamento) || !s.formas_pagamento.length) return 'Escolha como o cliente paga'
      if (temPixOnline(s.formas_pagamento) && !s.mp_conectado) return 'PIX online ligado sem Mercado Pago conectado'
      return s.mp_conectado ? 'Mercado Pago conectado' : 'Pagamento na entrega'
    },
    explica: [
      'Escolha o que aceita: dinheiro, cartão na maquininha, PIX na entrega.',
      'Pra PIX online, conecte o SEU Mercado Pago: o dinheiro cai na hora na sua conta, e o pedido só chega depois de pago. A FWC não segura nem repassa nada.',
    ],
  },
  {
    id: 'cardapio',
    titulo: 'Cardápio',
    curto: 'Configurar cardápio',
    rota: '/produtos',
    botao: 'Abrir Produtos',
    feita: s => Number(s.produtos_ativos) > 0,
    detalhe: s => (Number(s.produtos_ativos) > 0
      ? `${s.produtos_ativos} produto${s.produtos_ativos > 1 ? 's' : ''} ativo${s.produtos_ativos > 1 ? 's' : ''}, ${s.produtos_com_foto} com foto`
      : 'Cadastre seus produtos'),
    explica: [
      'Cadastre os produtos com foto, preço e categoria. Produto com foto vende bem mais.',
      'Já vende no iFood? Conectando o iFood em Integrações, o cardápio vem inteiro de lá, inclusive os itens pausados e os complementos.',
    ],
  },
  {
    id: 'empresa',
    titulo: 'Dados da empresa',
    curto: 'Confirmar CNPJ',
    inline: true,
    opcional: true,
    feita: s => !!s.cnpj && !!s.razao_social,
    detalhe: s => (s.razao_social ? s.razao_social : 'Confirme os dados que vieram do CNPJ'),
    explica: [
      'Puxo os dados do seu CNPJ direto da Receita Federal: razão social e endereço.',
      'Confere e corrige o que estiver velho. O endereço da Receita às vezes é o de quando a empresa abriu.',
    ],
  },
  {
    id: 'visual',
    titulo: 'Logo e capa',
    curto: 'Logo e capa',
    rota: '/minha-loja',
    botao: 'Abrir Minha Loja',
    opcional: true,
    feita: s => s.logo && s.capa,
    detalhe: s => (s.logo && s.capa ? 'Logo e capa enviadas'
      : s.logo ? 'Falta a foto de capa' : s.capa ? 'Falta a logo' : 'Envie a logo e a foto de capa'),
    explica: [
      'É a primeira coisa que o cliente vê quando abre o link da sua loja.',
      'Em Minha Loja você envia a logo (quadrada) e a capa (foto larga, de preferência do seu produto mais bonito).',
    ],
  },
  {
    id: 'whatsapp',
    titulo: 'WhatsApp e robô',
    curto: 'Conectar WhatsApp',
    rota: '/whatsapp',
    botao: 'Abrir WhatsApp',
    opcional: true,
    visivel: s => s.whatsapp_modulo !== false,
    feita: s => s.whatsapp_conectado,
    detalhe: s => (s.whatsapp_conectado
      ? (s.robo_ligado ? 'Conectado, robô ligado' : 'Conectado, robô desligado')
      : 'Conecte o número da loja'),
    explica: [
      'Conecte o WhatsApp da loja pra avisar o cliente de cada etapa do pedido.',
      'Se quiser, liga o robô: ele responde na hora, manda o link do cardápio e até anota o pedido. Dá pra pular e fazer depois.',
    ],
  },
  {
    id: 'impressora',
    titulo: 'Impressora',
    curto: 'Configurar impressora',
    rota: '/painel',
    botao: 'Abrir o gestor de pedidos',
    opcional: true,
    manual: true,
    feita: () => false,
    detalhe: () => 'Pedido saindo sozinho na impressora',
    explica: [
      'Com o app Impressora FWC no computador da loja, todo pedido sai sozinho na impressora térmica, mesmo com o gestor fechado.',
      'No gestor de pedidos, abra o menu Impressora, baixe o app e escolha a impressora. Não usa impressora? É só pular.',
    ],
  },
  {
    id: 'teste',
    titulo: 'Pedido teste e divulgar',
    curto: 'Fazer pedido teste',
    inline: true,
    opcional: true,
    feita: s => Number(s.pedidos) > 0,
    detalhe: s => (Number(s.pedidos) > 0 ? 'Primeiro pedido feito 🎉' : 'Faça um pedido pelo link da loja'),
    explica: [
      'Abra o link da sua loja no celular e faça um pedido de teste, do jeito que o cliente faria.',
      'Depois é só divulgar: bio do Instagram, status do WhatsApp e mensagem pros clientes.',
    ],
  },
]

/** Etapas visíveis pra essa loja, já com feita/pulada calculadas. */
export function etapasDaLoja(status) {
  if (!status) return []
  const ob = status.onboarding ?? {}
  const pulados = new Set(ob.pulados ?? [])
  const feitosManual = new Set(ob.feitos ?? [])
  return ETAPAS
    .filter(e => !e.visivel || e.visivel(status))
    .map(e => {
      const feita = !!(e.feita(status) || feitosManual.has(e.id))
      return { ...e, feita, pulada: !feita && !!e.opcional && pulados.has(e.id), texto: e.detalhe(status) }
    })
}

/** A etapa da vez: a primeira que nem está feita nem foi pulada. */
export function etapaAtual(etapas) {
  return etapas.find(e => !e.feita && !e.pulada) ?? null
}

/** Obrigatórias que ainda faltam — é o número vermelho do menu. */
export function obrigatoriasPendentes(etapas) {
  return etapas.filter(e => !e.opcional && !e.feita)
}

export const linkDaLoja = (status) => `https://lojaonline.fwcinter.com/${status?.slug ?? ''}`
