-- A tabela nasceu com uma linha só (o app de pedidos). Agora existe um segundo
-- app: o iFood só libera o módulo Financial para aplicativo da categoria
-- Financial, então as chamadas /financial/* usam credenciais próprias.
--   id = 1 → app de pedidos/cardápio (crm-fwc, categoria PDV)
--   id = 2 → app financeiro (crm-fwc-financeiro, categoria Financial)
alter table ifood_app drop constraint if exists ifood_app_singleton;
alter table ifood_app add constraint ifood_app_ids check (id in (1, 2));
comment on table ifood_app is 'Credenciais dos apps centralizados do iFood: id=1 pedidos/cardápio, id=2 financeiro (módulo Financial).';
