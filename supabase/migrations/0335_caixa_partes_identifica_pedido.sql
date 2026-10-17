-- DE ONDE VEIO CADA VALOR DO CAIXA (17/10/2026)
--
-- Os cards do Caixa viraram clicaveis: clicar em "Recebimentos em dinheiro"
-- abre a lista do que formou aquele valor. Pro salao isso ja dava, porque
-- `pagamentos.observacao` guarda "Presencial - Comanda 45 - Garcom: pedro".
-- Pro delivery faltava: a view so dizia (caixa, balde, valor), sem dizer QUAL
-- pedido.
--
-- As colunas entram AQUI e nao no front de proposito. A regra de qual balde
-- cada venda cai (iFood pago no app x cobrado na entrega, PIX do Mercado Pago
-- x PIX na mao) ja mora nesta view. Repetir ela em JavaScript so pra montar a
-- lista criaria duas verdades, e o dia que uma mudasse o total do card nao
-- bateria com a soma da propria lista que ele abre.
--
-- Colunas novas vao no fim: `create or replace view` so aceita assim.
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
  d.forma_pagamento
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
where d.caixa_id is not null
  and d.empresa_id = current_empresa_id()
  and d.status not in ('cancelado', 'aguardando', 'aguardando_pagamento')
  and coalesce(d.forma_pagamento, '') <> 'fiado';
