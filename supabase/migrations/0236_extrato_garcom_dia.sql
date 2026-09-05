-- =========================================================
-- Migration 0236 — O garçom vê o que fez DIA A DIA
-- =========================================================
-- A mig 0230 fez o acumulado: uma linha só, "R$ 87,40 · 143 pontos · 6 dias".
-- Serve pro dono pagar, mas não serve pro garçom conferir. Na Saidera o
-- combinado virou pagar por semana, e aí a pergunta é outra: "quanto eu fiz
-- na segunda? e na sexta?". Com um número só, ele recebe e acredita.
--
-- Esta função abre o acumulado por dia. É a MESMA conta da 0230 — cada dia com
-- o bolo dele e o valor do ponto dele —, só que sem somar tudo no fim. Se
-- alguém somar as linhas daqui, tem que dar exatamente o acumulado de lá.
--
-- Quem pode ver o quê: o garçom vê o dele e só o dele. O ADM escolhe de quem
-- quer ver — é ele quem paga, e paga olhando o extrato.
-- =========================================================

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
begin
  if v_emp is null then return; end if;
  -- Garçom não escolhe de quem vê: é sempre ele. ADM escolhe, e sem escolher
  -- vê o dele (ADM não divide o bolo, então costuma vir vazio).
  v_alvo := case when v_adm then coalesce(p_garcom, v_eu) else v_eu end;

  select coalesce(pontos_garcom, '{}'::jsonb), coalesce(rateio_taxa_pct, 0)
    into v_cfg, v_rateio
    from empresas where id = v_emp;

  v_lancar   := coalesce((v_cfg->>'lancar')::int, 1);
  v_entregar := coalesce((v_cfg->>'entregar')::int, 1);
  v_fechar   := coalesce((v_cfg->>'fechar')::int, 2);

  -- De onde começa a contar: o dia seguinte ao último acerto dele.
  select coalesce(max(a.ate_dia), date '1900-01-01') into v_desde
    from garcom_acertos a
   where a.empresa_id = v_emp and a.garcom_id = v_alvo;

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
           ci.quantidade * v_lancar as pts
      from comanda_itens ci
     where ci.empresa_id = v_emp and ci.lancado_por is not null
    union all
    select ci.entregue_por,
           (ci.entregue_at at time zone 'America/Fortaleza')::date,
           ci.quantidade * v_entregar
      from comanda_itens ci
     where ci.empresa_id = v_emp and ci.entregue_por is not null
       and ci.status = 'entregue' and ci.entregue_at is not null
    union all
    select c.fechada_por,
           (c.fechada_por_em at time zone 'America/Fortaleza')::date,
           v_fechar
      from comandas c
     where c.empresa_id = v_emp and c.fechada_por is not null and c.fechada_por_em is not null
  ),
  meus_dias as (
    select g.dia, sum(g.pts)::bigint as pts
      from gestos g
     where g.id = v_alvo and g.dia > v_desde and g.dia <= v_hoje
     group by g.dia
  ),
  bolo_dia as (
    select (c.fechada_at at time zone 'America/Fortaleza')::date as dia,
           sum(coalesce(c.taxa_servico, 0)) * v_rateio / 100 as bolo
      from comandas c
     where c.empresa_id = v_emp and c.status = 'fechada' and c.fechada_at is not null
     group by 1
  ),
  -- O divisor é a equipe INTEIRA daquele dia, paga ou não: o ponto vale menos
  -- no dia em que todo mundo trabalhou muito, e isso não muda porque um colega
  -- já recebeu.
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

comment on function extrato_garcom(uuid) is
  'Dia a dia do que o garçom tem a receber desde o último acerto. Somando as linhas dá o acumulado_garcons().';

-- ─────────────────────────────────────────────────────────────────────────
-- E o acumulado passa a arredondar POR DIA, não no fim.
--
-- Agora que o garçom vê as linhas, ele vai somar — e o total tinha que bater
-- na moeda. Arredondando só no fim, três dias de R$ 10,175 davam um total
-- diferente da soma do que está escrito em cada linha. Um centavo de diferença
-- num acerto é discussão no balcão, e a razão está com quem somou à mão.
-- ─────────────────────────────────────────────────────────────────────────
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
           coalesce((select max(a.ate_dia) from garcom_acertos a
                      where a.empresa_id = v_emp and a.garcom_id = e.id), date '1900-01-01') as ate
      from equipe e
  ),
  gestos as (
    select ci.lancado_por as id,
           (ci.created_at at time zone 'America/Fortaleza')::date as dia,
           ci.quantidade * v_lancar as pts
      from comanda_itens ci
     where ci.empresa_id = v_emp and ci.lancado_por is not null
    union all
    select ci.entregue_por,
           (ci.entregue_at at time zone 'America/Fortaleza')::date,
           ci.quantidade * v_entregar
      from comanda_itens ci
     where ci.empresa_id = v_emp and ci.entregue_por is not null
       and ci.status = 'entregue' and ci.entregue_at is not null
    union all
    select c.fechada_por,
           (c.fechada_por_em at time zone 'America/Fortaleza')::date,
           v_fechar
      from comandas c
     where c.empresa_id = v_emp and c.fechada_por is not null and c.fechada_por_em is not null
  ),
  pontos_dia as (
    select g.id, g.dia, sum(g.pts)::bigint as pts
      from gestos g
      join corte ct on ct.id = g.id
     where g.dia > ct.ate and g.dia <= v_hoje
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
