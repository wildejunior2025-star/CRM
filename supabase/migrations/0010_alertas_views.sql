-- =========================================================
-- CRM Depósito de Bebidas - Migration 0010
-- Módulo: Views para alertas / notificações
-- =========================================================

-- Produtos com estoque abaixo ou igual ao mínimo configurado
create or replace view estoque_baixo
with (security_invoker = on)
as
select
  produto_id,
  nome,
  categoria,
  estoque_minimo,
  quantidade_atual,
  (estoque_minimo - quantidade_atual) as falta
from estoque_saldo
where estoque_minimo > 0
  and quantidade_atual <= estoque_minimo;

-- Fiado em aberto com nome do cliente
create or replace view alertas_fiado
with (security_invoker = on)
as
select
  f.cliente_id,
  c.nome as cliente_nome,
  f.saldo_fiado
from clientes_saldo_fiado f
join clientes c on c.id = f.cliente_id
where f.saldo_fiado > 0
order by f.saldo_fiado desc;
