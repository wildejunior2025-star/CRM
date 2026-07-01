-- =========================================================
-- Migration 0073 - Entregador enxerga entregas do iFood despachadas
-- =========================================================
-- A RLS do entregador só liberava pedidos com status 'pronto' e sem dono.
-- Mas os pedidos de ENTREGA do iFood costumam ir direto pra 'saiu_entrega'
-- (despachado no iFood), pulando o 'pronto' — então nunca apareciam pro
-- motoboy da loja pegar. Aqui liberamos também os iFood em 'saiu_entrega'
-- sem entregador, pra o motoboy poder aceitar e levar.
-- =========================================================

drop policy if exists "Entregador ve seus pedidos" on pedidos_delivery;
create policy "Entregador ve seus pedidos"
  on pedidos_delivery for select
  using (
    current_perfil() = 'entregador'
    and empresa_id = current_empresa_id()
    and (
      entregador_id = auth.uid()
      or (
        entregador_id is null
        and (
          status = 'pronto'
          or (origem = 'ifood' and status = 'saiu_entrega')
        )
      )
    )
  );

drop policy if exists "Entregador atualiza seus pedidos" on pedidos_delivery;
create policy "Entregador atualiza seus pedidos"
  on pedidos_delivery for update
  using (
    current_perfil() = 'entregador'
    and empresa_id = current_empresa_id()
    and (
      entregador_id = auth.uid()
      or (
        entregador_id is null
        and (
          status = 'pronto'
          or (origem = 'ifood' and status = 'saiu_entrega')
        )
      )
    )
  )
  with check (
    current_perfil() = 'entregador'
    and empresa_id = current_empresa_id()
    and (
      entregador_id = auth.uid()
      or (
        entregador_id is null
        and (
          status = 'pronto'
          or (origem = 'ifood' and status = 'saiu_entrega')
        )
      )
    )
  );
