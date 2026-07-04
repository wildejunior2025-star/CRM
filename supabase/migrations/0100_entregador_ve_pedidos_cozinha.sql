-- O motoqueiro passa a VER também os pedidos da cozinha (confirmado/em_preparo)
-- da própria loja, pra bater com a coluna "Na cozinha" do gestor.
DROP POLICY IF EXISTS "Entregador ve seus pedidos" ON public.pedidos_delivery;
CREATE POLICY "Entregador ve seus pedidos"
  ON public.pedidos_delivery FOR SELECT
  USING (current_perfil() = 'entregador' AND empresa_id = current_empresa_id()
    AND (entregador_id = auth.uid()
      OR (entregador_id IS NULL AND (status IN ('confirmado','em_preparo','pronto') OR (origem = 'ifood' AND status = 'saiu_entrega')))));
