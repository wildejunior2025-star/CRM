-- =========================================================
-- Migration 0255 - Desconto por entrega separado: iFood x loja
-- =========================================================
-- A loja fica com um valor de cada corrida do motoqueiro. Até aqui isso só valia
-- nas corridas do iFood — e tem loja que quer o contrário: a CD Bom não tem iFood
-- e quer o desconto nas corridas do próprio delivery; o Zebu quer só no iFood.
--
-- Por isso são DOIS valores independentes, não um interruptor. Quem já usava
-- continua igual: o campo do iFood não foi tocado e o da loja nasce desligado.
--
-- ATENÇÃO ao mexer aqui: entregadores_resumo e entregadores_acertos foram
-- recriadas a partir do que estava NO BANCO (com em_andamento e status <>
-- 'cancelado'), não do que estava nos arquivos 0122/0123/0124 — esses ficaram
-- para trás. Só a conta do desconto mudou.
-- =========================================================

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS entregador_desconto_loja_ativo boolean       NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS entregador_desconto_loja_valor numeric(10,2) NOT NULL DEFAULT 0;

-- A regra num lugar só: pedido do iFood usa o valor do iFood, todo o resto
-- (app, loja online, WhatsApp, balcão) usa o valor da loja.
CREATE OR REPLACE FUNCTION public.desconto_entrega(
  p_origem      text,
  p_ifood_ativo boolean, p_ifood_valor numeric,
  p_loja_ativo  boolean, p_loja_valor  numeric
) RETURNS numeric
LANGUAGE sql IMMUTABLE
AS $$
  SELECT CASE
    WHEN p_origem = 'ifood' THEN
      CASE WHEN COALESCE(p_ifood_ativo, false) AND COALESCE(p_ifood_valor, 0) > 0
           THEN p_ifood_valor ELSE 0 END
    ELSE
      CASE WHEN COALESCE(p_loja_ativo, false) AND COALESCE(p_loja_valor, 0) > 0
           THEN p_loja_valor ELSE 0 END
  END;
$$;

GRANT EXECUTE ON FUNCTION public.desconto_entrega(text, boolean, numeric, boolean, numeric) TO authenticated;

-- ---------------------------------------------------------
-- Resumo por entregador (tela Entregadores)
-- ---------------------------------------------------------
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
        pd.origem,
        pr.entregador_desconto_ativo,      pr.entregador_desconto_valor,
        pr.entregador_desconto_loja_ativo, pr.entregador_desconto_loja_valor)) AS ganho,
      COALESCE(pd.total, 0) AS total,
      pd.created_at,
      CASE
        WHEN pd.forma_pagamento = 'dinheiro' THEN 'dinheiro'
        WHEN pd.forma_pagamento IN ('cartao', 'cartão', 'credito', 'debito') THEN 'cartao'
        WHEN pd.forma_pagamento = 'pix'
         AND pd.pix_status IS DISTINCT FROM 'pago'
         AND pd.mp_payment_status IS DISTINCT FROM 'approved' THEN 'pix'
        ELSE 'na_conta'
      END AS cobranca
    FROM pedidos_delivery pd
    JOIN profiles pr ON pr.id = pd.entregador_id
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
    COALESCE(sum(p.total) FILTER (WHERE NOT p.pago AND p.concluida AND p.cobranca = 'dinheiro'), 0),
    COALESCE(sum(p.total) FILTER (WHERE NOT p.pago AND p.concluida AND p.cobranca = 'cartao'), 0),
    COALESCE(sum(p.total) FILTER (WHERE NOT p.pago AND p.concluida AND p.cobranca = 'pix'), 0),
    COALESCE(sum(p.total) FILTER (WHERE p.concluida AND p.cobranca <> 'na_conta'), 0),
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

-- ---------------------------------------------------------
-- Acertos já pagos (recibo de cada acerto)
-- ---------------------------------------------------------
CREATE OR REPLACE FUNCTION public.entregadores_acertos(p_empresa_id uuid, p_desde timestamp with time zone DEFAULT NULL::timestamp with time zone, p_ate timestamp with time zone DEFAULT NULL::timestamp with time zone, p_entregador uuid DEFAULT NULL::uuid)
 RETURNS TABLE(entregador_id uuid, nome text, pago_em timestamp with time zone, corridas bigint, valor numeric, primeira timestamp with time zone, ultima timestamp with time zone)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  SELECT
    pd.entregador_id,
    pr.nome,
    date_trunc('minute', pd.entregador_pago_em) AS pago_em,
    count(*),
    COALESCE(sum(GREATEST(0, COALESCE(pd.taxa_entrega, 0) - desconto_entrega(
      pd.origem,
      pr.entregador_desconto_ativo,      pr.entregador_desconto_valor,
      pr.entregador_desconto_loja_ativo, pr.entregador_desconto_loja_valor))), 0),
    min(pd.created_at),
    max(pd.created_at)
  FROM pedidos_delivery pd
  JOIN profiles pr ON pr.id = pd.entregador_id
  WHERE pd.empresa_id = p_empresa_id
    AND pd.status <> 'cancelado'
    AND COALESCE(pd.entregador_pago, false)
    AND pd.entregador_pago_em IS NOT NULL
    AND (p_entregador IS NULL OR pd.entregador_id = p_entregador)
    AND (p_desde IS NULL OR pd.entregador_pago_em >= p_desde)
    AND (p_ate IS NULL OR pd.entregador_pago_em <= p_ate)
  GROUP BY pd.entregador_id, pr.nome, date_trunc('minute', pd.entregador_pago_em)
  ORDER BY 3 DESC;
$function$;
