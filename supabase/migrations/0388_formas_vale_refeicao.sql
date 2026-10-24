-- 0388 — Cartões de benefício como forma de pagamento: Pluxee, Alelo, VR, Ticket
--
-- Pedido do Agv (24/10/2026): o sistema que eles usavam aceita essas maquinetas
-- (vale-refeição / vale-alimentação) e o nosso só tinha dinheiro, PIX e cartão.
-- Cada bandeira é uma forma própria: é uma maquineta e um repasse diferentes.
--
-- Elas NASCEM DESLIGADAS pra todas as lojas (empresas.formas_pagamento só tem o
-- que a loja marcou em Minha Loja → Pagamento) e a Agv liga no fim desta migração.
--
-- O perigo de não migrar o banco junto: o fechamento de conta da mesa gravava
-- QUALQUER forma que não conhecia como DINHEIRO — vale passado na maquineta
-- entrava no caixa como dinheiro na gaveta.

-- 1) Pedido de delivery aceita as formas novas.
ALTER TABLE pedidos_delivery DROP CONSTRAINT IF EXISTS pedidos_delivery_forma_pagamento_check;
ALTER TABLE pedidos_delivery ADD CONSTRAINT pedidos_delivery_forma_pagamento_check
  CHECK (forma_pagamento = ANY (ARRAY['pix','pix_entrega','dinheiro','credito','debito','cartao','online','vale','outro','dividido','fiado','pluxee','alelo','vr','ticket']));

-- 2) Funções que listam as formas na mão: reescreve cada uma a partir da própria
-- definição (troca o trecho da lista), pra não copiar o corpo aqui.
CREATE OR REPLACE FUNCTION pg_temp.patch_fn(p_nome text, p_velho text, p_novo text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  f record;
  v_def text;
  v_novo text;
BEGIN
  FOR f IN
    SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = p_nome
  LOOP
    v_def := pg_get_functiondef(f.oid);
    IF v_def LIKE '%pluxee%' THEN CONTINUE; END IF;
    v_novo := replace(v_def, p_velho, p_novo);
    IF v_novo = v_def THEN
      RAISE EXCEPTION 'migração 0388: não achei o trecho "%" em %', p_velho, p_nome;
    END IF;
    EXECUTE v_novo;
  END LOOP;
END $$;

-- pagamento dividido do pedido
SELECT pg_temp.patch_fn('validar_pagamentos_pedido',
  $q$'vale','outro'$q$,
  $q$'vale','pluxee','alelo','vr','ticket','outro'$q$);

-- fechar a conta da mesa/balcão: forma conhecida é gravada como ela mesma
SELECT pg_temp.patch_fn('fechar_conta_presencial_interno',
  $q$IN ('dinheiro','pix','cartao','credito','debito','transferencia','cashback')$q$,
  $q$IN ('dinheiro','pix','cartao','credito','debito','transferencia','cashback','pluxee','alelo','vr','ticket')$q$);

-- corrigir a forma de uma conta já fechada
SELECT pg_temp.patch_fn('alterar_forma_pagamento_comanda',
  $q$('dinheiro','pix','cartao','credito','debito','fiado')$q$,
  $q$('dinheiro','pix','cartao','credito','debito','fiado','pluxee','alelo','vr','ticket')$q$);

-- acerto do motoboy: vale passa na maquininha dele, igual ao cartão
SELECT pg_temp.patch_fn('entregadores_resumo',
  $q$f IN ('cartao', 'cartão', 'credito', 'debito')$q$,
  $q$f IN ('cartao', 'cartão', 'credito', 'debito', 'pluxee', 'alelo', 'vr', 'ticket')$q$);

-- 3) Caixa: os vales ganham o próprio balde (não se misturam com cartão, que tem
-- taxa de maquineta própria, nem caem em "outros").
CREATE OR REPLACE VIEW caixa_delivery_partes AS
 SELECT d.caixa_id,
    d.id AS pedido_id,
    x.bucket,
    x.valor,
    d.numero_pedido,
    d.origem,
    d.cliente_nome,
    d.created_at,
    d.forma_pagamento,
    d.empresa_id,
    (d.created_at AT TIME ZONE 'America/Fortaleza'::text)::date AS dia
   FROM pedidos_delivery d
     CROSS JOIN LATERAL ( SELECT
                CASE
                    WHEN d.origem = 'ifood'::text AND (COALESCE(d.ifood_valores ->> 'pago_online'::text, ''::text) = 'true'::text OR f.forma = 'online'::text) THEN 'ifood'::text
                    WHEN f.forma = 'online'::text THEN 'online'::text
                    WHEN f.forma = 'pix'::text AND d.mp_payment_status = 'approved'::text THEN 'online'::text
                    WHEN f.forma = 'dinheiro'::text THEN 'dinheiro'::text
                    WHEN f.forma = ANY (ARRAY['pix'::text, 'pix_entrega'::text]) THEN 'pix'::text
                    WHEN f.forma = 'credito'::text THEN 'credito'::text
                    WHEN f.forma = 'debito'::text THEN 'debito'::text
                    WHEN f.forma = 'cartao'::text THEN 'cartao'::text
                    WHEN f.forma = ANY (ARRAY['pluxee'::text, 'alelo'::text, 'vr'::text, 'ticket'::text]) THEN 'vale'::text
                    ELSE 'outros'::text
                END AS bucket,
            f.valor
           FROM ( SELECT p.value ->> 'forma'::text AS forma,
                    (p.value ->> 'valor'::text)::numeric AS valor
                   FROM jsonb_array_elements(d.pagamentos) p(value)
                  WHERE d.forma_pagamento = 'dividido'::text AND jsonb_typeof(d.pagamentos) = 'array'::text
                UNION ALL
                 SELECT d.forma_pagamento,
                    d.total
                  WHERE d.forma_pagamento IS DISTINCT FROM 'dividido'::text OR jsonb_typeof(d.pagamentos) IS DISTINCT FROM 'array'::text) f) x
  WHERE d.empresa_id = current_empresa_id() AND (d.status <> ALL (ARRAY['cancelado'::text, 'aguardando'::text, 'aguardando_pagamento'::text])) AND COALESCE(d.forma_pagamento, ''::text) <> 'fiado'::text;

-- O resumo do dia ganha duas colunas no fim: vales recebidos na mesa/balcão e no
-- delivery. Mudar o tipo de retorno exige recriar a função.
DROP FUNCTION IF EXISTS caixa_resumo_do_dia(date);
CREATE FUNCTION caixa_resumo_do_dia(p_data date)
 RETURNS TABLE(dia date, vendas_a_vista numeric, vendas_fiado numeric, vendas_boleto numeric, recebimentos_dinheiro numeric, recebimentos_pix numeric, recebimentos_transferencia numeric, recebimentos_cartao numeric, total_sangrias numeric, total_suprimentos numeric, total_sangrias_dinheiro numeric, total_sangrias_pix numeric, total_suprimentos_dinheiro numeric, total_suprimentos_pix numeric, recebimentos_fiado numeric, recebimentos_fiado_dinheiro numeric, recebimentos_fiado_pix numeric, recebimentos_fiado_cartao numeric, recebimentos_fiado_transferencia numeric, recebimentos_credito numeric, recebimentos_debito numeric, recebimentos_cartao_generico numeric, recebimentos_fiado_credito numeric, recebimentos_fiado_debito numeric, total_sangrias_cartao numeric, total_suprimentos_cartao numeric, recebimentos_cashback numeric, delivery_pedidos bigint, delivery_dinheiro numeric, delivery_pix numeric, delivery_cartao numeric, delivery_online numeric, delivery_ifood numeric, delivery_outros numeric, delivery_credito numeric, delivery_debito numeric, delivery_cartao_generico numeric, recebimentos_vale numeric, delivery_vale numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with emp as (select current_empresa_id() as id),
  dia_v as (
    select
      sum(v.total) filter (where v.forma_pagamento = 'a_vista')    as a_vista,
      sum(v.total) filter (where v.forma_pagamento = 'fiado')      as fiado,
      sum(v.total) filter (where v.forma_pagamento like 'boleto%') as boleto
    from vendas v, emp
    where v.empresa_id = emp.id
      and v.status <> 'cancelado'
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
      sum(valor) filter (where forma_pagamento in ('pluxee','alelo','vr','ticket')) as vale,
      sum(valor) filter (where fi)                                as fi_tot,
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
      sum(valor) filter (where bucket = 'outros')      as outros,
      sum(valor) filter (where bucket = 'vale')        as vale
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
    coalesce(dia_d.cartao_gen,0),
    coalesce(dia_p.vale,0), coalesce(dia_d.vale,0)
  from dia_v, dia_p, dia_m, dia_d;
$function$;

-- 4) A Agv liga as quatro. As outras lojas continuam como estavam.
UPDATE empresas
   SET formas_pagamento = (
         SELECT to_jsonb(array_agg(DISTINCT v))
           FROM unnest(
                  ARRAY(SELECT jsonb_array_elements_text(COALESCE(formas_pagamento, '[]'::jsonb)))
                  || ARRAY['pluxee','alelo','vr','ticket']
                ) AS v)
 WHERE id = 'febc3db3-1b04-4cdc-a22f-119db381fbeb';
