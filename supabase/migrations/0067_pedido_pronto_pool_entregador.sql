-- =========================================================
-- 0067: Status "pronto" + entregador pega o pedido (pool)
-- =========================================================
-- Novo fluxo de entrega self-service:
--   loja marca o pedido como 'pronto' p/ entrega -> ele aparece para TODOS os
--   entregadores da loja -> o entregador clica "Aceitar" (vira entregador_id
--   dele) -> "sair para entrega" -> "entreguei".
-- =========================================================

-- 1. Permite o status 'pronto'
ALTER TABLE pedidos_delivery DROP CONSTRAINT IF EXISTS pedidos_delivery_status_check;
ALTER TABLE pedidos_delivery ADD CONSTRAINT pedidos_delivery_status_check
  CHECK (status = ANY (ARRAY[
    'aguardando_pagamento','aguardando','confirmado','em_preparo',
    'pronto','saiu_entrega','entregue','cancelado'
  ]));

-- 2. RLS: o entregador enxerga os pedidos atribuídos a ele E os que estão
--    'pronto' sem dono (o pool disponível), dentro da própria empresa.
DROP POLICY IF EXISTS "Entregador ve seus pedidos" ON pedidos_delivery;
CREATE POLICY "Entregador ve seus pedidos"
  ON pedidos_delivery FOR SELECT
  TO authenticated
  USING (
    current_perfil() = 'entregador'
    AND empresa_id = current_empresa_id()
    AND (entregador_id = auth.uid() OR (entregador_id IS NULL AND status = 'pronto'))
  );

-- 3. RLS UPDATE: pode "pegar" um pedido do pool (null + pronto) e atualizar os
--    seus; o WITH CHECK garante que, depois, o pedido fique com ele (não dá pra
--    atribuir a outro nem soltar pra ninguém).
DROP POLICY IF EXISTS "Entregador atualiza seus pedidos" ON pedidos_delivery;
CREATE POLICY "Entregador atualiza seus pedidos"
  ON pedidos_delivery FOR UPDATE
  TO authenticated
  USING (
    current_perfil() = 'entregador'
    AND empresa_id = current_empresa_id()
    AND (entregador_id = auth.uid() OR (entregador_id IS NULL AND status = 'pronto'))
  )
  WITH CHECK (
    current_perfil() = 'entregador'
    AND empresa_id = current_empresa_id()
    AND entregador_id = auth.uid()
  );
