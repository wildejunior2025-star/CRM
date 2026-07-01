-- =========================================================
-- Migration 0072 - Auto-criar produtos pelos pedidos (opcional, OFF por padrão)
-- =========================================================
-- A criação automática de produtos a partir dos itens dos pedidos do iFood
-- (Opção B) só ajuda loja NOVA sem cardápio. Loja que já tem menu (a maioria
-- vinda do iFood) acaba com itens duplicados/bagunçados espelhando o cadastro
-- do iFood. Então passa a ser OPCIONAL e vem DESLIGADA por padrão — o lojista
-- liga se quiser em Minha Loja.
-- =========================================================

alter table ifood_config
  add column if not exists auto_criar_produtos boolean not null default false;
