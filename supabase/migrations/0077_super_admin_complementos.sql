-- =========================================================
-- Migration 0077 - Super admin gerencia complementos (impersonação)
-- =========================================================
-- Mesmo motivo da 0076 (produtos): super_admin não tinha policy nas tabelas de
-- complementos, então ao impersonar uma loja os grupos/opções de complemento
-- não carregavam (ex.: escolher complementos numa venda de balcão).
-- =========================================================

drop policy if exists "Super admin gerencia complemento_grupos" on complemento_grupos;
create policy "Super admin gerencia complemento_grupos"
  on complemento_grupos for all
  using (current_perfil() = 'super_admin') with check (current_perfil() = 'super_admin');

drop policy if exists "Super admin gerencia complemento_opcoes" on complemento_opcoes;
create policy "Super admin gerencia complemento_opcoes"
  on complemento_opcoes for all
  using (current_perfil() = 'super_admin') with check (current_perfil() = 'super_admin');
