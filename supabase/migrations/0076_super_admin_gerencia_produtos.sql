-- =========================================================
-- Migration 0076 - Super admin gerencia produtos (impersonação)
-- =========================================================
-- Quando o super_admin (plataforma) acessa/impersona uma loja, o
-- current_empresa_id() dele é nulo (ele não tem empresa própria). As policies
-- de produtos escopadas por empresa não batiam, então a busca de produtos
-- (ex.: "+ Vender" pelo balcão no gestor) vinha vazia pra ele.
--
-- Aqui damos ao super_admin acesso total a produtos (igual já existe em
-- pedidos_delivery), pra ele conseguir operar/dar suporte na loja impersonada.
-- =========================================================

drop policy if exists "Super admin gerencia produtos" on produtos;
create policy "Super admin gerencia produtos"
  on produtos for all
  using (current_perfil() = 'super_admin')
  with check (current_perfil() = 'super_admin');
