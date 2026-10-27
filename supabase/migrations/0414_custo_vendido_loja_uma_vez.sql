-- custo_vendido_periodo: descobre a loja UMA vez por consulta.
--
-- 27/10, almoço: dois "Sistema no limite" (316/seg às 12:00, 339/seg às 13:10).
-- Nas duas janelas estava a conferencia_mes (mig 0410), ~5 s por chamada, que
-- chama esta função duas vezes. O empresa_consultada(p_empresa_id) ficava solto
-- no WHERE de do_salao e do_delivery: rodava uma vez por LINHA de venda/pedido
-- examinada, e cada rodada lê profiles duas vezes (current_perfil +
-- current_empresa_id). Mesmo tipo de erro do travamento de 23/09.
--
-- Agora a loja sai do CTE emp, resolvida com (select ...) -> InitPlan, uma vez.
-- Mesma regra, mesmo resultado. Vale também pro DespesasLucro e pra Cozinha,
-- que chamam a mesma função.
--
-- SECURITY DEFINER escrito de novo de propósito: CREATE OR REPLACE sem ele
-- derruba o definer (ver reference_create_or_replace_apaga_definer).

create or replace function public.custo_vendido_periodo(p_ini timestamp with time zone, p_fim timestamp with time zone, p_empresa_id uuid default null::uuid)
 returns table(produto_id uuid, nome text, modo text, pct numeric, custo_unit numeric, qtd numeric, valor_vendido numeric, custo numeric)
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  with emp as (
    select e.id, coalesce(e.estoque_ativo, true) as estoque_ativo
    from empresas e where e.id = (select empresa_consultada(p_empresa_id))
  ),
  alvo as (
    select p.id, p.nome,
           case when p.custo_pct_venda is not null and p.custo_pct_venda > 0
                then 'pct' else 'unidade' end as modo,
           p.custo_pct_venda as pct,
           p.preco_custo as custo_unit,
           lower(unaccent(btrim(p.nome))) as nome_key   -- casa com o nome que o iFood manda
    from produtos p, emp
    where p.empresa_id = emp.id
      and (
        -- comida no peso: custo é % do que vendeu
        (p.custo_pct_venda is not null and p.custo_pct_venda > 0)
        -- ou custo fixo em R$ que o estoque nunca desconta
        or (p.preco_custo > 0
            and p.custo_pct_venda is null
            and (coalesce(p.controla_estoque, true) = false or emp.estoque_ativo = false))
      )
  ),
  do_salao as (
    select vi.produto_id as id, sum(vi.subtotal) as valor, sum(vi.quantidade) as qtd
    from venda_itens vi
    join vendas v on v.id = vi.venda_id
    where vi.empresa_id = (select id from emp)
      and v.status <> 'cancelado'
      and v.created_at >= p_ini and v.created_at < p_fim
      and vi.produto_id in (select id from alvo)
    group by 1
  ),
  do_delivery as (
    select a.id,
           sum(coalesce((it->>'subtotal')::numeric,
                        coalesce((it->>'preco_unitario')::numeric, 0)
                        * coalesce((it->>'quantidade')::numeric, (it->>'qtd')::numeric, 1))) as valor,
           sum(coalesce((it->>'quantidade')::numeric, (it->>'qtd')::numeric, 1)) as qtd
    from pedidos_delivery pd
    cross join lateral jsonb_array_elements(pd.itens) it
    join alvo a on a.id::text = nullif(it->>'produto_id', '')
                or (nullif(it->>'produto_id', '') is null
                    and a.nome_key = lower(unaccent(btrim(coalesce(it->>'nome', '')))))
    where pd.empresa_id = (select id from emp)
      and pd.status <> 'cancelado'
      and jsonb_typeof(pd.itens) = 'array'
      and pd.created_at >= p_ini and pd.created_at < p_fim
    group by 1
  ),
  junto as (
    select a.id, a.nome, a.modo, a.pct, a.custo_unit,
           coalesce(s.qtd, 0) + coalesce(d.qtd, 0)     as qtd,
           coalesce(s.valor, 0) + coalesce(d.valor, 0) as valor
    from alvo a
    left join do_salao s on s.id = a.id
    left join do_delivery d on d.id = a.id
  )
  select id, nome, modo, pct, custo_unit,
         round(qtd, 3) as qtd,
         round(valor, 2) as valor_vendido,
         round(case when modo = 'pct' then valor * pct / 100.0
                    else qtd * custo_unit end, 2) as custo
  from junto
  where qtd > 0 or valor > 0
  order by 8 desc;
$function$;
