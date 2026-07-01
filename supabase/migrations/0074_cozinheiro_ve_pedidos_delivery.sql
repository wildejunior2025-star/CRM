-- =========================================================
-- Migration 0074 - Cozinheiro enxerga pedidos de delivery/iFood no KDS
-- =========================================================
-- A tela Cozinha (KDS) só mostrava itens das mesas (comanda_itens). Agora ela
-- também mostra os pedidos de delivery/iFood em preparo, então o cozinheiro
-- precisa poder ler esses pedidos e marcar como pronto (status).
-- =========================================================

drop policy if exists "Cozinheiro ve pedidos delivery da loja" on pedidos_delivery;
create policy "Cozinheiro ve pedidos delivery da loja"
  on pedidos_delivery for select
  using (
    current_perfil() = 'cozinheiro'
    and empresa_id = current_empresa_id()
  );

drop policy if exists "Cozinheiro atualiza status delivery" on pedidos_delivery;
create policy "Cozinheiro atualiza status delivery"
  on pedidos_delivery for update
  using (
    current_perfil() = 'cozinheiro'
    and empresa_id = current_empresa_id()
  )
  with check (
    current_perfil() = 'cozinheiro'
    and empresa_id = current_empresa_id()
  );
