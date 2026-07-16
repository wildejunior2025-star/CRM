-- =========================================================
-- Migration 0104 - NFC-e: padrões fiscais no nível da loja
-- =========================================================
-- Aditivo. Padrões aplicados a todo produto que não tiver override próprio
-- (colunas ncm/cfop/csosn/origem em produtos, migration 0103). Evita a loja
-- preencher NCM produto a produto — a maioria das lojas de comida usa o mesmo.
-- =========================================================
alter table empresa_fiscal
  add column if not exists ncm_padrao    text default '21069090',
  add column if not exists cfop_padrao   text default '5102',
  add column if not exists csosn_padrao  text default '102',
  add column if not exists origem_padrao text default '0';
