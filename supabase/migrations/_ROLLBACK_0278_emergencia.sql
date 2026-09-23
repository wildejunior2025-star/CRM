-- DESFAZER a 0278, só em emergência.
--
-- Use se, depois da 0278, alguém deixar de enxergar pedido que deveria ver.
-- Devolve as policies de pedidos_delivery exatamente ao texto que estava no
-- banco antes (23/09/2026, 11h30), sem o (select ...).
--
-- Custo de voltar: o banco recomeça a reler `profiles` linha por linha, que é
-- o que derrubou o sistema às 10h40. Então isto é parada de emergência, não
-- solução — se precisar usar, o certo é achar a policy errada e corrigir só
-- ela, não abandonar a otimização inteira.
--
-- Não é migration: o nome começa com _ pra não entrar na ordem de aplicação.

SET lock_timeout = '12s';

ALTER POLICY "Admin gerencia pedidos da propria empresa" ON public.pedidos_delivery
  USING      ((current_perfil() = 'admin') AND (empresa_id = current_empresa_id()))
  WITH CHECK ((current_perfil() = 'admin') AND (empresa_id = current_empresa_id()));

ALTER POLICY "Super admin gerencia todos os pedidos delivery" ON public.pedidos_delivery
  USING      (current_perfil() = 'super_admin')
  WITH CHECK (current_perfil() = 'super_admin');

ALTER POLICY "Vendedor gerencia pedidos da propria empresa" ON public.pedidos_delivery
  USING      ((current_perfil() = 'vendedor') AND (empresa_id = current_empresa_id()))
  WITH CHECK ((current_perfil() = 'vendedor') AND (empresa_id = current_empresa_id()));

ALTER POLICY "Cliente ve seus pedidos" ON public.pedidos_delivery
  USING (user_id = auth.uid());

ALTER POLICY "Cliente ve seus pedidos delivery" ON public.pedidos_delivery
  USING (cliente_id IN (SELECT clientes.id FROM clientes WHERE clientes.user_id = auth.uid()));

ALTER POLICY "Cozinheiro ve pedidos delivery da loja" ON public.pedidos_delivery
  USING ((current_perfil() = 'cozinheiro') AND (empresa_id = current_empresa_id()));

ALTER POLICY "Entregador ve seus pedidos" ON public.pedidos_delivery
  USING ((current_perfil() = 'entregador')
         AND (empresa_id = current_empresa_id())
         AND ((entregador_id = auth.uid())
              OR ((entregador_id IS NULL)
                  AND ((status = ANY (ARRAY['confirmado'::text, 'em_preparo'::text, 'pronto'::text]))
                       OR ((origem = 'ifood') AND (status = 'saiu_entrega'))))));

ALTER POLICY "Usuario ve pedido pelo user_id" ON public.pedidos_delivery
  USING (user_id = auth.uid());

ALTER POLICY "Admin atualiza pedido delivery" ON public.pedidos_delivery
  USING      (((current_perfil() = 'admin') AND (empresa_id = current_empresa_id()))
              OR (current_perfil() = 'super_admin'))
  WITH CHECK (((current_perfil() = 'admin') AND (empresa_id = current_empresa_id()))
              OR (current_perfil() = 'super_admin'));

ALTER POLICY "Cozinheiro atualiza status delivery" ON public.pedidos_delivery
  USING      ((current_perfil() = 'cozinheiro') AND (empresa_id = current_empresa_id()))
  WITH CHECK ((current_perfil() = 'cozinheiro') AND (empresa_id = current_empresa_id()));

ALTER POLICY "Entregador atualiza seus pedidos" ON public.pedidos_delivery
  USING      ((current_perfil() = 'entregador')
              AND (empresa_id = current_empresa_id())
              AND ((entregador_id = auth.uid())
                   OR ((entregador_id IS NULL)
                       AND ((status = ANY (ARRAY['confirmado'::text, 'em_preparo'::text, 'pronto'::text]))
                            OR ((origem = 'ifood') AND (status = 'saiu_entrega'))))))
  WITH CHECK ((current_perfil() = 'entregador')
              AND (empresa_id = current_empresa_id())
              AND ((entregador_id = auth.uid())
                   OR ((entregador_id IS NULL)
                       AND ((status = ANY (ARRAY['confirmado'::text, 'em_preparo'::text, 'pronto'::text]))
                            OR ((origem = 'ifood') AND (status = 'saiu_entrega'))))));
