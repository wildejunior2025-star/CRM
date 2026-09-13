-- =========================================================
-- Migration 0261 - Conciliação iFood completa (Sales, Settlements, Reconciliation)
-- =========================================================
-- A 0260 trouxe os lançamentos (Financial Events). A homologação do módulo
-- Financial reprova integração parcial ("Sales sem Reconciliation"), então aqui
-- entra o resto — e cada API é CONFERIDA contra os lançamentos, que é o que o
-- guia de mapeamento do iFood manda fazer:
--
--   Liquidação.balance      = soma dos lançamentos com impacto no repasse na semana (seg-dom)
--   Venda.saleBalance       = soma dos lançamentos com impacto no repasse do pedido
--   Arquivo mensal (SIM)    = soma dos lançamentos com impacto no repasse da competência
--   Tolerância: ±0,01% (arredondamento), no mínimo 1 centavo.
--
-- Lançamento com status PENDING não entra em conta nenhuma (guia do iFood:
-- "excluir pendentes").
-- =========================================================

-- ---------------------------------------------------------
-- 1. Vendas (API Sales) — uma linha por pedido do iFood
-- ---------------------------------------------------------
create table if not exists public.ifood_vendas (
  id                uuid        primary key default gen_random_uuid(),
  empresa_id        uuid        not null references public.empresas(id) on delete cascade,
  merchant_id       text        not null,
  venda_id          text        not null,             -- = ifood_order_id
  numero_curto      text,
  criado_em         timestamptz,
  status            text,                             -- currentStatus: CONCLUDED, CANCELLED...
  canal             text,                             -- salesChannel
  tipo              text,
  valor_itens       numeric,                          -- saleGrossValue.bag
  taxa_entrega      numeric,                          -- saleGrossValue.deliveryFee
  taxa_servico      numeric,                          -- saleGrossValue.serviceFee
  beneficios        numeric,                          -- benefits.totalValue
  pago_total        numeric,                          -- soma de payments.methods[].value
  metodos           text,                             -- "PIX (iFood)", "VALE (loja)"...
  comissoes_taxas   numeric,                          -- soma dos billingEntries negativos (magnitude)
  saldo             numeric,                          -- billingSummary.saleBalance = líquido oficial
  soma_lancamentos  numeric,                          -- conferência com os lançamentos
  conferido         boolean,
  bruto             jsonb       not null,
  sincronizado_em   timestamptz not null default now(),
  unique (empresa_id, venda_id)
);
create index if not exists idx_ifood_vendas_data on public.ifood_vendas (empresa_id, criado_em desc);

-- ---------------------------------------------------------
-- 2. Liquidações (API Settlements)
-- ---------------------------------------------------------
-- O saldo da semana, como o iFood devolve na consulta por período de cálculo.
create table if not exists public.ifood_liquidacao_semanas (
  empresa_id        uuid        not null references public.empresas(id) on delete cascade,
  merchant_id       text        not null,
  semana_ini        date        not null,             -- segunda
  semana_fim        date        not null,             -- domingo
  saldo             numeric     not null default 0,   -- balance
  qtd_titulos       int         not null default 0,
  soma_lancamentos  numeric,
  diferenca         numeric,
  conferido         boolean,
  consultado_em     timestamptz not null default now(),
  primary key (empresa_id, merchant_id, semana_ini)
);

-- Cada título gerado (REPASSE, BOLETO, REGISTRO_RECEBIVEIS) com status e,
-- quando pago, os dados bancários.
create table if not exists public.ifood_liquidacoes (
  id                uuid        primary key default gen_random_uuid(),
  empresa_id        uuid        not null references public.empresas(id) on delete cascade,
  merchant_id       text        not null,
  chave             text        not null,
  semana_ini        date,
  periodo_ini       date,
  periodo_fim       date,
  data_pagamento    date,
  tipo              text,
  status            text,
  valor             numeric,
  dados_bancarios   jsonb,
  bruto             jsonb       not null,
  sincronizado_em   timestamptz not null default now(),
  unique (empresa_id, chave)
);
create index if not exists idx_ifood_liquidacoes_semana on public.ifood_liquidacoes (empresa_id, semana_ini desc);

-- ---------------------------------------------------------
-- 3. Relatório mensal (API Reconciliation e Reconciliation On-Demand)
-- ---------------------------------------------------------
create table if not exists public.ifood_conciliacao_mensal (
  id                uuid        primary key default gen_random_uuid(),
  empresa_id        uuid        not null references public.empresas(id) on delete cascade,
  merchant_id       text        not null,
  competencia       text        not null,             -- 'YYYY-MM'
  origem            text        not null,             -- mensal | sob_demanda
  request_id        text,
  status            text        not null,             -- solicitado | processando | pronto | erro
  erro              text,
  arquivo_path      text,                             -- bucket ifood-conciliacao
  linhas            int,
  resumo            jsonb,
  soma_lancamentos  numeric,
  conferido         boolean,
  gerado_em         timestamptz,
  atualizado_em     timestamptz not null default now(),
  unique (empresa_id, merchant_id, competencia, origem)
);

alter table public.ifood_conciliacao_mensal drop constraint if exists ifood_conciliacao_mensal_ck;
alter table public.ifood_conciliacao_mensal add constraint ifood_conciliacao_mensal_ck check (
  origem in ('mensal', 'sob_demanda')
  and status in ('solicitado', 'processando', 'pronto', 'erro')
);

-- ---------------------------------------------------------
-- 4. RLS: a loja lê os dela; quem grava é a edge function
-- ---------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['ifood_vendas', 'ifood_liquidacao_semanas', 'ifood_liquidacoes', 'ifood_conciliacao_mensal']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "Loja lê %s" on public.%I', t, t);
    execute format('create policy "Loja lê %s" on public.%I for select using (empresa_id = current_empresa_id())', t, t);
    execute format('drop policy if exists "Super admin %s" on public.%I', t, t);
    execute format('create policy "Super admin %s" on public.%I for all using (current_perfil() = ''super_admin'') with check (current_perfil() = ''super_admin'')', t, t);
    execute format('grant select on public.%I to authenticated', t);
  end loop;
end $$;

-- ---------------------------------------------------------
-- 5. Arquivo do relatório mensal: bucket PRIVADO
-- ---------------------------------------------------------
-- É o extrato financeiro da loja no iFood. Link assinado na hora de baixar.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('ifood-conciliacao', 'ifood-conciliacao', false, 52428800, array['text/csv'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- A primeira pasta do caminho é o empresa_id: uma loja nunca baixa o extrato de outra.
drop policy if exists "ifood-conciliacao loja le" on storage.objects;
create policy "ifood-conciliacao loja le" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'ifood-conciliacao'
    and (storage.foldername(name))[1] = current_empresa_id()::text
  );

drop policy if exists "ifood-conciliacao servico escreve" on storage.objects;
create policy "ifood-conciliacao servico escreve" on storage.objects
  for insert to service_role
  with check (bucket_id = 'ifood-conciliacao');

drop policy if exists "ifood-conciliacao servico atualiza" on storage.objects;
create policy "ifood-conciliacao servico atualiza" on storage.objects
  for update to service_role
  using (bucket_id = 'ifood-conciliacao');

-- ---------------------------------------------------------
-- 6. Recalcular: semanas + as três conferências
-- ---------------------------------------------------------
create or replace function public.recalcular_repasse_ifood(p_empresa uuid)
returns int
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_n int;
begin
  -- 6.1 Semana do repasse (a mesma conta da 0260, agora sem os pendentes)
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

  -- 6.2 Venda × lançamentos do pedido
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

  -- Venda sem nenhum lançamento ainda: não é divergência, é cedo demais.
  update ifood_vendas v set soma_lancamentos = null, conferido = null
   where v.empresa_id = p_empresa
     and not exists (select 1 from ifood_eventos_financeiros e
                      where e.empresa_id = p_empresa and e.referencia_id = v.venda_id);

  -- 6.3 Liquidação da semana × lançamentos da semana (seg-dom, por loja do iFood)
  update ifood_liquidacao_semanas l
     set soma_lancamentos = coalesce(s.soma, 0),
         diferenca = round(l.saldo - coalesce(s.soma, 0), 2),
         conferido = abs(l.saldo - coalesce(s.soma, 0)) <= greatest(0.01, abs(l.saldo) * 0.0001)
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

  -- 6.4 Arquivo mensal × lançamentos da competência
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
$$;

revoke all on function public.recalcular_repasse_ifood(uuid) from public, anon, authenticated;
grant execute on function public.recalcular_repasse_ifood(uuid) to service_role;
