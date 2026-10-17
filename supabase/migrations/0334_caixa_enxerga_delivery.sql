-- O CAIXA PASSA A ENXERGAR AS VENDAS DE DELIVERY E BALCÃO (17/10/2026)
--
-- Até aqui o Caixa só via o SALÃO: ele soma `vendas` e `pagamentos`, que nascem
-- do fechamento de conta da mesa. O "+ Vender" e todo o delivery gravam em
-- `pedidos_delivery` e simplesmente não existiam pro caixa.
--
-- Ficou gritante quando o fiado do balcão entrou (mig 0327): R$ 15,00 no fiado
-- apareciam no Caixa, mas os mesmos R$ 15,00 em DINHEIRO, na mesma tela, não.
--
-- QUANDO O DINHEIRO ENTRA: na CONFIRMAÇÃO do pedido (decisão do dono, 17/10).
-- Não na criação — pedido que ninguém aceitou ainda não é venda, e PIX que
-- pode nunca ser pago não é dinheiro. Pedido cancelado depois sai sozinho,
-- porque a view ignora 'cancelado'.
--
-- O QUE NÃO É DINHEIRO DA LOJA — e esta é a parte que faz o caixa bater:
--   iFood pago no app      -> o dinheiro está na conta do iFood
--   nosso PIX online (MP)  -> está na conta do Mercado Pago
-- Os dois ganham linha própria e NÃO entram no esperado em dinheiro. Já o
-- iFood cobrado na entrega pelo motoboy DA LOJA é dinheiro da gaveta, e entra.
--
-- Fiado fica de fora daqui: ele já vira `vendas` e já aparece em VENDAS FIADO.
-- Contar os dois dobraria.
--
-- SEM BACKFILL DE PROPÓSITO. Carimbar os pedidos antigos jogaria semanas de
-- delivery dentro do caixa que está aberto AGORA, e o fechamento de hoje ia
-- fechar com um valor que nunca passou na gaveta. Vale do próximo pedido.

-- ── 1. Achar o caixa aberto de uma loja SEM depender de quem está logado ────
-- `current_caixa_id()` usa `current_empresa_id()`, que vem da sessão. O pedido
-- do iFood chega por edge function (service role), sem sessão nenhuma.
create or replace function public.caixa_aberto_da_empresa(p_empresa uuid)
returns uuid
language sql stable security definer set search_path to 'public'
as $$
  select id from caixas
   where empresa_id = p_empresa and status = 'aberto'
   order by aberto_em desc
   limit 1;
$$;

-- ── 2. O pedido guarda em qual caixa ele caiu ───────────────────────────────
alter table public.pedidos_delivery
  add column if not exists caixa_id uuid references public.caixas(id) on delete set null;

create index if not exists idx_pedidos_caixa on public.pedidos_delivery (caixa_id)
  where caixa_id is not null;

comment on column public.pedidos_delivery.caixa_id is
  'Caixa em que esta venda entrou. Carimbado na CONFIRMAÇÃO do pedido, não na criação.';

create or replace function public.pedido_carimba_caixa()
returns trigger
language plpgsql security definer set search_path to 'public'
as $$
begin
  -- Já tem caixa? Não mexe. O caixa é de quando a venda entrou, e isso não
  -- pode mudar depois (senão o fechamento de ontem muda hoje).
  if new.caixa_id is not null then return new; end if;

  -- Só conta pedido ACEITO. 'aguardando' é cliente esperando a loja olhar;
  -- 'aguardando_pagamento' é PIX que pode nunca ser pago.
  if new.status in ('aguardando', 'aguardando_pagamento', 'cancelado') then
    return new;
  end if;

  new.caixa_id := caixa_aberto_da_empresa(new.empresa_id);
  return new;
end $$;

drop trigger if exists trg_pedido_carimba_caixa on public.pedidos_delivery;
create trigger trg_pedido_carimba_caixa
  before insert or update of status on public.pedidos_delivery
  for each row execute function public.pedido_carimba_caixa();

-- ── 3. Onde cada venda de delivery cai no caixa ─────────────────────────────
-- View separada porque a conta tem duas sutilezas que não cabem numa linha:
--
--   a) PAGAMENTO DIVIDIDO: o pedido tem UM total, mas o dinheiro veio em
--      partes ("R$ 30 dinheiro + R$ 31,50 pix"), que moram no jsonb
--      `pagamentos`. Jogar o total inteiro em 'dinheiro' faria a gaveta
--      esperar R$ 61,50 e sobrar R$ 31,50 de diferença todo dia.
--
--   b) QUEM FICOU COM O DINHEIRO não é a forma de pagamento. "pix" pode ser o
--      PIX online (caiu no Mercado Pago) ou o PIX na mão do dono. O que
--      separa é `mp_payment_status`.
--
-- Nada de `else 'dinheiro'` no fim: forma que eu não conheço vai pra 'outros'.
-- Chutar dinheiro aumentaria o esperado na gaveta e o dono ia caçar uma falta
-- que não existe.
create or replace view public.caixa_delivery_partes as
select
  d.caixa_id,
  d.id as pedido_id,
  x.bucket,
  x.valor
from pedidos_delivery d
cross join lateral (
  select
    case
      -- Pago dentro do app do iFood: o dinheiro está lá, não na gaveta.
      when d.origem = 'ifood'
       and (coalesce(d.ifood_valores->>'pago_online', '') = 'true'
            or f.forma = 'online')                      then 'ifood'
      -- Nosso checkout online, confirmado pelo Mercado Pago.
      when f.forma = 'online'                           then 'online'
      when f.forma = 'pix'
       and d.mp_payment_status = 'approved'              then 'online'
      when f.forma = 'dinheiro'                         then 'dinheiro'
      when f.forma in ('pix', 'pix_entrega')            then 'pix'
      -- Credito e debito separados porque a taxa da maquineta e diferente em
      -- cada um, e o esperado em cartao persegue o LIQUIDO.
      when f.forma = 'credito'                          then 'credito'
      when f.forma = 'debito'                           then 'debito'
      when f.forma = 'cartao'                            then 'cartao'
      else 'outros'
    end as bucket,
    f.valor
  from (
    -- Dividido: uma linha por parte.
    select p->>'forma' as forma, (p->>'valor')::numeric as valor
      from jsonb_array_elements(d.pagamentos) p
     where d.forma_pagamento = 'dividido'
       and jsonb_typeof(d.pagamentos) = 'array'
    union all
    -- Forma única: uma linha com o total.
    select d.forma_pagamento, d.total
     where d.forma_pagamento is distinct from 'dividido'
        or jsonb_typeof(d.pagamentos) is distinct from 'array'
  ) f
) x
where d.caixa_id is not null
  -- Mesma trava do `caixa_resumo`: view roda como dona, então o isolamento
  -- entre lojas é aqui. Sem isto, bater nela direto na API veria todo mundo.
  and d.empresa_id = current_empresa_id()
  and d.status not in ('cancelado', 'aguardando', 'aguardando_pagamento')
  and coalesce(d.forma_pagamento, '') <> 'fiado';

comment on view public.caixa_delivery_partes is
  'Cada venda de delivery/balcao quebrada em (caixa, onde o dinheiro caiu, valor). Quebra o pagamento dividido e separa o que caiu no iFood/Mercado Pago do que caiu na gaveta.';

-- ── 4. O resumo do caixa, agora com o delivery ──────────────────────────────
-- Recriada inteira porque é `create or replace view`: as colunas que já
-- existiam continuam na mesma ordem e com o mesmo nome (o front depende
-- delas), e as de delivery entram no fim.
create or replace view public.caixa_resumo as
 SELECT c.id AS caixa_id,
    COALESCE(ve.vendas_a_vista, 0::numeric) AS vendas_a_vista,
    COALESCE(ve.vendas_fiado, 0::numeric) AS vendas_fiado,
    COALESCE(ve.vendas_boleto, 0::numeric) AS vendas_boleto,
    COALESCE(pg.recebimentos_dinheiro, 0::numeric) AS recebimentos_dinheiro,
    COALESCE(pg.recebimentos_pix, 0::numeric) AS recebimentos_pix,
    COALESCE(pg.recebimentos_transferencia, 0::numeric) AS recebimentos_transferencia,
    COALESCE(pg.recebimentos_cartao, 0::numeric) AS recebimentos_cartao,
    COALESCE(mv.total_sangrias, 0::numeric) AS total_sangrias,
    COALESCE(mv.total_suprimentos, 0::numeric) AS total_suprimentos,
    COALESCE(mv.total_sangrias_dinheiro, 0::numeric) AS total_sangrias_dinheiro,
    COALESCE(mv.total_sangrias_pix, 0::numeric) AS total_sangrias_pix,
    COALESCE(mv.total_suprimentos_dinheiro, 0::numeric) AS total_suprimentos_dinheiro,
    COALESCE(mv.total_suprimentos_pix, 0::numeric) AS total_suprimentos_pix,
    COALESCE(pg.recebimentos_fiado, 0::numeric) AS recebimentos_fiado,
    COALESCE(pg.recebimentos_fiado_dinheiro, 0::numeric) AS recebimentos_fiado_dinheiro,
    COALESCE(pg.recebimentos_fiado_pix, 0::numeric) AS recebimentos_fiado_pix,
    COALESCE(pg.recebimentos_fiado_cartao, 0::numeric) AS recebimentos_fiado_cartao,
    COALESCE(pg.recebimentos_fiado_transferencia, 0::numeric) AS recebimentos_fiado_transferencia,
    COALESCE(pg.recebimentos_credito, 0::numeric) AS recebimentos_credito,
    COALESCE(pg.recebimentos_debito, 0::numeric) AS recebimentos_debito,
    COALESCE(pg.recebimentos_cartao_generico, 0::numeric) AS recebimentos_cartao_generico,
    COALESCE(pg.recebimentos_fiado_credito, 0::numeric) AS recebimentos_fiado_credito,
    COALESCE(pg.recebimentos_fiado_debito, 0::numeric) AS recebimentos_fiado_debito,
    COALESCE(mv.total_sangrias_cartao, 0::numeric) AS total_sangrias_cartao,
    COALESCE(mv.total_suprimentos_cartao, 0::numeric) AS total_suprimentos_cartao,
    COALESCE(pg.recebimentos_cashback, 0::numeric) AS recebimentos_cashback,
    -- delivery e balcão (mig 0334)
    COALESCE(dl.delivery_pedidos, 0::bigint) AS delivery_pedidos,
    COALESCE(dl.delivery_dinheiro, 0::numeric) AS delivery_dinheiro,
    COALESCE(dl.delivery_pix, 0::numeric) AS delivery_pix,
    COALESCE(dl.delivery_cartao, 0::numeric) AS delivery_cartao,
    COALESCE(dl.delivery_online, 0::numeric) AS delivery_online,
    COALESCE(dl.delivery_ifood, 0::numeric) AS delivery_ifood,
    COALESCE(dl.delivery_outros, 0::numeric) AS delivery_outros,
    COALESCE(dl.delivery_credito, 0::numeric) AS delivery_credito,
    COALESCE(dl.delivery_debito, 0::numeric) AS delivery_debito,
    COALESCE(dl.delivery_cartao_generico, 0::numeric) AS delivery_cartao_generico
   FROM caixas c
     LEFT JOIN LATERAL ( SELECT sum(vendas.total) FILTER (WHERE vendas.forma_pagamento = 'a_vista'::text AND vendas.status <> 'cancelado'::text) AS vendas_a_vista,
            sum(vendas.total) FILTER (WHERE vendas.forma_pagamento = 'fiado'::text AND vendas.status <> 'cancelado'::text) AS vendas_fiado,
            sum(vendas.total) FILTER (WHERE vendas.forma_pagamento ~~ 'boleto%'::text AND vendas.status <> 'cancelado'::text) AS vendas_boleto
           FROM vendas
          WHERE vendas.caixa_id = c.id) ve ON true
     LEFT JOIN LATERAL ( SELECT sum(pagamentos.valor) FILTER (WHERE pagamentos.forma_pagamento = 'dinheiro'::text) AS recebimentos_dinheiro,
            sum(pagamentos.valor) FILTER (WHERE pagamentos.forma_pagamento = 'pix'::text) AS recebimentos_pix,
            sum(pagamentos.valor) FILTER (WHERE pagamentos.forma_pagamento = 'transferencia'::text) AS recebimentos_transferencia,
            sum(pagamentos.valor) FILTER (WHERE pagamentos.forma_pagamento = ANY (ARRAY['cartao'::text, 'credito'::text, 'debito'::text])) AS recebimentos_cartao,
            sum(pagamentos.valor) FILTER (WHERE pagamentos.forma_pagamento = 'credito'::text) AS recebimentos_credito,
            sum(pagamentos.valor) FILTER (WHERE pagamentos.forma_pagamento = 'debito'::text) AS recebimentos_debito,
            sum(pagamentos.valor) FILTER (WHERE pagamentos.forma_pagamento = 'cartao'::text) AS recebimentos_cartao_generico,
            sum(pagamentos.valor) FILTER (WHERE pagamentos.forma_pagamento = 'cashback'::text) AS recebimentos_cashback,
            sum(pagamentos.valor) FILTER (WHERE COALESCE(pagamentos.observacao, ''::text) = 'Recebimento de fiado'::text) AS recebimentos_fiado,
            sum(pagamentos.valor) FILTER (WHERE COALESCE(pagamentos.observacao, ''::text) = 'Recebimento de fiado'::text AND pagamentos.forma_pagamento = 'dinheiro'::text) AS recebimentos_fiado_dinheiro,
            sum(pagamentos.valor) FILTER (WHERE COALESCE(pagamentos.observacao, ''::text) = 'Recebimento de fiado'::text AND pagamentos.forma_pagamento = 'pix'::text) AS recebimentos_fiado_pix,
            sum(pagamentos.valor) FILTER (WHERE COALESCE(pagamentos.observacao, ''::text) = 'Recebimento de fiado'::text AND (pagamentos.forma_pagamento = ANY (ARRAY['cartao'::text, 'credito'::text, 'debito'::text]))) AS recebimentos_fiado_cartao,
            sum(pagamentos.valor) FILTER (WHERE COALESCE(pagamentos.observacao, ''::text) = 'Recebimento de fiado'::text AND pagamentos.forma_pagamento = 'credito'::text) AS recebimentos_fiado_credito,
            sum(pagamentos.valor) FILTER (WHERE COALESCE(pagamentos.observacao, ''::text) = 'Recebimento de fiado'::text AND pagamentos.forma_pagamento = 'debito'::text) AS recebimentos_fiado_debito,
            sum(pagamentos.valor) FILTER (WHERE COALESCE(pagamentos.observacao, ''::text) = 'Recebimento de fiado'::text AND pagamentos.forma_pagamento = 'transferencia'::text) AS recebimentos_fiado_transferencia
           FROM pagamentos
          WHERE pagamentos.caixa_id = c.id) pg ON true
     LEFT JOIN LATERAL ( SELECT sum(caixa_movimentos.valor) FILTER (WHERE caixa_movimentos.tipo = 'sangria'::text) AS total_sangrias,
            sum(caixa_movimentos.valor) FILTER (WHERE caixa_movimentos.tipo = 'suprimento'::text) AS total_suprimentos,
            sum(caixa_movimentos.valor) FILTER (WHERE caixa_movimentos.tipo = 'sangria'::text AND COALESCE(caixa_movimentos.forma, 'dinheiro'::text) = 'dinheiro'::text) AS total_sangrias_dinheiro,
            sum(caixa_movimentos.valor) FILTER (WHERE caixa_movimentos.tipo = 'sangria'::text AND caixa_movimentos.forma = 'pix'::text) AS total_sangrias_pix,
            sum(caixa_movimentos.valor) FILTER (WHERE caixa_movimentos.tipo = 'sangria'::text AND caixa_movimentos.forma = 'cartao'::text) AS total_sangrias_cartao,
            sum(caixa_movimentos.valor) FILTER (WHERE caixa_movimentos.tipo = 'suprimento'::text AND COALESCE(caixa_movimentos.forma, 'dinheiro'::text) = 'dinheiro'::text) AS total_suprimentos_dinheiro,
            sum(caixa_movimentos.valor) FILTER (WHERE caixa_movimentos.tipo = 'suprimento'::text AND caixa_movimentos.forma = 'pix'::text) AS total_suprimentos_pix,
            sum(caixa_movimentos.valor) FILTER (WHERE caixa_movimentos.tipo = 'suprimento'::text AND caixa_movimentos.forma = 'cartao'::text) AS total_suprimentos_cartao
           FROM caixa_movimentos
          WHERE caixa_movimentos.caixa_id = c.id) mv ON true
     LEFT JOIN LATERAL ( SELECT count(DISTINCT dp.pedido_id) AS delivery_pedidos,
            sum(dp.valor) FILTER (WHERE dp.bucket = 'dinheiro'::text) AS delivery_dinheiro,
            sum(dp.valor) FILTER (WHERE dp.bucket = 'pix'::text) AS delivery_pix,
            sum(dp.valor) FILTER (WHERE dp.bucket = 'credito'::text) AS delivery_credito,
            sum(dp.valor) FILTER (WHERE dp.bucket = 'debito'::text) AS delivery_debito,
            sum(dp.valor) FILTER (WHERE dp.bucket = 'cartao'::text) AS delivery_cartao_generico,
            sum(dp.valor) FILTER (WHERE dp.bucket = ANY (ARRAY['credito'::text, 'debito'::text, 'cartao'::text])) AS delivery_cartao,
            sum(dp.valor) FILTER (WHERE dp.bucket = 'online'::text) AS delivery_online,
            sum(dp.valor) FILTER (WHERE dp.bucket = 'ifood'::text) AS delivery_ifood,
            sum(dp.valor) FILTER (WHERE dp.bucket = 'outros'::text) AS delivery_outros
           FROM caixa_delivery_partes dp
          WHERE dp.caixa_id = c.id) dl ON true
  WHERE c.empresa_id = current_empresa_id();
