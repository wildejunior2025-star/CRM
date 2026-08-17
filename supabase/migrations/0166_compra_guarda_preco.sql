-- 0166_compra_guarda_preco.sql
-- Guarda QUANTO FOI PAGO em cada entrada de estoque.
--
-- Antes a entrada gravava só a quantidade ("entraram 20 kg de batata") e o preço
-- vivia num campo só: materias_primas.custo / produtos.preco_custo. Esse campo é
-- SOBRESCRITO na compra seguinte, então o histórico do preço se perdia — não dava
-- pra dizer quanto se gastou no dia 17/08 nem que o queijo subiu de 32 pra 38.
--
-- Agora o preço fica na PRÓPRIA linha do movimento, que ninguém reescreve.
-- Fica nulo nas entradas antigas (não tem como adivinhar o passado) e nas saídas.

alter table public.materia_prima_movimentos
  add column if not exists custo_unit  numeric,   -- preço por unidade de compra (kg, un…)
  add column if not exists valor_total numeric,   -- o que saiu do bolso nessa linha
  add column if not exists created_by  uuid default auth.uid();

alter table public.estoque_movimentos
  add column if not exists custo_unit  numeric,
  add column if not exists valor_total numeric;

-- A tela de histórico filtra por empresa + período.
create index if not exists idx_mp_mov_empresa_data
  on public.materia_prima_movimentos (empresa_id, created_at desc);

create index if not exists idx_estoque_mov_empresa_data
  on public.estoque_movimentos (empresa_id, created_at desc);
