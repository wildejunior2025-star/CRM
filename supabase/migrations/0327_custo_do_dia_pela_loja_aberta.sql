-- 0327_custo_do_dia_pela_loja_aberta.sql
-- O Lucro do dia mostrava custo ZERO quando o super admin abria uma loja.
--
-- As três contas de custo da tela (custo_vendido_periodo,
-- custo_complementos_periodo, fidelidade_custo_dia) descobriam a loja por
-- current_empresa_id(), que lê profiles.empresa_id do usuário logado. O super
-- admin não tem loja no perfil (empresa_id nulo): ao abrir o Zebu pelo
-- "Trocar de loja", a tela somava a venda certa e o custo de loja nenhuma
-- (16/10/2026, Zebu: custo R$ 0,00 onde eram R$ 125,18).
--
-- Agora a tela manda qual loja está aberta (p_empresa_id). Só o super admin
-- pode pedir outra loja; para o lojista o parâmetro é ignorado e vale a loja
-- dele, como sempre: ninguém lê custo de loja alheia por aqui.

CREATE OR REPLACE FUNCTION public.empresa_consultada(p_empresa_id uuid)
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select case when p_empresa_id is not null and current_perfil() = 'super_admin'
              then p_empresa_id
              else current_empresa_id() end;
$function$;
REVOKE ALL ON FUNCTION public.empresa_consultada(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.empresa_consultada(uuid) TO authenticated;

-- Assinatura nova (parâmetro a mais): as antigas saem, senão a chamada com dois
-- argumentos fica ambígua entre as duas versões.
DROP FUNCTION IF EXISTS public.custo_vendido_periodo(timestamptz, timestamptz);
DROP FUNCTION IF EXISTS public.custo_complementos_periodo(timestamptz, timestamptz);
DROP FUNCTION IF EXISTS public.fidelidade_custo_dia(date);

CREATE OR REPLACE FUNCTION public.custo_vendido_periodo(
  p_ini timestamptz, p_fim timestamptz, p_empresa_id uuid DEFAULT NULL)
 RETURNS TABLE (produto_id uuid, nome text, modo text, pct numeric,
                custo_unit numeric, qtd numeric, valor_vendido numeric, custo numeric)
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with emp as (
    select e.id, coalesce(e.estoque_ativo, true) as estoque_ativo
    from empresas e where e.id = empresa_consultada(p_empresa_id)
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
    where vi.empresa_id = empresa_consultada(p_empresa_id)
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
    where pd.empresa_id = empresa_consultada(p_empresa_id)
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

CREATE OR REPLACE FUNCTION public.custo_complementos_periodo(
  p_ini timestamptz, p_fim timestamptz, p_empresa_id uuid DEFAULT NULL)
RETURNS TABLE(opcao_id uuid, nome text, grupo text, custo_unit numeric, qtd numeric, custo numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  with escolhas as (
    -- Salão, mesa e link do cliente: a venda guarda a montagem.
    select (c->>'opcaoId')::uuid as opcao_id,
           coalesce(nullif(c->>'qtd','')::numeric, 1)
             * case when coalesce((c->>'absoluto')::boolean, false)
                    then 1 else coalesce(vi.quantidade, 1) end as qtd
    from venda_itens vi
    join vendas v on v.id = vi.venda_id
    cross join lateral jsonb_array_elements(
      case when jsonb_typeof(vi.complementos) = 'array' then vi.complementos else '[]'::jsonb end) c
    where vi.empresa_id = empresa_consultada(p_empresa_id)
      and v.status <> 'cancelado'
      and v.created_at >= p_ini and v.created_at < p_fim
      and c->>'opcaoId' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'

    union all

    -- Delivery e loja online: o pedido já guardava estruturado.
    select (c->>'opcaoId')::uuid,
           coalesce(nullif(c->>'qtd','')::numeric, 1)
             * case when coalesce((c->>'absoluto')::boolean, false) then 1
                    else coalesce(nullif(it->>'quantidade','')::numeric,
                                  nullif(it->>'qtd','')::numeric, 1) end
    from pedidos_delivery pd
    cross join lateral jsonb_array_elements(
      case when jsonb_typeof(pd.itens) = 'array' then pd.itens else '[]'::jsonb end) it
    cross join lateral jsonb_array_elements(
      case when jsonb_typeof(it->'complementos') = 'array' then it->'complementos' else '[]'::jsonb end) c
    where pd.empresa_id = empresa_consultada(p_empresa_id)
      and pd.status <> 'cancelado'
      and pd.created_at >= p_ini and pd.created_at < p_fim
      and c->>'opcaoId' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
  )
  select o.id, o.nome, g.nome, o.preco_custo,
         round(sum(e.qtd), 3) as qtd,
         round(sum(e.qtd) * o.preco_custo, 2) as custo
  from escolhas e
  join complemento_opcoes o on o.id = e.opcao_id
  join complemento_grupos g on g.id = o.grupo_id
  where g.empresa_id = empresa_consultada(p_empresa_id)
    and coalesce(o.preco_custo, 0) > 0
  group by o.id, o.nome, g.nome, o.preco_custo
  order by 6 desc;
$function$;

CREATE OR REPLACE FUNCTION public.fidelidade_custo_dia(p_data date, p_empresa_id uuid DEFAULT NULL)
 RETURNS numeric
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT COALESCE(SUM(
           CASE WHEN tipo = 'debito' THEN valor ELSE -valor END
         ), 0)::numeric
  FROM creditos_movimentos
  WHERE empresa_id = empresa_consultada(p_empresa_id)
    AND tipo IN ('debito', 'estorno')
    AND (created_at AT TIME ZONE 'America/Sao_Paulo')::date = p_data;
$function$;

REVOKE ALL ON FUNCTION public.custo_vendido_periodo(timestamptz, timestamptz, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.custo_vendido_periodo(timestamptz, timestamptz, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.custo_complementos_periodo(timestamptz, timestamptz, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fidelidade_custo_dia(date, uuid) TO authenticated;

NOTIFY pgrst, 'reload schema';
