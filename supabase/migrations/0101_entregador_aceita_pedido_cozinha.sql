-- O motoqueiro agora VÊ os pedidos da cozinha (confirmado/em_preparo) e pode
-- RESERVAR (aceitar) enquanto cozinha. Alinha a policy de UPDATE e a RPC do modo
-- fila com os mesmos status da policy de SELECT (mig 0100).
DROP POLICY IF EXISTS "Entregador atualiza seus pedidos" ON public.pedidos_delivery;
CREATE POLICY "Entregador atualiza seus pedidos"
  ON public.pedidos_delivery FOR UPDATE
  USING (current_perfil() = 'entregador' AND empresa_id = current_empresa_id()
    AND (entregador_id = auth.uid()
      OR (entregador_id IS NULL AND (status IN ('confirmado','em_preparo','pronto') OR (origem = 'ifood' AND status = 'saiu_entrega')))))
  WITH CHECK (current_perfil() = 'entregador' AND empresa_id = current_empresa_id()
    AND (entregador_id = auth.uid()
      OR (entregador_id IS NULL AND (status IN ('confirmado','em_preparo','pronto') OR (origem = 'ifood' AND status = 'saiu_entrega')))));
-- (a RPC entregador_aceitar_pedido tambem foi atualizada com os mesmos status)
