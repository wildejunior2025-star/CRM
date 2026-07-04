-- Bug: a policy de SELECT deixava o entregador VER pedidos iFood em 'saiu_entrega'
-- (aparecem em Disponíveis), mas a de UPDATE só permitia PEGAR os 'pronto'. Resultado:
-- clicar "Aceitar" num pedido iFood não fazia nada (0 linhas). Alinha as duas.
DROP POLICY IF EXISTS "Entregador atualiza seus pedidos" ON public.pedidos_delivery;
CREATE POLICY "Entregador atualiza seus pedidos"
  ON public.pedidos_delivery FOR UPDATE
  USING (current_perfil() = 'entregador' AND empresa_id = current_empresa_id()
    AND (entregador_id = auth.uid() OR (entregador_id IS NULL AND (status = 'pronto' OR (origem = 'ifood' AND status = 'saiu_entrega')))))
  WITH CHECK (current_perfil() = 'entregador' AND empresa_id = current_empresa_id()
    AND (entregador_id = auth.uid() OR (entregador_id IS NULL AND (status = 'pronto' OR (origem = 'ifood' AND status = 'saiu_entrega')))));
