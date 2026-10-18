-- Valor da entrega digitado pelo motoboy (18/10/2026) — TESTE SÓ NO ZEBU.
--
-- O Zebu entrou na promoção "Hits" do iFood: o iFood paga R$ 6,99 de frete PARA A LOJA, e a
-- taxa que o cliente vê (e que o acerto do motoboy usa) fica R$ 0,00. O dono continua devendo
-- ao motoboy o valor de CADA corrida (varia com a distância) e o motoboy anotava no papel.
--
-- Agora ele digita no app ao concluir a entrega, e esse valor passa a ser o que o acerto soma
-- naquela corrida, no lugar de "taxa - desconto". Sem valor digitado, tudo segue como antes.
--
-- Chave por loja (`entregador_digita_valor`, desligada): só o Zebu liga, como teste. Depois
-- o valor sairá da tabela de bairro/rua/km e isto vira automático.

alter table public.empresas
  add column if not exists entregador_digita_valor boolean not null default false;

alter table public.pedidos_delivery
  add column if not exists valor_entregador numeric(10,2)
    check (valor_entregador is null or valor_entregador >= 0);

comment on column public.pedidos_delivery.valor_entregador is
  'Quanto o dono paga ao motoboy por ESTA corrida, digitado por ele (lojas com entregador_digita_valor). Quando existe, vale no lugar de taxa_entrega - desconto no acerto.';

update public.empresas set entregador_digita_valor = true where nome = 'Zebu Restaurante';

-- Quem grava: o motoboy da corrida, ou admin/vendedor da loja (pra corrigir). Nunca depois de
-- paga: o acerto já fechou naquele valor.
create or replace function public.entregador_informar_valor(p_pedido uuid, p_valor numeric)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid    uuid := auth.uid();
  v_ped    record;
  v_perfil text;
  v_emp    uuid;
begin
  if v_uid is null then raise exception 'Não autenticado'; end if;
  if p_valor is null or p_valor < 0 or p_valor > 500 then
    raise exception 'Valor inválido: informe entre R$ 0,00 e R$ 500,00';
  end if;

  select id, empresa_id, entregador_id, coalesce(entregador_pago, false) as pago
    into v_ped from pedidos_delivery where id = p_pedido;
  if not found then raise exception 'Pedido não encontrado'; end if;

  select perfil, empresa_id into v_perfil, v_emp from profiles where id = v_uid;
  if v_emp is distinct from v_ped.empresa_id or v_perfil not in ('entregador', 'admin', 'vendedor') then
    raise exception 'Sem permissão';
  end if;
  if v_perfil = 'entregador' and v_ped.entregador_id is distinct from v_uid then
    raise exception 'Esta entrega não é sua';
  end if;
  if not exists (select 1 from empresas where id = v_ped.empresa_id and entregador_digita_valor) then
    raise exception 'Esta loja não usa valor digitado pelo entregador';
  end if;
  if v_ped.pago then
    raise exception 'Entrega já paga: o valor não pode mais mudar';
  end if;

  update pedidos_delivery set valor_entregador = round(p_valor, 2) where id = p_pedido;
end;
$$;

grant execute on function public.entregador_informar_valor(uuid, numeric) to authenticated;

-- ── Acerto: o valor digitado vale no lugar de "taxa - desconto" ─────────────
create or replace function public.entregadores_acertos(
  p_empresa_id uuid,
  p_desde timestamp with time zone default null,
  p_ate timestamp with time zone default null,
  p_entregador uuid default null
)
returns table(entregador_id uuid, nome text, pago_em timestamp with time zone, corridas bigint, valor numeric, primeira timestamp with time zone, ultima timestamp with time zone)
language sql
stable
set search_path to 'public'
as $function$
  SELECT
    pd.entregador_id,
    pr.nome,
    date_trunc('minute', pd.entregador_pago_em) AS pago_em,
    count(*),
    COALESCE(sum(COALESCE(pd.valor_entregador, GREATEST(0, COALESCE(pd.taxa_entrega, 0) - desconto_entrega(
      pd.origem, pd.taxa_entrega,
      pr.entregador_desconto_ativo,      pr.entregador_desconto_valor,      pr.entregador_desconto_tipo,
      pr.entregador_desconto_loja_ativo, pr.entregador_desconto_loja_valor, pr.entregador_desconto_loja_tipo)))), 0),
    min(pd.created_at),
    max(pd.created_at)
  FROM pedidos_delivery pd
  JOIN profiles pr ON pr.id = pd.entregador_id
  WHERE pd.empresa_id = p_empresa_id
    AND pd.status <> 'cancelado'
    AND COALESCE(pd.entregador_pago, false)
    AND pd.entregador_pago_em IS NOT NULL
    AND (p_entregador IS NULL OR pd.entregador_id = p_entregador)
    AND (p_desde IS NULL OR pd.entregador_pago_em >= p_desde)
    AND (p_ate IS NULL OR pd.entregador_pago_em <= p_ate)
  GROUP BY pd.entregador_id, pr.nome, date_trunc('minute', pd.entregador_pago_em)
  ORDER BY 3 DESC;
$function$;

create or replace function public.entregadores_resumo(
  p_empresa_id uuid,
  p_desde timestamp with time zone default null,
  p_ate timestamp with time zone default null
)
returns table(entregador_id uuid, nome text, ativo boolean, corridas bigint, corridas_pendentes bigint, valor_pendente numeric, valor_pago numeric, repasse_dinheiro numeric, repasse_cartao numeric, repasse_pix numeric, recebido_periodo numeric, em_andamento bigint, valor_em_andamento numeric, ultima_corrida timestamp with time zone)
language sql
stable
set search_path to 'public'
as $function$
  WITH ped AS (
    SELECT
      pd.entregador_id,
      COALESCE(pd.entregador_pago, false) AS pago,
      pd.status = 'entregue' AS concluida,
      COALESCE(pd.valor_entregador, GREATEST(0, COALESCE(pd.taxa_entrega, 0) - desconto_entrega(
        pd.origem, pd.taxa_entrega,
        pr.entregador_desconto_ativo,      pr.entregador_desconto_valor,      pr.entregador_desconto_tipo,
        pr.entregador_desconto_loja_ativo, pr.entregador_desconto_loja_valor, pr.entregador_desconto_loja_tipo))) AS ganho,
      pd.created_at,
      partes.dinheiro, partes.cartao, partes.pix
    FROM pedidos_delivery pd
    JOIN profiles pr ON pr.id = pd.entregador_id
    CROSS JOIN LATERAL (
      SELECT
        COALESCE(sum(v) FILTER (WHERE f = 'dinheiro'), 0) AS dinheiro,
        COALESCE(sum(v) FILTER (WHERE f IN ('cartao', 'cartão', 'credito', 'debito')), 0) AS cartao,
        COALESCE(sum(v) FILTER (WHERE f = 'pix'
          AND pd.pix_status IS DISTINCT FROM 'pago'
          AND pd.mp_payment_status IS DISTINCT FROM 'approved'), 0) AS pix
      FROM (
        SELECT x->>'forma' AS f, (x->>'valor')::numeric AS v
          FROM jsonb_array_elements(pd.pagamentos) x
         WHERE pd.pagamentos IS NOT NULL
        UNION ALL
        SELECT pd.forma_pagamento, COALESCE(pd.total, 0)
         WHERE pd.pagamentos IS NULL
      ) s
    ) partes
    WHERE pd.empresa_id = p_empresa_id
      AND pd.status <> 'cancelado'
      AND pd.entregador_id IS NOT NULL
      AND (p_desde IS NULL OR pd.created_at >= p_desde)
      AND (p_ate IS NULL OR pd.created_at <= p_ate)
  )
  SELECT
    pr.id,
    pr.nome,
    COALESCE(pr.ativo, false),
    count(p.entregador_id),
    count(p.entregador_id) FILTER (WHERE NOT p.pago AND p.concluida),
    COALESCE(sum(p.ganho) FILTER (WHERE NOT p.pago AND p.concluida), 0),
    COALESCE(sum(p.ganho) FILTER (WHERE p.pago), 0),
    COALESCE(sum(p.dinheiro) FILTER (WHERE NOT p.pago AND p.concluida), 0),
    COALESCE(sum(p.cartao) FILTER (WHERE NOT p.pago AND p.concluida), 0),
    COALESCE(sum(p.pix) FILTER (WHERE NOT p.pago AND p.concluida), 0),
    COALESCE(sum(p.dinheiro + p.cartao + p.pix) FILTER (WHERE p.concluida), 0),
    count(p.entregador_id) FILTER (WHERE NOT p.concluida),
    COALESCE(sum(p.ganho) FILTER (WHERE NOT p.concluida), 0),
    max(p.created_at)
  FROM profiles pr
  LEFT JOIN ped p ON p.entregador_id = pr.id
  WHERE pr.empresa_id = p_empresa_id
    AND pr.perfil = 'entregador'
  GROUP BY pr.id, pr.nome, pr.ativo
  HAVING COALESCE(pr.ativo, false) OR count(p.entregador_id) > 0
  ORDER BY 6 DESC, 4 DESC, pr.nome;
$function$;
