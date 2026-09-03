-- =========================================================
-- Migration 0230 — O que o garçom tem a receber ACUMULA até o dono pagar
-- =========================================================
-- Até aqui o rateio da taxa (mig 0187) era do DIA: à meia-noite zerava e o
-- número da véspera não existia mais em lugar nenhum. Servia pra mostrar ao
-- garçom quanto ele fez hoje, mas não pra pagar — o dono não paga toda noite,
-- e nem sempre paga na mesma data.
--
-- Pedido do Wilde (02/09/2026, Saidera): "deixa acumular até o dono pagar;
-- enquanto não pagar fica acumulando, aí não zera".
--
-- Como funciona:
--   • cada DIA continua tendo o seu bolo (taxa arrecadada × rateio %) e o seu
--     valor por ponto. Somar pontos de dias diferentes num bolo só seria
--     errado: o dia fraco pagaria o ponto do dia forte.
--   • o acumulado do garçom é a SOMA dos ganhos diários dele desde o último
--     acerto. Um acerto por garçom — a Michelle pode receber hoje e o Romario
--     na semana que vem, cada um com o seu ponto de partida.
--   • ADM não divide (decisão do Wilde): na Saidera é a conta da loja que fecha
--     quase toda conta, e ela ficaria com a maior fatia do que é dos garçons.
-- =========================================================

create table if not exists garcom_acertos (
  id          uuid primary key default gen_random_uuid(),
  empresa_id  uuid not null references empresas(id) on delete cascade,
  garcom_id   uuid not null references profiles(id) on delete cascade,
  -- Cobre tudo ATÉ este dia, inclusive. O acumulado seguinte começa no dia
  -- seguinte a ele.
  ate_dia     date not null,
  valor       numeric(10,2) not null,
  pontos      integer not null default 0,
  observacao  text,
  pago_em     timestamptz not null default now(),
  pago_por    uuid references profiles(id)
);

comment on table garcom_acertos is
  'Cada vez que o dono paga a parte do garçom na taxa de serviço. O acumulado seguinte começa no dia seguinte a `ate_dia`.';

create index if not exists idx_garcom_acertos_emp on garcom_acertos (empresa_id, garcom_id, ate_dia desc);

alter table garcom_acertos enable row level security;

-- O garçom vê os acertos DELE (é o extrato do que já recebeu); o ADM vê os da
-- loja inteira. Só ADM registra pagamento — é dinheiro saindo.
drop policy if exists "Ve os acertos da loja" on garcom_acertos;
create policy "Ve os acertos da loja"
  on garcom_acertos for select to authenticated
  using (
    empresa_id = current_empresa_id()
    and (garcom_id = auth.uid() or current_perfil() in ('admin', 'super_admin'))
  );

drop policy if exists "ADM registra o pagamento" on garcom_acertos;
create policy "ADM registra o pagamento"
  on garcom_acertos for insert to authenticated
  with check (empresa_id = current_empresa_id() and current_perfil() in ('admin', 'super_admin'));

drop policy if exists "ADM desfaz o pagamento" on garcom_acertos;
create policy "ADM desfaz o pagamento"
  on garcom_acertos for delete to authenticated
  using (empresa_id = current_empresa_id() and current_perfil() in ('admin', 'super_admin'));

-- ─────────────────────────────────────────────────────────────────────────
-- Quanto cada garçom tem a receber HOJE, somando dia a dia desde o acerto.
--
-- O dia é o de Fortaleza, não o do relógio do aparelho: a tela do celular do
-- garçom e a do PC do caixa têm que mostrar o mesmo número.
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
  with equipe as (   -- quem divide: todo mundo menos ADM
    select p.id, p.nome
      from profiles p
     where p.empresa_id = v_emp
       and coalesce(p.perfil, '') not in ('admin', 'super_admin')
  ),
  corte as (         -- de que dia em diante conta, por garçom
    select e.id,
           coalesce((select max(a.ate_dia) from garcom_acertos a
                      where a.empresa_id = v_emp and a.garcom_id = e.id), date '1900-01-01') as ate
      from equipe e
  ),
  -- Os três gestos, cada um no seu dia. Quantidade, não linha: lançar "6
  -- espetinhos" vale 6 pontos, que é como o ranking sempre contou.
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
  -- Só o que ainda não foi pago, e só de quem divide.
  pontos_dia as (
    select g.id, g.dia, sum(g.pts)::bigint as pts
      from gestos g
      join corte ct on ct.id = g.id
     where g.dia > ct.ate and g.dia <= v_hoje
     group by g.id, g.dia
  ),
  -- O bolo de cada dia: a taxa que a LOJA arrecadou naquele dia.
  bolo_dia as (
    select (c.fechada_at at time zone 'America/Fortaleza')::date as dia,
           sum(coalesce(c.taxa_servico, 0)) * v_rateio / 100 as bolo
      from comandas c
     where c.empresa_id = v_emp and c.status = 'fechada' and c.fechada_at is not null
     group by 1
  ),
  -- Divisor do dia: os pontos de TODA a equipe naquele dia, pagos ou não. O
  -- ponto vale menos no dia em que todo mundo trabalhou muito — e isso não pode
  -- mudar só porque um colega já recebeu a parte dele.
  total_dia as (
    select g.dia, sum(g.pts)::numeric as pts
      from gestos g
      join equipe e on e.id = g.id
     group by g.dia
  )
  select pd.id,
         eq.nome,
         min(pd.dia)                                    as desde,
         count(*)::int                                  as dias,
         sum(pd.pts)::bigint                            as pontos,
         round(sum(pd.pts / td.pts * coalesce(bd.bolo, 0)), 2) as valor
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
