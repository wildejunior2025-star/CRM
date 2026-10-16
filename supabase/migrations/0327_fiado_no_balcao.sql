-- FIADO NA TELA DE VENDER (BALCÃO) — 16/10/2026
--
-- O Salão já vende fiado; o "+ Vender" do gestor não. Pedido do usuário: ter
-- igual, mas SÓ no balcão — no cardápio online o cliente nunca pode escolher
-- fiado (as formas da Loja Online vêm de `empresas.formas_pagamento`, que esta
-- migração não encosta).
--
-- POR QUE PRECISA DE COLUNA, se é só uma forma de pagamento a mais:
--
-- A dívida do fiado mora em `vendas` — a tela de Clientes/Fiado soma as vendas
-- cujo `forma_pagamento` não é 'a_vista' e abate os `pagamentos`. Mas o
-- "+ Vender" grava em `pedidos_delivery`, e nada liga uma tabela na outra. Sem
-- isso, o vendedor marca fiado, a tela diz que deu certo e a dívida não aparece
-- em lugar nenhum pra cobrar.
--
-- Só que o Dashboard soma o faturamento das DUAS tabelas. Criar a venda da
-- dívida além do pedido faria o dia contar o mesmo dinheiro duas vezes. Daí a
-- coluna: a venda nascida de um pedido aponta pra ele, e quem soma faturamento
-- ignora essas (o pedido já está contado). Quem soma DÍVIDA continua contando,
-- que é o ponto.
--
-- `on delete set null`: apagar o pedido não pode apagar a dívida junto — o
-- cliente levou a mercadoria do mesmo jeito.

alter table public.vendas
  add column if not exists pedido_id uuid references public.pedidos_delivery(id) on delete set null;

create index if not exists idx_vendas_pedido on public.vendas (pedido_id)
  where pedido_id is not null;

comment on column public.vendas.pedido_id is
  'Pedido do balcão que gerou esta venda (fiado no + Vender). Preenchido = o faturamento já está contado em pedidos_delivery; esta linha serve só como dívida.';
