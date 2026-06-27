-- =========================================================
-- 0066: Gestão de entregas — perfil entregador + atribuição
-- =========================================================
-- O2 — a loja atribui um entregador ao pedido de delivery; o entregador
-- loga no celular, vê só os pedidos dele, abre a rota no mapa e confirma a
-- entrega com o código do cliente.
-- =========================================================

-- 1. Novo perfil 'entregador'
ALTER TABLE profiles DROP CONSTRAINT IF EXISTS profiles_perfil_check;
ALTER TABLE profiles ADD CONSTRAINT profiles_perfil_check
  CHECK (perfil = ANY (ARRAY['admin','vendedor','garcom','cozinheiro','entregador','cliente','super_admin']));

-- 2. Quem leva o pedido + quando saiu (saiu_entrega_at já era usado no front,
--    mas nunca tinha sido criado formalmente)
ALTER TABLE pedidos_delivery
  ADD COLUMN IF NOT EXISTS entregador_id   uuid REFERENCES profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS saiu_entrega_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_pedidos_entregador ON pedidos_delivery(entregador_id);

-- 3. RLS: entregador enxerga e atualiza apenas os pedidos atribuídos a ele,
--    dentro da própria empresa.
DROP POLICY IF EXISTS "Entregador ve seus pedidos" ON pedidos_delivery;
CREATE POLICY "Entregador ve seus pedidos"
  ON pedidos_delivery FOR SELECT
  TO authenticated
  USING (
    current_perfil() = 'entregador'
    AND empresa_id = current_empresa_id()
    AND entregador_id = auth.uid()
  );

DROP POLICY IF EXISTS "Entregador atualiza seus pedidos" ON pedidos_delivery;
CREATE POLICY "Entregador atualiza seus pedidos"
  ON pedidos_delivery FOR UPDATE
  TO authenticated
  USING (
    current_perfil() = 'entregador'
    AND empresa_id = current_empresa_id()
    AND entregador_id = auth.uid()
  )
  WITH CHECK (
    current_perfil() = 'entregador'
    AND empresa_id = current_empresa_id()
    AND entregador_id = auth.uid()
  );
