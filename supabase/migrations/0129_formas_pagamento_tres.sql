-- Formas de pagamento: só as 3 do dia a dia (dinheiro, pix, cartão).
--
-- A coluna `empresas.formas_pagamento` era gravada por Minha Loja mas NUNCA lida
-- por ninguém — as telas de venda sempre mostraram Dinheiro/PIX/Cartão fixos.
-- Agora ela passa a valer de verdade (Nova venda + checkout da Loja Online), e
-- por isso o conteúdo velho precisa sair: eram bandeiras (visa_debito…) e
-- condições de cliente (a_vista, fiado, boleto_30d) que não existem mais na
-- lista. Deixar como estava faria PIX e Cartão SUMIREM de lojas no ar.
--
-- Todas as lojas começam com as 3 ligadas = exatamente o que elas já mostram
-- hoje. Quem não usar alguma, desmarca na tela.
update public.empresas
set formas_pagamento = '["dinheiro", "pix", "cartao"]'::jsonb;

alter table public.empresas
  alter column formas_pagamento set default '["dinheiro", "pix", "cartao"]'::jsonb;

comment on column public.empresas.formas_pagamento is
  'Formas de pagamento aceitas: subconjunto de dinheiro/pix/cartao. Controla os botões da Nova venda e do checkout da Loja Online. Vazio = as 3.';
