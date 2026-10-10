-- DESPERDÍCIO TIRA DO ESTOQUE (10/10/2026)
--
-- O estoque das lojas morreu: entrada de compra foi lançada 46 vezes na vida e
-- parou em 25/08; ajuste de inventário, 7 vezes, parou em 27/07. A saída de
-- venda (2.471 movimentos) é a única que vive, porque é automática.
--
-- O desenho novo (decisão do usuário, 10/10): no gestor só se dá ENTRADA. A
-- saída sai sozinha na venda. E o que saiu sem vender — derreteu, caiu, o
-- motoboy estragou, venceu — é DESPERDÍCIO, e já existe lugar pra isso:
-- Financeiro → custos imprevistos, que é onde vira custo do dia.
--
-- Só que lá só dava pra escrever um texto e um valor. O estoque continuava
-- dizendo que o picolé estava no freezer. Agora a MESMA linha escolhe o
-- produto e a quantidade, e tira do estoque — um lançamento, as duas pontas.
--
-- POR QUE NÃO CONTA O CUSTO EM DOBRO: o custo de revenda do dia soma só os
-- movimentos com motivo 'venda' (ver DespesasLucro). A saída de desperdício
-- entra com motivo 'imprevisto', então ela NÃO entra por ali — quem cobra o
-- prejuízo é o `valor` do imprevisto, uma vez só.
alter table public.custos_imprevistos
  add column if not exists produto_id  uuid references public.produtos(id) on delete set null,
  add column if not exists quantidade  numeric,
  add column if not exists estoque_movimento_id uuid;

comment on column public.custos_imprevistos.produto_id is
  'Produto que se perdeu; nulo quando o imprevisto é só custo (mig 0318)';
comment on column public.custos_imprevistos.quantidade is
  'Quanto se perdeu, na unidade do produto (mig 0318)';
comment on column public.custos_imprevistos.estoque_movimento_id is
  'A saída de estoque que este lançamento gerou — é por ela que o estorno acha o que devolver (mig 0318)';

-- ── Registrar ───────────────────────────────────────────────────────────────
-- Grava o custo e, se veio produto, a saída do estoque. As duas coisas na
-- mesma função pra não existir o caso "tirou do estoque e não virou custo".
create or replace function public.imprevisto_registrar(
  p_descricao  text,
  p_valor      numeric,
  p_data       date    default null,
  p_produto_id uuid    default null,
  p_quantidade numeric default null
) returns uuid
language plpgsql
as $$
declare
  v_emp uuid := current_empresa_id();
  v_mov uuid;
  v_id  uuid;
begin
  if coalesce(btrim(p_descricao), '') = '' then
    raise exception 'Descreva o que aconteceu.';
  end if;
  if p_produto_id is not null and coalesce(p_quantidade, 0) <= 0 then
    raise exception 'Diga quantos se perderam.';
  end if;

  if p_produto_id is not null then
    -- Loja com estoque desligado: o trigger da mig 0126 engole a linha e o
    -- RETURNING volta vazio. O custo continua sendo lançado do mesmo jeito.
    insert into public.estoque_movimentos (empresa_id, produto_id, tipo, quantidade, motivo, observacao)
    values (v_emp, p_produto_id, 'saida', p_quantidade, 'imprevisto', left(btrim(p_descricao), 200))
    returning id into v_mov;
  end if;

  insert into public.custos_imprevistos
    (empresa_id, data, descricao, valor, produto_id, quantidade, estoque_movimento_id)
  values
    (v_emp, coalesce(p_data, current_date), btrim(p_descricao), coalesce(p_valor, 0),
     p_produto_id, p_quantidade, v_mov)
  returning id into v_id;

  return v_id;
end $$;

-- ── Excluir ─────────────────────────────────────────────────────────────────
-- Apagar um lançamento errado tem que DEVOLVER o que saiu. Sem isso o furo
-- ficaria no estoque pra sempre e sem rastro nenhum de onde veio.
--
-- De propósito NÃO é trigger de DELETE: o fechamento do dia apaga a lista de
-- imprevistos depois de guardar o snapshot, e um trigger devolveria todo o
-- estoque perdido do dia de uma vez. O estorno é só por este caminho.
create or replace function public.imprevisto_excluir(p_id uuid)
returns void
language plpgsql
as $$
declare r record;
begin
  select * into r from public.custos_imprevistos where id = p_id;
  if not found then return; end if;

  if r.estoque_movimento_id is not null then
    insert into public.estoque_movimentos (empresa_id, produto_id, tipo, quantidade, motivo, observacao)
    values (r.empresa_id, r.produto_id, 'entrada', r.quantidade, 'estorno_imprevisto',
            'Estorno de desperdício: ' || left(coalesce(r.descricao, ''), 180));
  end if;

  delete from public.custos_imprevistos where id = p_id;
end $$;

grant execute on function public.imprevisto_registrar(text, numeric, date, uuid, numeric) to authenticated;
grant execute on function public.imprevisto_excluir(uuid) to authenticated;
