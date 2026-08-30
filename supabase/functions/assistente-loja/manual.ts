// Manual do sistema — o que a IA sabe sobre ONDE fica cada coisa.
//
// Isto NAO e documentacao pro programador: e o texto que a IA le pra dizer ao
// dono da loja "clica aqui, depois ali". Por isso e escrito em passo a passo,
// com o nome EXATO do menu e do botao que aparece na tela.
//
// Mexeu no menu (src/components/Layout.jsx) ou renomeou uma tela? Atualize aqui
// junto. IA que manda o dono clicar num botao que nao existe mais perde a
// confianca dele na hora — e ele liga pro suporte do mesmo jeito.

export const MANUAL = `
== ONDE FICA CADA COISA (menu da esquerda) ==

OPERACOES
- Dashboard — faturamento, graficos, top produtos, ranking de clientes, meta do mes.
- Vendas > Vendas delivery — todos os pedidos de delivery (app, WhatsApp, loja online, iFood).
- Vendas > Entregadores — cadastro dos motoboys e o historico de entregas de cada um.
- Vendas > Vendas salao — contas de mesa ja fechadas.
- Clientes — cadastro, historico de compras e saldo de cada cliente.
- Funcionarios — quem tem login no sistema e o que cada um pode ver.
- Servico Presencial — mesas, comandas, reservas e a Cozinha (KDS).
- Catalogo > Produtos — cadastro de produto, preco, foto, categoria.
- Catalogo > Cardapio iFood — so aparece pra quem tem iFood conectado.
- Catalogo > Complementos — adicionais e opcoes por produto (ex: monte sua quentinha).
- Catalogo > Ficha Tecnica — o que entra em cada prato, pra calcular o custo.
- Catalogo > Estoque — entrada, saida e saldo por produto.

DELIVERY
- Minha Loja — nome, banner, logo e dados da loja.
- Minha Loja > Raio de Entrega — bairros e taxa de entrega.
- Minha Loja > Horarios — grade da semana (quando a loja abre e fecha) e feriados.
- Minha Loja > Pagamento — formas de pagamento aceitas, Mercado Pago e chave PIX.
- Minha Loja > Integracoes — iFood.
- Minha Loja > Nota Fiscal — certificado A1 e emissao de NFC-e.
- Minha Loja > Conta — email, senha e dados do responsavel.

AUTOMACAO
- WhatsApp > Conexao / Config — conectar o numero e configurar o robo.
- WhatsApp > Conversas do bot — ler as conversas que o robo teve.
- WhatsApp > Creditos Bot — comprar credito pro robo atender.
- WhatsApp > Teste Bot — conversar com o robo pra testar sem gastar credito.

FINANCEIRO
- Indicacao e Cashback — programa de indicacao e credito de volta pro cliente.
- Financeiro — tem 3 abas no topo: "Recebimentos", "Despesas & Lucro" e "Fiado".
- Relatorios — relatorios por periodo pra exportar.

OUTRAS TELAS (fora do menu)
- Gestor de pedidos: endereco /painel — e a fila onde os pedidos caem e andam
  (aceitar, imprimir, pronto, saiu pra entrega). E a tela do balcao no dia a dia.
- App do entregador: endereco /entregas.
- Loja online do cliente: lojaonline.fwcinter.com/ + o apelido (slug) da loja.

== PASSO A PASSO DAS DUVIDAS MAIS COMUNS ==

RECEBER PIX AUTOMATICO (CONECTAR O MERCADO PAGO)
O PIX cai direto na conta da loja e o pedido so entra depois que o pagamento e
confirmado. Passo a passo:
1. Menu Minha Loja > Pagamento.
2. Desca ate o quadro "Receber PIX automatico (Mercado Pago)".
3. Clique em "Conectar Mercado Pago". Abre a tela do proprio Mercado Pago.
4. Entre com o login do Mercado Pago DA LOJA e autorize o acesso.
5. Voltando pro sistema aparece "Mercado Pago conectado com sucesso!".
6. Na mesma tela, mais acima, marque "PIX" em "Formas de pagamento aceitas" —
   senao o cliente nao ve a opcao no checkout.
Pra desligar, e o botao "Desconectar" no mesmo quadro.
Diferenca importante: "PIX" e a cobranca online pelo Mercado Pago (tem taxa, o
cliente paga antes). "PIX na entrega" e o cliente pagar na chave da loja na hora
da entrega — sem taxa, sem Mercado Pago, e o pedido cai na loja na hora.

FECHAR O DIA / VER O LUCRO
1. Menu Financeiro > aba "Despesas & Lucro".
2. Cadastre uma vez as despesas fixas do mes (aluguel, energia, agua, internet,
   gas) e os funcionarios com o salario — o sistema divide pelos dias abertos.
3. No dia a dia, lance a producao do dia e os custos imprevistos.
4. Clique em "Fechar o dia" pra congelar o resultado. So depois de fechado o dia
   entra no "Historico de despesas diarias" e o lucro daquele dia fica gravado.
Enquanto o dia nao e fechado da pra ver o parcial na propria tela, mas o numero
ainda pode mudar.

VER QUANTO VENDEU
- Dashboard: escolha Hoje, 7 dias, 30 dias, Mes ou Personalizado.
- Financeiro > Recebimentos: o que efetivamente entrou, por forma de pagamento.
- Relatorios: pra exportar por periodo.

CONECTAR O IFOOD
Menu Minha Loja > Integracoes. Clique em conectar, autorize com a conta iFood da
loja e escolha a loja na lista. Depois o cardapio se gerencia em
Catalogo > Cardapio iFood e os pedidos caem no /painel junto com os outros.

CADASTRAR PRODUTO
Menu Catalogo > Produtos > botao "Novo produto". Preencha nome, preco, categoria
e foto. Pra o produto aparecer na loja online ele precisa estar ativo e ter
categoria. Adicionais/opcoes ficam em Catalogo > Complementos.

MUDAR HORARIO DE FUNCIONAMENTO
Menu Minha Loja > Horarios. Monte a grade da semana. A loja so aceita pedido se
estiver com o delivery ligado E dentro da grade. Pra fechar por um dia especifico
(feriado) use os feriados na mesma tela.

TAXA DE ENTREGA / BAIRRO
Menu Minha Loja > Raio de Entrega. Da pra cobrar por bairro ou por distancia.

IMPRESSORA
A impressao dos pedidos se configura no /painel, na barra lateral direita, no
item "Impressora". Da pra imprimir automatico todo pedido que chega. No celular a
impressao e pela impressora Bluetooth; no computador tem o aplicativo
"Impressora FWC", que se baixa por ali mesmo.

ROBO DO WHATSAPP
Menu WhatsApp > Conexao / Config pra ligar o numero. O robo consome credito: se o
credito acaba ele para de responder — o credito se compra em WhatsApp >
Creditos Bot. Pra testar sem gastar, WhatsApp > Teste Bot.

FIADO
Menu Financeiro > aba "Fiado" mostra quem deve e quanto. O saldo de cada cliente
tambem aparece na ficha dele em Clientes.

ESTOQUE
Menu Catalogo > Estoque. Defina o estoque minimo de cada produto pra o sistema
avisar quando estiver acabando. Produto sem minimo definido nunca aparece como
"estoque baixo".

FUNCIONARIO NOVO
Menu Funcionarios > "Novo". Escolha o perfil: admin (ve tudo), vendedor (so o
/painel), garcom (so o salao) ou cozinheiro (so a cozinha).
`
