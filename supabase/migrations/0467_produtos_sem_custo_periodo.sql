-- Produtos VENDIDOS no periodo que estao sem preco de custo.
-- custo_vendido_periodo so traz quem ja tem custo, entao o produto sem custo
-- sumia do Financeiro e entrava no lucro como se nao custasse nada.
-- A tela usa esta lista pra mostrar um campo de custo ali mesmo.
create or replace function public.produtos_sem_custo_periodo(
  p_ini timestamptz, p_fim timestamptz, p_empresa_id uuid default null
)
returns table(produto_id uuid, nome text, qtd numeric)
language sql stable security definer
set search_path to 'public'
as $$
  with alvo as (
    select p.id, p.nome, lower(unaccent(btrim(p.nome))) as nome_key
    from produtos p
    where p.empresa_id = (select empresa_consultada(p_empresa_id))
      and coalesce(p.preco_custo, 0) <= 0
      and p.custo_pct_venda is null
      and p.arquivado_em is null
  ),
  vendido as (
    select vi.produto_id as id, vi.quantidade::numeric as qtd
    from venda_itens vi
    join vendas v on v.id = vi.venda_id
    where vi.empresa_id = (select empresa_consultada(p_empresa_id))
      and v.status <> 'cancelado'
      and v.created_at >= p_ini and v.created_at < p_fim
      -- venda nascida de pedido do balcao ja e contada no pedido
      and v.pedido_id is null
    union all
    select a.id,
           coalesce((it->>'quantidade')::numeric, (it->>'qtd')::numeric, 1)
    from pedidos_delivery pd
    cross join lateral jsonb_array_elements(pd.itens) it
    join alvo a on a.id::text = nullif(it->>'produto_id', '')
                or (nullif(it->>'produto_id', '') is null
                    and a.nome_key = lower(unaccent(btrim(coalesce(it->>'nome', '')))))
    where pd.empresa_id = (select empresa_consultada(p_empresa_id))
      and pd.status <> 'cancelado'
      and jsonb_typeof(pd.itens) = 'array'
      and pd.created_at >= p_ini and pd.created_at < p_fim
  )
  select a.id, a.nome, round(sum(v.qtd), 3)
  from alvo a join vendido v on v.id = a.id
  group by a.id, a.nome
  having sum(v.qtd) > 0
  order by 3 desc, 2;
$$;

revoke all on function public.produtos_sem_custo_periodo(timestamptz, timestamptz, uuid) from public, anon;
grant execute on function public.produtos_sem_custo_periodo(timestamptz, timestamptz, uuid) to authenticated, service_role;
