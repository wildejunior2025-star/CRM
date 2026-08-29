-- =========================================================
-- Migration 0204 — Loja sem cozinha no presencial
-- =========================================================
-- O Salão foi desenhado pra restaurante: o garçom lança os itens num rascunho,
-- confere e aperta "Enviar para a cozinha", que imprime a comanda de preparo.
--
-- Depósito de bebida, conveniência, adega — não tem preparo nenhum. O produto
-- sai da prateleira pro cliente. Ali essa etapa é um clique a mais em cada
-- rodada, num botão que fala de uma cozinha que não existe, e ainda deixa o
-- item marcado como "preparando" esperando alguém marcar pronto.
--
-- Com a coluna ligada, o item cai direto na comanda ao ser escolhido: sem
-- rascunho, sem botão de enviar e sem papel de cozinha.
-- =========================================================

alter table public.empresas
  add column if not exists presencial_sem_cozinha boolean not null default false;

comment on column public.empresas.presencial_sem_cozinha is
  'Loja sem preparo (depósito, conveniência): no Salão o item vai direto pra comanda, sem a etapa de enviar pra cozinha.';
