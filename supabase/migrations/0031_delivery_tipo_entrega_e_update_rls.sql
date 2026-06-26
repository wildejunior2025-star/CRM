-- Migration 0031: Adiciona tipo_entrega e policy UPDATE para admin/super_admin
-- no módulo de delivery.

-- 1. Adiciona coluna tipo_entrega
ALTER TABLE pedidos_delivery
  ADD COLUMN IF NOT EXISTS tipo_entrega text NOT NULL DEFAULT 'entrega';

-- 2. Garante que apenas valores válidos sejam inseridos
ALTER TABLE pedidos_delivery
  DROP CONSTRAINT IF EXISTS pedidos_delivery_tipo_entrega_check;
ALTER TABLE pedidos_delivery
  ADD CONSTRAINT pedidos_delivery_tipo_entrega_check
  CHECK (tipo_entrega IN ('entrega', 'retirada'));

-- 3. Policy UPDATE para admin (mesma empresa) e super_admin
--    A migration 0020 criou policies FOR ALL para admin e super_admin,
--    mas essas policies usam USING sem WITH CHECK — e o Postgres exige
--    WITH CHECK para UPDATE quando RLS está habilitado.
--    Criamos uma policy dedicada FOR UPDATE para cobrir o caso.
DROP POLICY IF EXISTS "Admin atualiza pedido delivery" ON pedidos_delivery;
CREATE POLICY "Admin atualiza pedido delivery"
  ON pedidos_delivery FOR UPDATE
  TO authenticated
  USING (
    (current_perfil() = 'admin' AND empresa_id = current_empresa_id())
    OR current_perfil() = 'super_admin'
  )
  WITH CHECK (
    (current_perfil() = 'admin' AND empresa_id = current_empresa_id())
    OR current_perfil() = 'super_admin'
  );
