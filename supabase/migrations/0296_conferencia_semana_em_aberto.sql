-- A liquidação da semana só fecha na segunda seguinte. Enquanto o iFood não
-- gera título nenhum, comparar com a soma dos lançamentos acusava "diferença"
-- do valor inteiro da semana corrente — susto à toa pro lojista. Sem título,
-- a semana fica "aguardando" (conferido nulo), que a tela já sabe mostrar.
-- Só muda o trecho das semanas de liquidação; o resto da função é o de antes.
create or replace function public.recalcular_repasse_ifood(p_empresa uuid)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_n int;
begin
  with ev as (
    select * from ifood_eventos_financeiros e
     where e.empresa_id = p_empresa
       and e.periodo_ini is not null
       and coalesce(e.bruto->>'status', '') <> 'PENDING'
  ), por_periodo as (
    select
      ev.empresa_id,
      ev.periodo_ini,
      max(ev.periodo_fim)                                             as periodo_fim,
      max(ev.previsao_pagamento)                                      as previsao_pagamento,
      round(sum(ev.valor) filter (where ev.impacta_repasse), 2)       as valor_repasse,
      round(sum(ev.valor) filter (where ev.nome = 'ORDER_PAYMENT'), 2) as vendas,
      round(abs(coalesce(sum(ev.valor) filter (
        where ev.nome ilike '%an%ncio%' or ev.nome ilike '%ADVERTIS%'), 0)), 2) as anuncio,
      round(abs(coalesce(sum(ev.valor) filter (
        where ev.valor < 0
          and ev.nome in ('ORDER_COMMISSION', 'PAYMENT_TRANSACTION_FEE', 'SERVICE_FEE',
                          'DELIVERY_REQUEST', 'DELIVERY_FEE_IFOOD')), 0)), 2) as comissoes,
      round(abs(coalesce(sum(ev.valor) filter (
        where ev.valor < 0 and (ev.nome ilike '%PROMOTION%' or ev.nome ilike 'MERCHANT%SUBSIDY%'
                                or ev.nome ilike 'STORE%SUBSIDY%')), 0)), 2) as promocoes,
      round(coalesce(sum(ev.valor) filter (
        where ev.nome = 'ORDER_PAYMENT' and not ev.impacta_repasse), 0), 2) as recebido_direto
    from ev
    group by ev.empresa_id, ev.periodo_ini
  )
  insert into ifood_repasse_semanal as r (
    empresa_id, periodo_ini, periodo_fim, previsao_pagamento, situacao,
    vendas, anuncio, valor_repasse, comissoes, promocoes, recebido_direto,
    importado_em, fonte
  )
  select
    p.empresa_id, p.periodo_ini, p.periodo_fim, p.previsao_pagamento,
    case when p.previsao_pagamento is not null
          and p.previsao_pagamento <= (now() at time zone 'America/Fortaleza')::date
         then 'pago' else 'em aberto' end,
    coalesce(p.vendas, 0), p.anuncio, coalesce(p.valor_repasse, 0),
    p.comissoes, p.promocoes, p.recebido_direto,
    now(), 'api'
  from por_periodo p
  on conflict (empresa_id, periodo_ini) do update set
    periodo_fim        = excluded.periodo_fim,
    previsao_pagamento = excluded.previsao_pagamento,
    situacao           = excluded.situacao,
    vendas             = excluded.vendas,
    anuncio            = excluded.anuncio,
    valor_repasse      = excluded.valor_repasse,
    comissoes          = excluded.comissoes,
    promocoes          = excluded.promocoes,
    recebido_direto    = excluded.recebido_direto,
    importado_em       = excluded.importado_em,
    fonte              = 'api'
  where r.fonte = 'api';
  get diagnostics v_n = row_count;

  update ifood_vendas v
     set soma_lancamentos = s.soma,
         conferido = abs(coalesce(v.saldo, 0) - s.soma) <= greatest(0.01, abs(coalesce(v.saldo, 0)) * 0.0001)
    from (
      select e.referencia_id, round(sum(e.valor), 2) as soma
        from ifood_eventos_financeiros e
       where e.empresa_id = p_empresa and e.referencia_tipo = 'ORDER'
         and e.impacta_repasse and coalesce(e.bruto->>'status', '') <> 'PENDING'
       group by e.referencia_id
    ) s
   where v.empresa_id = p_empresa and v.venda_id = s.referencia_id;

  update ifood_vendas v set soma_lancamentos = null, conferido = null
   where v.empresa_id = p_empresa
     and not exists (select 1 from ifood_eventos_financeiros e
                      where e.empresa_id = p_empresa and e.referencia_id = v.venda_id);

  update ifood_liquidacao_semanas l
     set soma_lancamentos = coalesce(s.soma, 0),
         -- sem título gerado, não há o que comparar: a semana está em aberto
         diferenca = case when coalesce(l.qtd_titulos, 0) = 0 then null
                          else round(l.saldo - coalesce(s.soma, 0), 2) end,
         conferido = case when coalesce(l.qtd_titulos, 0) = 0 then null
                          else abs(l.saldo - coalesce(s.soma, 0)) <= greatest(0.01, abs(l.saldo) * 0.0001) end
    from (
      select sem.merchant_id, sem.semana_ini, (
        select round(sum(e.valor), 2)
          from ifood_eventos_financeiros e
         where e.empresa_id = p_empresa and e.merchant_id = sem.merchant_id
           and e.impacta_repasse and coalesce(e.bruto->>'status', '') <> 'PENDING'
           and date_trunc('week', e.periodo_ini)::date = sem.semana_ini
      ) as soma
      from ifood_liquidacao_semanas sem
      where sem.empresa_id = p_empresa
    ) s
   where l.empresa_id = p_empresa and l.merchant_id = s.merchant_id and l.semana_ini = s.semana_ini;

  update ifood_conciliacao_mensal c
     set soma_lancamentos = s.soma,
         conferido = case
           when c.resumo ? 'repasse_arquivo' and s.soma is not null
             then abs((c.resumo->>'repasse_arquivo')::numeric - s.soma)
                  <= greatest(0.01, abs((c.resumo->>'repasse_arquivo')::numeric) * 0.0001)
           else null end
    from (
      select m.id, (
        select round(sum(e.valor), 2)
          from ifood_eventos_financeiros e
         where e.empresa_id = p_empresa and e.merchant_id = m.merchant_id
           and e.competencia = m.competencia
           and e.impacta_repasse and coalesce(e.bruto->>'status', '') <> 'PENDING'
      ) as soma
      from ifood_conciliacao_mensal m
      where m.empresa_id = p_empresa and m.status = 'pronto'
    ) s
   where c.id = s.id;

  return v_n;
end;
$function$;
