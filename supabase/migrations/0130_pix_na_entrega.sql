-- =========================================================
-- Migration 0130 - Forma de pagamento "PIX na entrega"
-- =========================================================
-- Hoje só existe um PIX: o ONLINE, que gera cobrança no Mercado Pago. Ele
-- obriga a loja a conectar o MP e cobra taxa por transação — e tem lojista
-- que não quer nem uma coisa nem outra: quer só receber o PIX na mão do
-- cliente, na hora que o motoqueiro entrega, direto na chave da loja.
--
-- 'pix_entrega' é isso: NÃO passa por gateway nenhum, não gera QR do MP, o
-- pedido cai na loja na hora (como dinheiro/cartão) e o entregador cobra na
-- porta. Pro acerto do entregador conta como 'na_conta' (o dinheiro cai
-- direto na conta da loja, não fica na mão dele) — o CASE do resumo dos
-- entregadores já joga qualquer forma desconhecida nesse balde, então não
-- precisa mexer nele.
--
-- Ninguém passa a aceitar sozinho: a forma nasce DESLIGADA em todas as
-- lojas (o default da coluna continua com as 3 de sempre). Quem quiser,
-- liga em Minha Loja → Pagamento.
-- =========================================================

alter table public.pedidos_delivery
  drop constraint if exists pedidos_delivery_forma_pagamento_check;

alter table public.pedidos_delivery
  add constraint pedidos_delivery_forma_pagamento_check
  check (forma_pagamento = any (array[
    'pix'::text, 'pix_entrega'::text, 'dinheiro'::text, 'credito'::text,
    'debito'::text, 'cartao'::text, 'online'::text, 'vale'::text, 'outro'::text
  ]));

comment on column public.empresas.formas_pagamento is
  'Formas de pagamento aceitas: subconjunto de dinheiro/pix/pix_entrega/cartao. '
  'Controla os botões da Nova venda e do checkout da Loja Online. Vazio = todas. '
  'pix = cobrança online no Mercado Pago; pix_entrega = cliente paga na chave da loja na entrega.';
