-- =========================================================
-- Migration 0021 - Fix: admin pode atualizar a própria empresa
-- =========================================================
-- Problema: a migration 0006 criou apenas SELECT para admin na tabela empresas.
-- O UPDATE do MinhaLoja.jsx (nome, banner_url, logo_url, configurações de delivery)
-- falha com "new row violates row-level security policy" porque não há policy
-- de UPDATE para o perfil 'admin'.
--
-- Solução: adicionar policy específica de UPDATE para admin.
-- Não alteramos a policy SELECT existente ("Usuario ve a propria empresa").
-- O super_admin já tem FOR ALL pela policy da migration 0006.
-- =========================================================

drop policy if exists "Admin atualiza propria empresa" on empresas;

create policy "Admin atualiza propria empresa"
  on empresas for update
  using  (current_perfil() = 'admin' and id = current_empresa_id())
  with check (current_perfil() = 'admin' and id = current_empresa_id());

-- Storage: garante que a policy de INSERT/UPDATE aceita o super_admin também
-- (caso um super_admin precise testar upload de banner de uma empresa).
-- As policies de storage criadas em 0012 já cobrem 'admin'; aqui adicionamos super_admin.
drop policy if exists "empresa-banners: upload super_admin" on storage.objects;
create policy "empresa-banners: upload super_admin"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'empresa-banners'
    and current_perfil() = 'super_admin'
  );

drop policy if exists "empresa-banners: update super_admin" on storage.objects;
create policy "empresa-banners: update super_admin"
  on storage.objects for update
  to authenticated
  using (
    bucket_id = 'empresa-banners'
    and current_perfil() = 'super_admin'
  );
