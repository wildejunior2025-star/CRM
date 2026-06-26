-- =========================================================
-- Portal Delivery: RLS para clientes autenticados
-- =========================================================

-- Clientes autenticados podem criar pedidos de delivery
drop policy if exists "Cliente cria pedido delivery" on pedidos_delivery;
create policy "Cliente cria pedido delivery"
  on pedidos_delivery for insert
  to authenticated
  with check (current_perfil() = 'cliente');

-- Clientes autenticados podem ver seus próprios pedidos de delivery
-- (qualquer clientes.id vinculado ao user_id atual)
drop policy if exists "Cliente ve seus pedidos delivery" on pedidos_delivery;
create policy "Cliente ve seus pedidos delivery"
  on pedidos_delivery for select
  to authenticated
  using (
    current_perfil() = 'cliente'
    and cliente_id in (
      select id from clientes where user_id = auth.uid()
    )
  );
