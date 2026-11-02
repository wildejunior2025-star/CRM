-- Quando a entrega é do iFood, eles avisam no mesmo canal dos pedidos em que pé
-- está o motoqueiro: designado, a caminho da loja, chegou, coletou. A gente já
-- recebia esses eventos (é deles que sai o código de coleta), mas só usava pra
-- buscar o código e jogava a etapa fora. Agora guarda, pra cozinha saber se já
-- tem motoqueiro vindo e o balcão saber que ele está na porta.
--
-- `ifood_entregador_evento` guarda o nome cru do evento do iFood: é o que
-- permite conferir depois se apareceu um código novo que a gente não conhece.
alter table pedidos_delivery
  add column if not exists ifood_entregador_etapa   text,
  add column if not exists ifood_entregador_em      timestamptz,
  add column if not exists ifood_entregador_nome    text,
  add column if not exists ifood_entregador_evento  text;

comment on column pedidos_delivery.ifood_entregador_etapa is
  'Etapa do entregador do iFood: designado, indo_loja, na_loja, coletou, indo_cliente, no_cliente, sem_motoqueiro.';
comment on column pedidos_delivery.ifood_entregador_em is 'Quando essa etapa foi informada pelo iFood.';
comment on column pedidos_delivery.ifood_entregador_nome is 'Nome do entregador, quando o iFood manda no evento.';
comment on column pedidos_delivery.ifood_entregador_evento is 'fullCode original do evento do iFood (pra conferir nomes novos).';
