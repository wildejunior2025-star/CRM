-- Categoria "só iFood": combo que existe apenas no cardápio do iFood.
-- Fica fora da Loja Online/app/robô (via oculta_online) e também da mesa por QR
-- e do link do cliente, que não respeitam oculta_online (o Happy Hour precisa
-- aparecer na mesa). No balcão/PDV o atendente continua enxergando.
alter table public.categorias
  add column if not exists so_ifood boolean not null default false;
