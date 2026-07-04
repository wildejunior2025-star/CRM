-- Detalhamento financeiro do iFood (itens, taxa, incentivos loja/iFood, pago),
-- pra mostrar no gestor igual ao app do iFood.
ALTER TABLE public.pedidos_delivery ADD COLUMN IF NOT EXISTS ifood_valores jsonb;
