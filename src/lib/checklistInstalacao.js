// Checklist de instalação de uma loja nova (Super Admin → card da loja).
//
// A lista mora AQUI; no banco (empresa_checklist, mig 0456) só se grava o que já
// foi marcado, por `key`. Por isso:
//   - NUNCA troque a `key` de um item que já existe (a marca das lojas se perde);
//   - item novo é só acrescentar aqui — aparece desmarcado em todas as lojas;
//   - o texto pode mudar à vontade.
//
// Ordem de propósito: o ACESSO REMOTO vem primeiro. Era o que sempre ficava pra
// depois, e a loja com problema virava viagem até lá.
export const CHECKLIST_INSTALACAO = [
  {
    id: 'remoto',
    titulo: '1. Acesso remoto (faça primeiro)',
    aviso: 'Sem isso, todo problema da loja vira viagem até lá.',
    itens: [
      { key: 'remoto_conta', texto: 'Abrir o Chrome (perfil novo) no PC da loja e entrar na conta de suporte' },
      { key: 'remoto_host', texto: 'Instalar o Chrome Remote Desktop (remotedesktop.google.com/access)', dica: 'Se der "não foi possível iniciar o instalador", baixe o .msi direto em dl.google.com/edgedl/chrome-remote-desktop/chromeremotedesktophost.msi' },
      { key: 'remoto_nome_pin', texto: 'Dar o nome "LOJA - CAIXA" ao PC e criar um PIN próprio da loja', dica: 'O Google não recupera o PIN. Anote na ficha da loja.' },
      { key: 'remoto_nao_dormir', texto: 'Windows: configurar para nunca suspender nem hibernar (a tela pode apagar)' },
      { key: 'remoto_inicia', texto: 'Conferir que o acesso remoto liga sozinho junto com o Windows' },
      { key: 'remoto_id_cadastrado', texto: 'Registrar o acesso da loja no cadastro (ID do acesso remoto no card da loja)' },
      { key: 'remoto_teste_casa', texto: 'Testar DE CASA, antes de sair da loja: entrar no PC dela por outra rede e abrir o gestor' },
    ],
  },
  {
    id: 'rede',
    titulo: '2. Internet e computador',
    itens: [
      { key: 'rede_conectada', texto: 'Computador conectado na internet (cabo é melhor que Wi-Fi) e navegando' },
      { key: 'rede_wifi_senha', texto: 'Wi-Fi: anotar nome e senha da rede da loja e conectar o PC, os celulares e a impressora (se for de rede)' },
      { key: 'rede_estavel', texto: 'Testar a internet: abrir o gestor e uma página de vídeo sem travar' },
      { key: 'pc_chrome', texto: 'Chrome instalado e atualizado; gestor.fwcinter.com salvo como favorito e atalho na Área de Trabalho' },
      { key: 'pc_hora', texto: 'Data, hora e fuso do Windows corretos (Fortaleza)' },
      { key: 'pc_ligar', texto: 'Combinar com o dono: o PC fica ligado durante o expediente (e liga sozinho, se possível)' },
    ],
  },
  {
    id: 'impressora',
    titulo: '3. Impressora',
    itens: [
      { key: 'imp_fisica', texto: 'Impressora ligada, com bobina de 80 mm, e o driver instalado no Windows' },
      { key: 'imp_teste_windows', texto: 'Teste de impressão do próprio Windows sai no papel' },
      { key: 'imp_app', texto: 'Baixar e abrir o app Impressora FWC (ele se instala sozinho na Área de Trabalho)' },
      { key: 'imp_escolhida', texto: 'Escolher a impressora da cozinha no app (e a do bar, se tiver duas)', dica: 'Ao instalar o RustDesk de reserva, deixe "Instalar impressora RustDesk" DESMARCADO.' },
      { key: 'imp_teste_app', texto: 'Impressão de teste pelo app sai no papel' },
      { key: 'imp_rede', texto: 'Se a impressora for de rede: ligada no cabo e com IP fixo, não no Wi-Fi' },
      { key: 'imp_conta_cozinha', texto: 'Conferir que conta/pré-conta e comanda da cozinha saem na impressora certa' },
    ],
  },
  {
    id: 'cadastro',
    titulo: '4. Cadastro da loja',
    itens: [
      { key: 'cad_horario', texto: 'Horário de funcionamento + tirar a "pausa manual" de loja nova' },
      { key: 'cad_endereco', texto: 'Endereço com o pino no mapa e "aceita delivery" ligado' },
      { key: 'cad_taxa', texto: 'Taxa de entrega por km ou bairro configurada' },
      { key: 'cad_pagamento', texto: 'Formas de pagamento coerentes (Mercado Pago conectado, se tiver Pix online)' },
      { key: 'cad_cardapio', texto: 'Cardápio: produtos ativos, cada um com foto e categoria' },
      { key: 'cad_visual', texto: 'Logo e capa da loja' },
      { key: 'cad_link', texto: 'Link da Loja Online aberto e testado no celular' },
    ],
  },
  {
    id: 'gestor',
    titulo: '5. Gestor e equipe',
    itens: [
      { key: 'ges_admin', texto: 'Login do dono (administrador) funcionando' },
      { key: 'ges_senha', texto: 'Mostrar ao dono onde troca a senha (Minha Loja → Conta)' },
      { key: 'ges_som', texto: 'Gestor aberto no PC do balcão e som ligado (tocar em "LIGAR O SOM")' },
      { key: 'ges_celular', texto: 'App do gestor instalado no celular do dono' },
      { key: 'ges_equipe', texto: 'Logins de garçom, cozinha e entregador criados, se a loja tiver' },
      { key: 'ges_modulos', texto: 'Funcionalidades da loja no Super Admin (WhatsApp, alarme de chamado etc.) ligadas ou ocultas conforme o uso' },
    ],
  },
  {
    id: 'canais',
    titulo: '6. Canais (só os que a loja usa)',
    itens: [
      { key: 'can_whatsapp', texto: 'WhatsApp: número conectado e robô configurado (se não usa, ocultar o módulo)' },
      { key: 'can_ifood', texto: 'iFood: credenciais ligadas e itens vinculados (item sem vínculo não baixa estoque)' },
      { key: 'can_nfce', texto: 'NFC-e: dados fiscais configurados, se a loja for emitir nota' },
    ],
  },
  {
    id: 'cobranca',
    titulo: '7. Cobrança da FWC',
    itens: [
      { key: 'cob_mensalidade', texto: 'Mensalidade cadastrada no Super Admin (valor, periodicidade e 1º vencimento)' },
      { key: 'cob_cartao', texto: 'Dono avisado de que pode ativar o cartão automático em Minha Mensalidade' },
    ],
  },
  {
    id: 'teste',
    titulo: '8. Teste final (com a loja fechada)',
    aviso: 'Nunca teste no meio do movimento: o pedido de teste soa e imprime de verdade.',
    itens: [
      { key: 'tes_pedido', texto: 'Pedido de teste entra, toca o som e dá para aceitar' },
      { key: 'tes_papel', texto: 'Pedido de teste imprime na impressora certa' },
      { key: 'tes_apagar', texto: 'Pedido de teste apagado depois' },
      { key: 'tes_remoto_final', texto: 'Conferido de casa, pelo acesso remoto, que o gestor está aberto e a loja responde' },
    ],
  },
  {
    id: 'entrega',
    titulo: '9. Entrega ao dono',
    itens: [
      { key: 'ent_treino', texto: 'Treino rápido com o dono e a equipe (aceitar pedido, imprimir, fechar conta)' },
      { key: 'ent_contato', texto: 'Dono sabe como pedir suporte (WhatsApp da FWC)' },
      { key: 'ent_ficha', texto: 'Ficha da loja guardada: nome do PC, PIN do acesso remoto, senha do Wi-Fi e data da instalação' },
    ],
  },
]

export const TOTAL_ITENS_CHECKLIST = CHECKLIST_INSTALACAO.reduce((s, g) => s + g.itens.length, 0)
