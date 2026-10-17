-- CAIXA SEPARADO POR DIA (17/10/2026)
--
-- O caixa de hoje é um SACO SEM FUNDO: abre uma vez e vai acumulando até
-- alguém fechar. Na CDBom ele está aberto desde 29/08 — 49 dias de venda
-- empilhados num número só, que não serve pra conferir nada. No depósito do
-- Thiago são 85 dias.
--
-- Pedido do dono: separar por dia, igual ao "Dia a dia" do Financeiro. Mesmo
-- que ninguém feche, cada dia começa zerado, e a pessoa pode voltar nos dias
-- e ir conferindo e fechando um por um.
--
-- É OPCIONAL, POR LOJA. Quem já abre e fecha na mão todo dia (Estação 20/20,
-- Saidera 21/20, Branka 19/18, Lá em Casa 21/18, Braseiro 11/10) não pode ser
-- obrigado a mudar de rotina — a chave nasce DESLIGADA e só liga pra quem
-- hoje não usa caixa nenhum.
--
-- O modo-dia não usa `caixas` nem `caixa_id`: ele olha direto a data do
-- movimento. É o que faz ele funcionar justamente nas lojas que nunca abriram
-- um caixa — se dependesse de um caixa aberto, não mostraria nada pra elas,
-- que é a situação de hoje.

-- ── 1. A chave, por loja ────────────────────────────────────────────────────
alter table public.empresas
  add column if not exists caixa_por_dia boolean not null default false;

comment on column public.empresas.caixa_por_dia is
  'Caixa separado por dia (cada dia começa zerado e fecha sozinho), em vez de um caixa aberto que acumula. Desligado = abre e fecha na mão, como sempre.';

-- ── 2. O fechamento de cada dia ─────────────────────────────────────────────
-- Um retrato por (loja, dia), igual ao `historico_dia` do Financeiro: guarda o
-- que a pessoa CONTOU e o que o sistema ESPERAVA naquele momento.
--
-- O esperado é congelado de propósito. Se ficasse sendo recalculado, um pedido
-- cancelado semana que vem mudaria a diferença de um dia que já foi conferido
-- e assinado — e aí o histórico deixa de ser prova de nada.
create table if not exists public.caixa_dia (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references public.empresas(id) on delete cascade,
  data date not null,

  -- Quanto tinha na gaveta quando o dia começou. Loja com
  -- `caixa_abre_com_fechamento` ligado herda o contado de ontem; as outras
  -- começam em zero (ou no que a pessoa digitar).
  abertura_dinheiro numeric(12,2) not null default 0,
  abertura_pix      numeric(12,2) not null default 0,
  abertura_cartao   numeric(12,2) not null default 0,

  -- O que foi CONTADO no fechamento do dia (null = dia ainda não conferido).
  contado_dinheiro numeric(12,2),
  contado_pix      numeric(12,2),
  contado_cartao   numeric(12,2),

  -- O que o sistema esperava NAQUELE momento (congelado).
  esperado_dinheiro numeric(12,2),
  esperado_pix      numeric(12,2),
  esperado_cartao   numeric(12,2),

  observacoes text,
  fechado_em  timestamptz,
  fechado_por uuid references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now(),

  unique (empresa_id, data)
);

create index if not exists idx_caixa_dia_empresa_data
  on public.caixa_dia (empresa_id, data desc);

alter table public.caixa_dia enable row level security;

drop policy if exists "loja ve seu caixa_dia" on public.caixa_dia;
create policy "loja ve seu caixa_dia" on public.caixa_dia
  for select using (empresa_id = current_empresa_id());

-- Mexer no caixa é coisa de quem responde pelo dinheiro. Mesma regra do
-- `fechar_caixa`, que também recusa garçom e cozinheiro.
drop policy if exists "admin e vendedor fecham o dia" on public.caixa_dia;
create policy "admin e vendedor fecham o dia" on public.caixa_dia
  for all using (empresa_id = current_empresa_id()
                 and current_perfil() in ('admin', 'vendedor'))
      with check (empresa_id = current_empresa_id()
                 and current_perfil() in ('admin', 'vendedor'));

-- ── 3. A view das partes ganha a DATA ───────────────────────────────────────
-- Mesma view de antes (mig 0334/0335), agora servindo aos dois modos: o caixa
-- aberto filtra por `caixa_id`, o modo-dia filtra por `dia`. Uma fonte só, pra
-- os dois modos nunca discordarem sobre onde uma venda caiu.
--
-- Saiu o `caixa_id is not null`: no modo-dia a venda conta mesmo sem caixa
-- aberto. Isso não mexe no `caixa_resumo`, que casa `dp.caixa_id = c.id` e
-- portanto nunca pega linha com caixa nulo.
create or replace view public.caixa_delivery_partes as
select
  d.caixa_id,
  d.id as pedido_id,
  x.bucket,
  x.valor,
  d.numero_pedido,
  d.origem,
  d.cliente_nome,
  d.created_at,
  d.forma_pagamento,
  d.empresa_id,
  (d.created_at at time zone 'America/Fortaleza')::date as dia
from pedidos_delivery d
cross join lateral (
  select
    case
      when d.origem = 'ifood'
       and (coalesce(d.ifood_valores->>'pago_online', '') = 'true'
            or f.forma = 'online')                      then 'ifood'
      when f.forma = 'online'                           then 'online'
      when f.forma = 'pix'
       and d.mp_payment_status = 'approved'             then 'online'
      when f.forma = 'dinheiro'                         then 'dinheiro'
      when f.forma in ('pix', 'pix_entrega')            then 'pix'
      when f.forma = 'credito'                          then 'credito'
      when f.forma = 'debito'                           then 'debito'
      when f.forma = 'cartao'                           then 'cartao'
      else 'outros'
    end as bucket,
    f.valor
  from (
    select p->>'forma' as forma, (p->>'valor')::numeric as valor
      from jsonb_array_elements(d.pagamentos) p
     where d.forma_pagamento = 'dividido'
       and jsonb_typeof(d.pagamentos) = 'array'
    union all
    select d.forma_pagamento, d.total
     where d.forma_pagamento is distinct from 'dividido'
        or jsonb_typeof(d.pagamentos) is distinct from 'array'
  ) f
) x
where d.empresa_id = current_empresa_id()
  and d.status not in ('cancelado', 'aguardando', 'aguardando_pagamento')
  and coalesce(d.forma_pagamento, '') <> 'fiado';

-- ── 4. O resumo de UM dia ───────────────────────────────────────────────────
-- Devolve EXATAMENTE as mesmas colunas do `caixa_resumo` (menos `caixa_id`,
-- mais `dia`), pra tela desenhar os mesmos cards sem saber em que modo está.
create or replace function public.caixa_resumo_do_dia(p_data date)
returns table (
  dia date,
  vendas_a_vista numeric, vendas_fiado numeric, vendas_boleto numeric,
  recebimentos_dinheiro numeric, recebimentos_pix numeric,
  recebimentos_transferencia numeric, recebimentos_cartao numeric,
  total_sangrias numeric, total_suprimentos numeric,
  total_sangrias_dinheiro numeric, total_sangrias_pix numeric,
  total_suprimentos_dinheiro numeric, total_suprimentos_pix numeric,
  recebimentos_fiado numeric, recebimentos_fiado_dinheiro numeric,
  recebimentos_fiado_pix numeric, recebimentos_fiado_cartao numeric,
  recebimentos_fiado_transferencia numeric,
  recebimentos_credito numeric, recebimentos_debito numeric,
  recebimentos_cartao_generico numeric,
  recebimentos_fiado_credito numeric, recebimentos_fiado_debito numeric,
  total_sangrias_cartao numeric, total_suprimentos_cartao numeric,
  recebimentos_cashback numeric,
  delivery_pedidos bigint, delivery_dinheiro numeric, delivery_pix numeric,
  delivery_cartao numeric, delivery_online numeric, delivery_ifood numeric,
  delivery_outros numeric, delivery_credito numeric, delivery_debito numeric,
  delivery_cartao_generico numeric
)
language sql stable security definer set search_path to 'public'
as $$
  with emp as (select current_empresa_id() as id),
  dia_v as (
    select
      sum(v.total) filter (where v.forma_pagamento = 'a_vista')    as a_vista,
      sum(v.total) filter (where v.forma_pagamento = 'fiado')      as fiado,
      sum(v.total) filter (where v.forma_pagamento like 'boleto%') as boleto
    from vendas v, emp
    where v.empresa_id = emp.id
      and v.status <> 'cancelado'
      -- A dívida nascida de um pedido do balcão já está contada no delivery
      -- (mig 0327): aqui ela entra só como DÍVIDA, não como faturamento.
      and (v.created_at at time zone 'America/Fortaleza')::date = p_data
  ),
  dia_p as (
    select
      sum(valor) filter (where forma_pagamento = 'dinheiro')      as dinheiro,
      sum(valor) filter (where forma_pagamento = 'pix')           as pix,
      sum(valor) filter (where forma_pagamento = 'transferencia') as transf,
      sum(valor) filter (where forma_pagamento in ('cartao','credito','debito')) as cartao,
      sum(valor) filter (where forma_pagamento = 'credito')       as credito,
      sum(valor) filter (where forma_pagamento = 'debito')        as debito,
      sum(valor) filter (where forma_pagamento = 'cartao')        as cartao_gen,
      sum(valor) filter (where forma_pagamento = 'cashback')      as cashback,
      sum(valor) filter (where fi)                                 as fi_tot,
      sum(valor) filter (where fi and forma_pagamento = 'dinheiro') as fi_din,
      sum(valor) filter (where fi and forma_pagamento = 'pix')      as fi_pix,
      sum(valor) filter (where fi and forma_pagamento in ('cartao','credito','debito')) as fi_cart,
      sum(valor) filter (where fi and forma_pagamento = 'credito')  as fi_cred,
      sum(valor) filter (where fi and forma_pagamento = 'debito')   as fi_deb,
      sum(valor) filter (where fi and forma_pagamento = 'transferencia') as fi_transf
    from (
      select pg.valor, pg.forma_pagamento,
             coalesce(pg.observacao,'') = 'Recebimento de fiado' as fi
        from pagamentos pg, emp
       where pg.empresa_id = emp.id
         and (pg.created_at at time zone 'America/Fortaleza')::date = p_data
    ) t
  ),
  dia_m as (
    select
      sum(valor) filter (where tipo = 'sangria')    as sangria,
      sum(valor) filter (where tipo = 'suprimento') as suprimento,
      sum(valor) filter (where tipo = 'sangria'    and coalesce(forma,'dinheiro') = 'dinheiro') as sang_din,
      sum(valor) filter (where tipo = 'sangria'    and forma = 'pix')    as sang_pix,
      sum(valor) filter (where tipo = 'sangria'    and forma = 'cartao') as sang_cart,
      sum(valor) filter (where tipo = 'suprimento' and coalesce(forma,'dinheiro') = 'dinheiro') as sup_din,
      sum(valor) filter (where tipo = 'suprimento' and forma = 'pix')    as sup_pix,
      sum(valor) filter (where tipo = 'suprimento' and forma = 'cartao') as sup_cart
    from caixa_movimentos m, emp
    where m.empresa_id = emp.id
      and (m.created_at at time zone 'America/Fortaleza')::date = p_data
  ),
  dia_d as (
    select
      count(distinct pedido_id)                        as pedidos,
      sum(valor) filter (where bucket = 'dinheiro')    as dinheiro,
      sum(valor) filter (where bucket = 'pix')         as pix,
      sum(valor) filter (where bucket = 'credito')     as credito,
      sum(valor) filter (where bucket = 'debito')      as debito,
      sum(valor) filter (where bucket = 'cartao')      as cartao_gen,
      sum(valor) filter (where bucket in ('credito','debito','cartao')) as cartao,
      sum(valor) filter (where bucket = 'online')      as online,
      sum(valor) filter (where bucket = 'ifood')       as ifood,
      sum(valor) filter (where bucket = 'outros')      as outros
    from caixa_delivery_partes
    where dia = p_data
  )
  select p_data,
    coalesce(dia_v.a_vista,0), coalesce(dia_v.fiado,0), coalesce(dia_v.boleto,0),
    coalesce(dia_p.dinheiro,0), coalesce(dia_p.pix,0),
    coalesce(dia_p.transf,0), coalesce(dia_p.cartao,0),
    coalesce(dia_m.sangria,0), coalesce(dia_m.suprimento,0),
    coalesce(dia_m.sang_din,0), coalesce(dia_m.sang_pix,0),
    coalesce(dia_m.sup_din,0), coalesce(dia_m.sup_pix,0),
    coalesce(dia_p.fi_tot,0), coalesce(dia_p.fi_din,0),
    coalesce(dia_p.fi_pix,0), coalesce(dia_p.fi_cart,0),
    coalesce(dia_p.fi_transf,0),
    coalesce(dia_p.credito,0), coalesce(dia_p.debito,0),
    coalesce(dia_p.cartao_gen,0),
    coalesce(dia_p.fi_cred,0), coalesce(dia_p.fi_deb,0),
    coalesce(dia_m.sang_cart,0), coalesce(dia_m.sup_cart,0),
    coalesce(dia_p.cashback,0),
    coalesce(dia_d.pedidos,0), coalesce(dia_d.dinheiro,0), coalesce(dia_d.pix,0),
    coalesce(dia_d.cartao,0), coalesce(dia_d.online,0), coalesce(dia_d.ifood,0),
    coalesce(dia_d.outros,0), coalesce(dia_d.credito,0), coalesce(dia_d.debito,0),
    coalesce(dia_d.cartao_gen,0)
  from dia_v, dia_p, dia_m, dia_d;
$$;

comment on function public.caixa_resumo_do_dia(date) is
  'Resumo do caixa de UM dia (modo caixa_por_dia). Mesmas colunas do caixa_resumo, filtrado por data em vez de caixa_id.';

-- ── 5. Piloto: só quem hoje NÃO usa caixa ───────────────────────────────────
-- Zebu, CDBom, Pizzaria do Zé e ZN Bar. As que já abrem e fecham todo dia
-- ficam como estão, de propósito.
update public.empresas
   set caixa_por_dia = true
 where nome in ('Zebu Restaurante', 'Sorveteria CDBom', 'Pizzaria do Zé', 'ZN Bar e Petiscaria');
