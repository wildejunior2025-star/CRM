-- =========================================================
-- Migration 0260 - Repasse do iFood pela API (módulo Financial)
-- =========================================================
-- Até aqui o repasse exato só entrava se o dono baixasse o PDF no Portal do
-- Parceiro e importasse na mão, semana a semana. A API Financial v3.0 entrega
-- os mesmos números sozinha: cada lançamento (venda, comissão, taxa de
-- transação, anúncio, subsídio do iFood) com o período de apuração, a data
-- prevista do repasse e o pedido a que se refere.
--
-- O desenho:
--   1. ifood_eventos_financeiros guarda CADA lançamento, cru. É a fonte da
--      verdade: dá pra refazer qualquer conta depois e bater com o PDF.
--   2. recalcular_repasse_ifood() soma os lançamentos por período e grava em
--      ifood_repasse_semanal — a MESMA tabela que o PDF alimenta. A tela
--      Financeiro já lê dela e mostra a semana como "exata", sem mudar nada lá.
--   3. PDF importado vence: período com fonte='pdf' não é sobrescrito pela API.
--      O PDF é o documento oficial do iFood; se os dois divergirem, é a API que
--      precisa de ajuste, e a gente vê a diferença nos lançamentos crus.
--
-- Hoje (12/09/2026) só o app de TESTE tem o escopo `conciliator`. O app de
-- produção recebe 403 até o módulo ser homologado — a sincronização registra
-- isso como 'sem_permissao' em vez de gritar erro toda noite.
-- =========================================================

-- ---------------------------------------------------------
-- 1. Lançamentos crus
-- ---------------------------------------------------------
create table if not exists public.ifood_eventos_financeiros (
  id                  uuid        primary key default gen_random_uuid(),
  empresa_id          uuid        not null references public.empresas(id) on delete cascade,
  merchant_id         text        not null,

  -- Os lançamentos não têm id na API. A chave é um hash dos campos que
  -- identificam o lançamento + a ordem dele entre lançamentos idênticos na
  -- mesma resposta — assim sincronizar a mesma janela duas vezes não duplica.
  chave               text        not null,

  nome                text        not null,   -- ORDER_PAYMENT, ORDER_COMMISSION, "Cobrança Pacote Anúncios"...
  descricao           text,
  gatilho             text,                   -- trigger: ORDER_CONCLUDED, SINGLE_OCCURRENCE...
  produto             text,
  competencia         text,                   -- 'YYYY-MM'

  periodo_ini         date,                   -- período de apuração (seg-dom, cortado na virada do mês)
  periodo_fim         date,
  id_saldo            text,

  referencia_tipo     text,                   -- 'ORDER' quando é de um pedido
  referencia_id       text,                   -- id do pedido no iFood (= pedidos_delivery.ifood_order_id)
  referencia_em       timestamptz,

  valor               numeric     not null,   -- com sinal: crédito +, débito −
  impacta_repasse     boolean     not null default true,
  previsao_pagamento  date,
  metodo_pagamento    text,
  responsavel         text,                   -- liability: IFOOD / MERCHANT
  base_calculo        numeric,
  percentual          numeric,

  bruto               jsonb       not null,   -- o lançamento inteiro como veio
  sincronizado_em     timestamptz not null default now(),

  unique (empresa_id, chave)
);

create index if not exists idx_ifood_eventos_fin_periodo
  on public.ifood_eventos_financeiros (empresa_id, periodo_ini);
create index if not exists idx_ifood_eventos_fin_pedido
  on public.ifood_eventos_financeiros (referencia_id) where referencia_id is not null;

alter table public.ifood_eventos_financeiros enable row level security;

-- A loja LÊ os dela; quem grava é a edge function (service_role).
drop policy if exists "Loja lê seus lançamentos iFood" on public.ifood_eventos_financeiros;
create policy "Loja lê seus lançamentos iFood"
  on public.ifood_eventos_financeiros for select
  using (empresa_id = current_empresa_id());

drop policy if exists "Super admin lançamentos iFood" on public.ifood_eventos_financeiros;
create policy "Super admin lançamentos iFood"
  on public.ifood_eventos_financeiros for all
  using (current_perfil() = 'super_admin')
  with check (current_perfil() = 'super_admin');

grant select on public.ifood_eventos_financeiros to authenticated;

-- ---------------------------------------------------------
-- 2. Status da sincronização por loja do iFood
-- ---------------------------------------------------------
alter table public.ifood_config
  add column if not exists financeiro_status   text,         -- ok | sem_permissao | erro
  add column if not exists financeiro_sync_em  timestamptz,
  add column if not exists financeiro_erro     text;

alter table public.ifood_config drop constraint if exists ifood_config_financeiro_status_ck;
alter table public.ifood_config add constraint ifood_config_financeiro_status_ck
  check (financeiro_status is null or financeiro_status in ('ok', 'sem_permissao', 'erro'));

-- ---------------------------------------------------------
-- 3. De onde veio a semana: PDF (importado na mão) ou API
-- ---------------------------------------------------------
alter table public.ifood_repasse_semanal
  add column if not exists fonte text not null default 'pdf';

alter table public.ifood_repasse_semanal drop constraint if exists ifood_repasse_semanal_fonte_ck;
alter table public.ifood_repasse_semanal add constraint ifood_repasse_semanal_fonte_ck
  check (fonte in ('pdf', 'api'));

-- ---------------------------------------------------------
-- 4. Soma os lançamentos em semanas
-- ---------------------------------------------------------
-- valor_repasse = tudo que mexe no repasse (impacta_repasse). É a conta que
-- não depende de conhecer o nome de cada lançamento, então é a mais segura.
-- As quebras (comissões, anúncio, recebido direto) dependem dos nomes e ficam
-- como melhor leitura até bater com o primeiro PDF real de produção.
create or replace function public.recalcular_repasse_ifood(p_empresa uuid)
returns int
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_n int;
begin
  with por_periodo as (
    select
      e.empresa_id,
      e.periodo_ini,
      max(e.periodo_fim)                                             as periodo_fim,
      max(e.previsao_pagamento)                                      as previsao_pagamento,
      round(sum(e.valor) filter (where e.impacta_repasse), 2)        as valor_repasse,
      round(sum(e.valor) filter (where e.nome = 'ORDER_PAYMENT'), 2) as vendas,
      round(abs(coalesce(sum(e.valor) filter (
        where e.nome ilike '%an%ncio%' or e.nome ilike '%ADVERTIS%'), 0)), 2) as anuncio,
      round(abs(coalesce(sum(e.valor) filter (
        where e.valor < 0
          and e.nome in ('ORDER_COMMISSION', 'PAYMENT_TRANSACTION_FEE', 'SERVICE_FEE',
                         'DELIVERY_REQUEST', 'DELIVERY_FEE_IFOOD')), 0)), 2) as comissoes,
      round(abs(coalesce(sum(e.valor) filter (
        where e.valor < 0 and (e.nome ilike '%PROMOTION%' or e.nome ilike 'MERCHANT%SUBSIDY%')), 0)), 2) as promocoes,
      round(coalesce(sum(e.valor) filter (
        where e.nome = 'ORDER_PAYMENT' and not e.impacta_repasse), 0), 2) as recebido_direto
    from ifood_eventos_financeiros e
    where e.empresa_id = p_empresa
      and e.periodo_ini is not null
    group by e.empresa_id, e.periodo_ini
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
  -- O PDF importado na mão é o documento oficial: a API não passa por cima.
  where r.fonte = 'api';

  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- Só a edge function chama. O Supabase dá EXECUTE pra anon/authenticated por
-- padrão, e revogar só de PUBLIC não tira isso — por isso os três.
revoke all on function public.recalcular_repasse_ifood(uuid) from public, anon, authenticated;
grant execute on function public.recalcular_repasse_ifood(uuid) to service_role;

-- ---------------------------------------------------------
-- 5. Sincroniza sozinho toda madrugada (06:15 em Fortaleza = 09:15 UTC)
-- ---------------------------------------------------------
-- Madrugada porque o iFood consolida os lançamentos do dia anterior à noite, e
-- de manhã o dono já abre o Financeiro com a semana atualizada.
do $$ begin
  perform cron.unschedule('ifood-financeiro-sync');
exception when others then null; end $$;

select cron.schedule(
  'ifood-financeiro-sync',
  '15 9 * * *',
  $cron$
  select net.http_post(
    url := 'https://ycytrsqdvrviihkqfvno.supabase.co/functions/v1/ifood-integration',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := '{"acao": "financeiro_sync"}'::jsonb,
    timeout_milliseconds := 120000
  ) as request_id
  $cron$
);
