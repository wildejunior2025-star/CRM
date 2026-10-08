-- =========================================================
-- Migration 0308 — O acerto do garçom corta por HORÁRIO no dia do pagamento
-- =========================================================
-- Saidera (08/10/2026): o dono acertou os garçons às 00:27 — depois da meia-noite,
-- com o turno ainda rolando. O acerto grava ate_dia = hoje (08/10) e as funções
-- (0230/0236) só contavam gestos de dia > ate_dia. Resultado: tudo que a Michelle
-- (157 pts) e o Renan (131 pts) fizeram entre 00:27 e 04:00 sumiu — não aparecia
-- no placar, no extrato nem no acumulado, e nunca seria pago.
--
-- Regra nova: quando o acerto foi feito NO MESMO dia que ele cobre (ate_dia = dia
-- do pago_em), os gestos desse dia só estão pagos até o horário do pagamento; o
-- que veio depois continua a receber. Acerto de dia anterior segue valendo o dia
-- inteiro, como antes.
-- =========================================================

create or replace function acumulado_garcons()
returns table (
  garcom_id uuid,
  nome      text,
  desde     date,
  dias      integer,
  pontos    bigint,
  valor     numeric
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_emp    uuid := current_empresa_id();
  v_cfg    jsonb;
  v_rateio numeric;
  v_lancar int; v_entregar int; v_fechar int;
  v_hoje   date := (now() at time zone 'America/Fortaleza')::date;
begin
  if v_emp is null then return; end if;

  select coalesce(pontos_garcom, '{}'::jsonb), coalesce(rateio_taxa_pct, 0)
    into v_cfg, v_rateio
    from empresas where id = v_emp;

  v_lancar   := coalesce((v_cfg->>'lancar')::int, 1);
  v_entregar := coalesce((v_cfg->>'entregar')::int, 1);
  v_fechar   := coalesce((v_cfg->>'fechar')::int, 2);

  return query
  with equipe as (
    select p.id, p.nome
      from profiles p
     where p.empresa_id = v_emp
       and coalesce(p.perfil, '') not in ('admin', 'super_admin')
  ),
  corte as (
    select e.id,
           coalesce(u.ate_dia, date '1900-01-01') as ate,
           -- Só vale como corte por horário se o acerto foi feito no próprio dia.
           case when u.pago_em is not null
                 and (u.pago_em at time zone 'America/Fortaleza')::date = u.ate_dia
                then u.pago_em end as pago_em
      from equipe e
      left join lateral (
        select a.ate_dia, a.pago_em from garcom_acertos a
         where a.empresa_id = v_emp and a.garcom_id = e.id
         order by a.ate_dia desc, a.pago_em desc limit 1
      ) u on true
  ),
  gestos as (
    select ci.lancado_por as id,
           (ci.created_at at time zone 'America/Fortaleza')::date as dia,
           ci.created_at as ts,
           ci.quantidade * v_lancar as pts
      from comanda_itens ci
     where ci.empresa_id = v_emp and ci.lancado_por is not null
    union all
    select ci.entregue_por,
           (ci.entregue_at at time zone 'America/Fortaleza')::date,
           ci.entregue_at,
           ci.quantidade * v_entregar
      from comanda_itens ci
     where ci.empresa_id = v_emp and ci.entregue_por is not null
       and ci.status = 'entregue' and ci.entregue_at is not null
    union all
    select c.fechada_por,
           (c.fechada_por_em at time zone 'America/Fortaleza')::date,
           c.fechada_por_em,
           v_fechar
      from comandas c
     where c.empresa_id = v_emp and c.fechada_por is not null and c.fechada_por_em is not null
  ),
  pontos_dia as (
    select g.id, g.dia, sum(g.pts)::bigint as pts
      from gestos g
      join corte ct on ct.id = g.id
     where (g.dia > ct.ate or (g.dia = ct.ate and ct.pago_em is not null and g.ts > ct.pago_em))
       and g.dia <= v_hoje
     group by g.id, g.dia
  ),
  bolo_dia as (
    select (c.fechada_at at time zone 'America/Fortaleza')::date as dia,
           sum(coalesce(c.taxa_servico, 0)) * v_rateio / 100 as bolo
      from comandas c
     where c.empresa_id = v_emp and c.status = 'fechada' and c.fechada_at is not null
     group by 1
  ),
  total_dia as (
    select g.dia, sum(g.pts)::numeric as pts
      from gestos g
      join equipe e on e.id = g.id
     group by g.dia
  )
  select pd.id,
         eq.nome,
         min(pd.dia)                                                  as desde,
         count(*)::int                                                as dias,
         sum(pd.pts)::bigint                                          as pontos,
         sum(round(pd.pts / td.pts * coalesce(bd.bolo, 0), 2))        as valor
    from pontos_dia pd
    join equipe eq   on eq.id = pd.id
    join total_dia td on td.dia = pd.dia and td.pts > 0
    left join bolo_dia bd on bd.dia = pd.dia
   group by pd.id, eq.nome
  having sum(pd.pts) > 0
   order by valor desc nulls last;
end;
$$;

revoke all on function acumulado_garcons() from public, anon;
grant execute on function acumulado_garcons() to authenticated;

create or replace function extrato_garcom(p_garcom uuid default null)
returns table (
  dia        date,
  pontos     bigint,
  valor      numeric,
  bolo_dia   numeric,
  pts_equipe numeric
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_emp    uuid := current_empresa_id();
  v_eu     uuid := auth.uid();
  v_adm    boolean := current_perfil() in ('admin', 'super_admin');
  v_alvo   uuid;
  v_cfg    jsonb;
  v_rateio numeric;
  v_lancar int; v_entregar int; v_fechar int;
  v_hoje   date := (now() at time zone 'America/Fortaleza')::date;
  v_desde  date;
  v_pago   timestamptz;
begin
  if v_emp is null then return; end if;
  v_alvo := case when v_adm then coalesce(p_garcom, v_eu) else v_eu end;

  select coalesce(pontos_garcom, '{}'::jsonb), coalesce(rateio_taxa_pct, 0)
    into v_cfg, v_rateio
    from empresas where id = v_emp;

  v_lancar   := coalesce((v_cfg->>'lancar')::int, 1);
  v_entregar := coalesce((v_cfg->>'entregar')::int, 1);
  v_fechar   := coalesce((v_cfg->>'fechar')::int, 2);

  -- Último acerto dele; o horário só corta se foi feito no próprio dia que cobre.
  select a.ate_dia,
         case when (a.pago_em at time zone 'America/Fortaleza')::date = a.ate_dia then a.pago_em end
    into v_desde, v_pago
    from garcom_acertos a
   where a.empresa_id = v_emp and a.garcom_id = v_alvo
   order by a.ate_dia desc, a.pago_em desc limit 1;
  v_desde := coalesce(v_desde, date '1900-01-01');

  return query
  with equipe as (
    select p.id
      from profiles p
     where p.empresa_id = v_emp
       and coalesce(p.perfil, '') not in ('admin', 'super_admin')
  ),
  gestos as (
    select ci.lancado_por as id,
           (ci.created_at at time zone 'America/Fortaleza')::date as dia,
           ci.created_at as ts,
           ci.quantidade * v_lancar as pts
      from comanda_itens ci
     where ci.empresa_id = v_emp and ci.lancado_por is not null
    union all
    select ci.entregue_por,
           (ci.entregue_at at time zone 'America/Fortaleza')::date,
           ci.entregue_at,
           ci.quantidade * v_entregar
      from comanda_itens ci
     where ci.empresa_id = v_emp and ci.entregue_por is not null
       and ci.status = 'entregue' and ci.entregue_at is not null
    union all
    select c.fechada_por,
           (c.fechada_por_em at time zone 'America/Fortaleza')::date,
           c.fechada_por_em,
           v_fechar
      from comandas c
     where c.empresa_id = v_emp and c.fechada_por is not null and c.fechada_por_em is not null
  ),
  meus_dias as (
    select g.dia, sum(g.pts)::bigint as pts
      from gestos g
     where g.id = v_alvo
       and (g.dia > v_desde or (g.dia = v_desde and v_pago is not null and g.ts > v_pago))
       and g.dia <= v_hoje
     group by g.dia
  ),
  bolo_dia as (
    select (c.fechada_at at time zone 'America/Fortaleza')::date as dia,
           sum(coalesce(c.taxa_servico, 0)) * v_rateio / 100 as bolo
      from comandas c
     where c.empresa_id = v_emp and c.status = 'fechada' and c.fechada_at is not null
     group by 1
  ),
  total_dia as (
    select g.dia, sum(g.pts)::numeric as pts
      from gestos g
      join equipe e on e.id = g.id
     group by g.dia
  )
  select md.dia,
         md.pts,
         round(md.pts / td.pts * coalesce(bd.bolo, 0), 2) as valor,
         round(coalesce(bd.bolo, 0), 2)                   as bolo_dia,
         td.pts                                           as pts_equipe
    from meus_dias md
    join total_dia td on td.dia = md.dia and td.pts > 0
    left join bolo_dia bd on bd.dia = md.dia
   order by md.dia desc;
end;
$$;

revoke all on function extrato_garcom(uuid) from public, anon;
grant execute on function extrato_garcom(uuid) to authenticated;
