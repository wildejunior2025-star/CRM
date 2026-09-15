-- 0274_pagamento_dividido_delivery.sql
-- Pedido de delivery pago com DUAS formas (ex.: parte no dinheiro, parte no PIX).
--
-- Até aqui o pedido tinha uma forma só (`forma_pagamento`). O salão já dividia a
-- conta (mig 0054), o delivery não: o cliente que queria "30 no dinheiro e 20 no
-- PIX" escrevia isso na observação, e o motoqueiro cobrava o total no dinheiro.
--
-- `pagamentos` guarda as partes: [{"forma":"dinheiro","valor":30,"troco_para":50},
-- {"forma":"pix","valor":20}]. NULL = pedido de uma forma só, exatamente como
-- sempre (os 1.100+ pedidos por mês não mudam em nada). Com partes,
-- `forma_pagamento` vira 'dividido' — assim nenhuma tela antiga mostra UMA forma
-- como se fosse o pedido inteiro.

ALTER TABLE public.pedidos_delivery ADD COLUMN IF NOT EXISTS pagamentos jsonb;

COMMENT ON COLUMN public.pedidos_delivery.pagamentos IS
  'Partes do pagamento quando o cliente paga com mais de uma forma: [{forma, valor, troco_para?}]. NULL = forma única (forma_pagamento). Mig 0274.';

ALTER TABLE public.pedidos_delivery DROP CONSTRAINT IF EXISTS pedidos_delivery_forma_pagamento_check;
ALTER TABLE public.pedidos_delivery ADD CONSTRAINT pedidos_delivery_forma_pagamento_check
  CHECK (forma_pagamento = ANY (ARRAY['pix','pix_entrega','dinheiro','credito','debito','cartao','online','vale','outro','dividido']));

-- ── Guarda das partes ─────────────────────────────────────────────────────────
-- Roda DEPOIS dos gatilhos que mexem no total (cashback e pontos recalculam o
-- total no BEFORE INSERT; o Postgres chama os gatilhos BEFORE em ordem
-- alfabética, e "trg_validar" vem depois de "trg_cashback"/"trg_resgate").
--
-- Quando o total muda depois do pedido feito (cashback no insert, alteração de
-- itens no gestor), a diferença vai pra parte que é COBRADA NA ENTREGA — nunca
-- pro PIX online, que já tem valor fechado no QR. Recusar o pedido ali seria
-- pior: o cliente já fechou e a alteração já foi aceita.
CREATE OR REPLACE FUNCTION public.validar_pagamentos_pedido()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_partes  jsonb;
  v_soma    numeric;
  v_dif     numeric;
  v_idx     integer;
  v_novo    numeric;
  v_n       integer;
BEGIN
  -- Trocou pra UMA forma (ex.: "trocar forma" no gestor) sem mexer nas partes:
  -- as partes antigas deixam de valer.
  IF TG_OP = 'UPDATE'
     AND OLD.forma_pagamento = 'dividido'
     AND NEW.forma_pagamento IS DISTINCT FROM 'dividido'
     AND NEW.pagamentos IS NOT DISTINCT FROM OLD.pagamentos THEN
    NEW.pagamentos := NULL;
    RETURN NEW;
  END IF;

  IF NEW.pagamentos IS NULL OR NEW.pagamentos = 'null'::jsonb THEN
    NEW.pagamentos := NULL;
    IF NEW.forma_pagamento = 'dividido' THEN
      RAISE EXCEPTION 'Pagamento dividido sem as partes.';
    END IF;
    RETURN NEW;
  END IF;

  IF jsonb_typeof(NEW.pagamentos) <> 'array' THEN
    RAISE EXCEPTION 'Partes do pagamento em formato inválido.';
  END IF;

  -- Normaliza: só forma, valor (2 casas) e troco.
  SELECT jsonb_agg(
           jsonb_strip_nulls(jsonb_build_object(
             'forma', x->>'forma',
             'valor', round(COALESCE(NULLIF(x->>'valor', '')::numeric, 0), 2),
             'troco_para', CASE WHEN x->>'forma' = 'dinheiro' AND NULLIF(x->>'troco_para', '') IS NOT NULL
                                THEN round((x->>'troco_para')::numeric, 2) END
           )) ORDER BY ord)
    INTO v_partes
    FROM jsonb_array_elements(NEW.pagamentos) WITH ORDINALITY AS t(x, ord);

  v_n := jsonb_array_length(v_partes);
  IF v_n < 2 THEN
    RAISE EXCEPTION 'Pagamento dividido precisa de pelo menos duas formas.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_partes) x
     WHERE NOT (x->>'forma' = ANY (ARRAY['pix','pix_entrega','dinheiro','credito','debito','cartao','vale','outro']))
  ) THEN
    RAISE EXCEPTION 'Forma de pagamento inválida numa das partes.';
  END IF;

  IF (SELECT count(*) FROM jsonb_array_elements(v_partes) x WHERE x->>'forma' = 'pix') > 1 THEN
    RAISE EXCEPTION 'Só dá pra ter um PIX online no pedido.';
  END IF;

  SELECT COALESCE(sum((x->>'valor')::numeric), 0) INTO v_soma FROM jsonb_array_elements(v_partes) x;
  v_dif := round(COALESCE(NEW.total, 0) - v_soma, 2);

  IF abs(v_dif) > 0.009 THEN
    -- Qual parte absorve: dinheiro primeiro (é a que o motoqueiro conta na mão),
    -- depois qualquer uma cobrada na entrega. PIX online nunca.
    SELECT ord - 1 INTO v_idx
      FROM jsonb_array_elements(v_partes) WITH ORDINALITY AS t(x, ord)
     WHERE x->>'forma' <> 'pix'
     ORDER BY (x->>'forma' = 'dinheiro') DESC, ord DESC
     LIMIT 1;
    IF v_idx IS NULL THEN
      RAISE EXCEPTION 'A soma das formas (R$ %) não bate com o total (R$ %).', v_soma, NEW.total;
    END IF;
    v_novo := round((v_partes->v_idx->>'valor')::numeric + v_dif, 2);
    IF v_novo <= 0 THEN
      RAISE EXCEPTION 'A soma das formas (R$ %) não bate com o total (R$ %).', v_soma, NEW.total;
    END IF;
    v_partes := jsonb_set(v_partes, ARRAY[v_idx::text, 'valor'], to_jsonb(v_novo));
  END IF;

  IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_partes) x WHERE (x->>'valor')::numeric <= 0) THEN
    RAISE EXCEPTION 'Toda parte do pagamento precisa ter valor.';
  END IF;

  NEW.pagamentos := v_partes;
  NEW.forma_pagamento := 'dividido';
  -- O troco do pedido é o da parte em dinheiro (as telas antigas leem troco_para).
  NEW.troco_para := (SELECT (x->>'troco_para')::numeric FROM jsonb_array_elements(v_partes) x
                      WHERE x->>'forma' = 'dinheiro' LIMIT 1);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_validar_pagamentos ON public.pedidos_delivery;
CREATE TRIGGER trg_validar_pagamentos
  BEFORE INSERT OR UPDATE OF pagamentos, total, forma_pagamento ON public.pedidos_delivery
  FOR EACH ROW EXECUTE FUNCTION public.validar_pagamentos_pedido();

-- ── Acerto do entregador por PARTE ────────────────────────────────────────────
-- Antes cada pedido caía inteiro num balde (dinheiro/cartão/pix/na conta). Com o
-- pagamento dividido, só a parte em dinheiro é dinheiro na mão do motoqueiro —
-- o resto vai pro balde da sua forma.
CREATE OR REPLACE FUNCTION public.entregadores_resumo(p_empresa_id uuid, p_desde timestamp with time zone DEFAULT NULL::timestamp with time zone, p_ate timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS TABLE(entregador_id uuid, nome text, ativo boolean, corridas bigint, corridas_pendentes bigint, valor_pendente numeric, valor_pago numeric, repasse_dinheiro numeric, repasse_cartao numeric, repasse_pix numeric, recebido_periodo numeric, em_andamento bigint, valor_em_andamento numeric, ultima_corrida timestamp with time zone)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  WITH ped AS (
    SELECT
      pd.entregador_id,
      COALESCE(pd.entregador_pago, false) AS pago,
      pd.status = 'entregue' AS concluida,
      GREATEST(0, COALESCE(pd.taxa_entrega, 0) - desconto_entrega(
        pd.origem, pd.taxa_entrega,
        pr.entregador_desconto_ativo,      pr.entregador_desconto_valor,      pr.entregador_desconto_tipo,
        pr.entregador_desconto_loja_ativo, pr.entregador_desconto_loja_valor, pr.entregador_desconto_loja_tipo)) AS ganho,
      pd.created_at,
      partes.dinheiro, partes.cartao, partes.pix
    FROM pedidos_delivery pd
    JOIN profiles pr ON pr.id = pd.entregador_id
    CROSS JOIN LATERAL (
      SELECT
        COALESCE(sum(v) FILTER (WHERE f = 'dinheiro'), 0) AS dinheiro,
        COALESCE(sum(v) FILTER (WHERE f IN ('cartao', 'cartão', 'credito', 'debito')), 0) AS cartao,
        COALESCE(sum(v) FILTER (WHERE f = 'pix'
          AND pd.pix_status IS DISTINCT FROM 'pago'
          AND pd.mp_payment_status IS DISTINCT FROM 'approved'), 0) AS pix
      FROM (
        SELECT x->>'forma' AS f, (x->>'valor')::numeric AS v
          FROM jsonb_array_elements(pd.pagamentos) x
         WHERE pd.pagamentos IS NOT NULL
        UNION ALL
        SELECT pd.forma_pagamento, COALESCE(pd.total, 0)
         WHERE pd.pagamentos IS NULL
      ) s
    ) partes
    WHERE pd.empresa_id = p_empresa_id
      AND pd.status <> 'cancelado'
      AND pd.entregador_id IS NOT NULL
      AND (p_desde IS NULL OR pd.created_at >= p_desde)
      AND (p_ate IS NULL OR pd.created_at <= p_ate)
  )
  SELECT
    pr.id,
    pr.nome,
    COALESCE(pr.ativo, false),
    count(p.entregador_id),
    count(p.entregador_id) FILTER (WHERE NOT p.pago AND p.concluida),
    COALESCE(sum(p.ganho) FILTER (WHERE NOT p.pago AND p.concluida), 0),
    COALESCE(sum(p.ganho) FILTER (WHERE p.pago), 0),
    COALESCE(sum(p.dinheiro) FILTER (WHERE NOT p.pago AND p.concluida), 0),
    COALESCE(sum(p.cartao) FILTER (WHERE NOT p.pago AND p.concluida), 0),
    COALESCE(sum(p.pix) FILTER (WHERE NOT p.pago AND p.concluida), 0),
    COALESCE(sum(p.dinheiro + p.cartao + p.pix) FILTER (WHERE p.concluida), 0),
    count(p.entregador_id) FILTER (WHERE NOT p.concluida),
    COALESCE(sum(p.ganho) FILTER (WHERE NOT p.concluida), 0),
    max(p.created_at)
  FROM profiles pr
  LEFT JOIN ped p ON p.entregador_id = pr.id
  WHERE pr.empresa_id = p_empresa_id
    AND pr.perfil = 'entregador'
  GROUP BY pr.id, pr.nome, pr.ativo
  HAVING COALESCE(pr.ativo, false) OR count(p.entregador_id) > 0
  ORDER BY 6 DESC, 4 DESC, pr.nome;
$function$;
