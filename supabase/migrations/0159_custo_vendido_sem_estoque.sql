-- 0159_custo_vendido_sem_estoque.sql
-- Produto SEM controle de estoque também leva o custo dele pro Lucro do dia.
--
-- O buraco (Wilde, 11/08/2026): o custo do dia vinha do que SAIU do estoque
-- (estoque_movimentos, motivo 'venda') × preco_custo. Só que produto marcado
-- "não controla estoque" nunca gera saída — então o preço de custo dele ficava
-- parado no cadastro sem nunca ser usado. Na Estação são 20 produtos assim
-- (salgado, tapioca, pão com ovo, torrada...); só em 11/08 escaparam R$ 51,28.
-- Pior na loja com o estoque DESLIGADO (empresas.estoque_ativo = false): ali não
-- existe movimento nenhum, então NADA de custo entrava.
--
-- Agora esta RPC devolve as duas formas de custo que o estoque não cobre, e o
-- Lucro do dia soma as duas:
--   modo 'pct'     → prato sem preço fixo (comida no peso): % do valor vendido
--   modo 'unidade' → produto sem baixa de estoque: qtd vendida × preco_custo
--
-- Sem risco de contar duas vezes: 'unidade' só pega produto que NÃO controla
-- estoque (ou loja com estoque desligado) — exatamente o que estoque_movimentos
-- não vê. Quem controla estoque continua entrando pelo caminho de sempre.
--
-- Substitui a custo_percentual_periodo da 0158 (o retorno mudou, então precisa
-- de DROP antes do CREATE).

DROP FUNCTION IF EXISTS public.custo_percentual_periodo(timestamptz, timestamptz);

CREATE OR REPLACE FUNCTION public.custo_vendido_periodo(
  p_ini timestamptz, p_fim timestamptz)
 RETURNS TABLE (produto_id uuid, nome text, modo text, pct numeric,
                custo_unit numeric, qtd numeric, valor_vendido numeric, custo numeric)
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with emp as (
    select e.id, coalesce(e.estoque_ativo, true) as estoque_ativo
    from empresas e where e.id = current_empresa_id()
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
    where vi.empresa_id = current_empresa_id()
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
    where pd.empresa_id = current_empresa_id()
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

REVOKE ALL ON FUNCTION public.custo_vendido_periodo(timestamptz, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.custo_vendido_periodo(timestamptz, timestamptz) TO authenticated;

NOTIFY pgrst, 'reload schema';
