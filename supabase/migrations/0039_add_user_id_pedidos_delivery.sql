-- Adiciona user_id em pedidos_delivery para RLS por usuário autenticado.
-- O campo cliente_id pode ser null para usuários do catálogo que ainda não têm
-- registro em clientes, então a policy antiga (via cliente_id → clientes.user_id)
-- retornava 403 na tela de confirmação de pedido.
ALTER TABLE pedidos_delivery
  ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES auth.users(id);

-- Policy de SELECT: usuário autenticado vê apenas seus próprios pedidos pelo user_id.
-- Mantém a policy anterior (via cliente_id) para compatibilidade com pedidos legados
-- que tenham cliente_id preenchido mas user_id null.
DROP POLICY IF EXISTS "Usuario ve pedido pelo user_id" ON pedidos_delivery;
CREATE POLICY "Usuario ve pedido pelo user_id"
ON pedidos_delivery FOR SELECT
TO authenticated
USING (user_id = auth.uid());
