-- =========================================================
-- Migration 0237 — A taxa de serviço da loja, dia a dia
-- =========================================================
-- O card do dono mostrava só HOJE: "taxa arrecadada R$ 25,31 · vai pros
-- garçons R$ 2,53 · fica com a loja R$ 22,78". À meia-noite zerava e a véspera
-- não existia mais em lugar nenhum.
--
-- Isso deixa o dono sem a metade dele da conta: o garçom já vê o acumulado do
-- que tem a receber (mig 0230) e agora abre dia a dia (mig 0236), mas quem
-- paga não tinha onde conferir quanto a loja arrecadou de taxa em cada dia —
-- nem quanto dela saiu da mão dele.
--
-- Só ADM: é o número do caixa da loja, não do garçom.
-- =========================================================

create or replace function taxa_servico_dias(p_dias int default 30)
returns table (
  dia      date,
  contas   integer,
  taxa     numeric,
  garcons  numeric,
  loja     numeric
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_emp    uuid := current_empresa_id();
  v_rateio numeric;
  v_de     date;
begin
  if v_emp is null then return; end if;
  if current_perfil() not in ('admin', 'super_admin') then return; end if;

  select coalesce(rateio_taxa_pct, 0) into v_rateio from empresas where id = v_emp;
  v_de := (now() at time zone 'America/Fortaleza')::date - greatest(coalesce(p_dias, 30), 1);

  return query
  select (c.fechada_at at time zone 'America/Fortaleza')::date as dia,
         count(*)::int                                          as contas,
         round(sum(coalesce(c.taxa_servico, 0)), 2)             as taxa,
         -- O que vira bolo dos garçons naquele dia. Arredondado por dia, igual
         -- ao extrato deles: os dois lados da mesma conta têm que fechar.
         round(sum(coalesce(c.taxa_servico, 0)) * v_rateio / 100, 2) as garcons,
         round(sum(coalesce(c.taxa_servico, 0))
               - round(sum(coalesce(c.taxa_servico, 0)) * v_rateio / 100, 2), 2) as loja
    from comandas c
   where c.empresa_id = v_emp
     and c.status = 'fechada'
     and c.fechada_at is not null
     and (c.fechada_at at time zone 'America/Fortaleza')::date >= v_de
   group by 1
  having sum(coalesce(c.taxa_servico, 0)) > 0
   order by 1 desc;
end;
$$;

revoke all on function taxa_servico_dias(int) from public, anon;
grant execute on function taxa_servico_dias(int) to authenticated;

comment on function taxa_servico_dias(int) is
  'Taxa de serviço arrecadada por dia, quanto virou bolo dos garçons e quanto ficou com a loja. Só ADM.';
