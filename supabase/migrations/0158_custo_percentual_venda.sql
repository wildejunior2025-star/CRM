-- 0158_custo_percentual_venda.sql
-- Custo em % do valor vendido — pro prato que não tem preço fixo.
--
-- O caso real (Estação do Sabor, 11/08/2026): "Almoço no Peso" é vendido na
-- balança — a atendente digita o valor na mesa, cada prato sai por um preço. Não
-- existe preço de venda nem preço de custo fixo pra ele, então ele entrava no
-- Lucro do dia com custo ZERO: já são R$ 3.557,50 vendidos sem um centavo de
-- custo, e o lucro aparecia inflado.
--
-- Ficha técnica não resolve: não dá pra pesar quanto de arroz, feijão e carne foi
-- em cada prato. O jeito que a cozinha usa é estimativa — "o custo é uns 40% do
-- que o cliente paga". Agora o produto pode ser cadastrado assim.
--
--   custo_pct_venda NULL  → como sempre foi (preco_custo em R$ por unidade)
--   custo_pct_venda 40    → o custo do dia é 40% do que aquele item vendeu
--
-- Onde entra: no Lucro do dia, junto do custo de produção. A RPC abaixo soma o
-- que o item vendeu no período em DUAS fontes (o mesmo prato pode sair na mesa e
-- no delivery) e devolve já com a conta feita.

ALTER TABLE public.produtos
  ADD COLUMN IF NOT EXISTS custo_pct_venda numeric;

ALTER TABLE public.produtos
  DROP CONSTRAINT IF EXISTS produtos_custo_pct_venda_ck;
ALTER TABLE public.produtos
  ADD CONSTRAINT produtos_custo_pct_venda_ck
  CHECK (custo_pct_venda IS NULL OR (custo_pct_venda >= 0 AND custo_pct_venda <= 100));

COMMENT ON COLUMN public.produtos.custo_pct_venda IS
  'Custo estimado como % do valor vendido (ex.: 40 = 40%). Para item sem preço fixo (comida no peso). NULL = usa preco_custo em R$.';

-- Quanto cada produto de custo-por-% vendeu no período, e o custo que isso dá.
-- Duas fontes, porque o mesmo prato sai por caminhos diferentes:
--   1. venda_itens  — mesa, comanda e balcão do salão (é onde o peso é digitado)
--   2. pedidos_delivery.itens (jsonb) — cardápio, WhatsApp, iFood
-- No delivery o item casa por produto_id e, quando ele não vem (iFood manda só o
-- nome), pelo NOME exato do catálogo sem acento/maiúscula — a mesma regra que o
-- estoque do delivery já usa (migration 0155). Não casou, não inventa custo.
CREATE OR REPLACE FUNCTION public.custo_percentual_periodo(
  p_ini timestamptz, p_fim timestamptz)
 RETURNS TABLE (produto_id uuid, nome text, pct numeric, valor_vendido numeric, custo numeric)
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with alvo as (
    select p.id, p.nome, p.custo_pct_venda as pct,
           lower(unaccent(btrim(p.nome))) as nome_key   -- casa com o nome que o iFood manda
    from produtos p
    where p.empresa_id = current_empresa_id()
      and p.custo_pct_venda is not null
      and p.custo_pct_venda > 0
  ),
  do_salao as (
    select vi.produto_id as id, sum(vi.subtotal) as valor
    from venda_itens vi
    join vendas v on v.id = vi.venda_id
    where vi.empresa_id = current_empresa_id()
      and v.status <> 'cancelado'
      and v.created_at >= p_ini and v.created_at < p_fim
      and vi.produto_id in (select id from alvo)
    group by 1
  ),
  do_delivery as (
    select a.id, sum(coalesce((it->>'subtotal')::numeric,
                              coalesce((it->>'preco_unitario')::numeric, 0)
                              * coalesce((it->>'quantidade')::numeric, (it->>'qtd')::numeric, 1))) as valor
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
  )
  select a.id, a.nome, a.pct,
         round(coalesce(s.valor, 0) + coalesce(d.valor, 0), 2) as valor_vendido,
         round((coalesce(s.valor, 0) + coalesce(d.valor, 0)) * a.pct / 100.0, 2) as custo
  from alvo a
  left join do_salao s on s.id = a.id
  left join do_delivery d on d.id = a.id
  where coalesce(s.valor, 0) + coalesce(d.valor, 0) > 0
  order by 5 desc;
$function$;

REVOKE ALL ON FUNCTION public.custo_percentual_periodo(timestamptz, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.custo_percentual_periodo(timestamptz, timestamptz) TO authenticated;

NOTIFY pgrst, 'reload schema';
