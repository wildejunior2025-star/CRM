-- =========================================================
-- Migration 0075 - Remove RLS que vazava dados entre lojas
-- =========================================================
-- SEGURANÇA: as tabelas vendas, venda_itens e pagamentos tinham uma policy
-- "Usuários autenticados podem tudo - ..." com condição `auth.role() =
-- 'authenticated'` (cmd ALL). Como as policies do Postgres são PERMISSIVAS
-- (somam por OR), essa policy liberava QUALQUER usuário logado a ver/editar
-- os registros de TODAS as empresas — ignorando o empresa_id.
--
-- Efeito real observado: o admin do Zebu via as vendas da "deposito da gaby"
-- na página Vendas.
--
-- Cada tabela já tem a policy correta escopada por empresa (admin/vendedor +
-- empresa_id, e cliente vê os próprios). Basta remover as perigosas.
-- =========================================================

drop policy if exists "Usuários autenticados podem tudo - vendas"      on vendas;
drop policy if exists "Usuários autenticados podem tudo - venda_itens" on venda_itens;
drop policy if exists "Usuários autenticados podem tudo - pagamentos"  on pagamentos;
