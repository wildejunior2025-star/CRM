-- =========================================================
-- 0079: Entregador pode DESISTIR de uma entrega que aceitou
-- =========================================================
-- E3 — hoje o WITH CHECK da policy de UPDATE exige entregador_id = auth.uid(),
-- então o motoqueiro não consegue "largar" o pedido de volta pro pool.
-- Aqui liberamos o caso de devolver ao pool: entregador_id = NULL e status
-- volta pra 'pronto' (para outro motoqueiro pegar).
-- =========================================================

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
    -- pode ficar com ele (pegar/tocar o pedido) OU devolver pro pool (largar)
    AND (entregador_id = auth.uid() OR (entregador_id IS NULL AND status = 'pronto'))
  );
