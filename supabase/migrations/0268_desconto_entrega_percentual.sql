-- =========================================================
-- Migration 0268 - Desconto do motoqueiro em R$ OU em %
-- =========================================================
-- Até aqui o desconto por corrida era um valor fixo (a CD Bom fica com R$ 2 de
-- cada entrega). Agora cada um dos dois descontos (iFood e loja) pode ser em
-- porcentagem da TAXA DE ENTREGA daquela corrida: 10% de uma taxa de R$ 8 fica
-- R$ 0,80 com a loja.
--
-- Quem já usava continua igual: o tipo nasce 'valor'.
--
-- entregadores_resumo e entregadores_acertos foram recriadas a partir do que
-- estava NO BANCO em 14/09/2026 (igual à 0255). Só a chamada do desconto mudou.
-- A mesma regra vive em src/lib/descontoEntrega.js. Mexeu aqui, mexa lá.
-- =========================================================

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS entregador_desconto_tipo      text NOT NULL DEFAULT 'valor',
  ADD COLUMN IF NOT EXISTS entregador_desconto_loja_tipo text NOT NULL DEFAULT 'valor';

ALTER TABLE profiles DROP CONSTRAINT IF EXISTS profiles_entregador_desconto_tipo_ck;
ALTER TABLE profiles ADD CONSTRAINT profiles_entregador_desconto_tipo_ck
  CHECK (entregador_desconto_tipo IN ('valor', 'percentual')
     AND entregador_desconto_loja_tipo IN ('valor', 'percentual'));

-- A regra num lugar só. Porcentagem é da taxa de entrega, arredondada no
-- centavo, e nunca passa de 100%.
CREATE OR REPLACE FUNCTION public.desconto_entrega(
  p_origem      text,
  p_taxa        numeric,
  p_ifood_ativo boolean, p_ifood_valor numeric, p_ifood_tipo text,
  p_loja_ativo  boolean, p_loja_valor  numeric, p_loja_tipo  text
) RETURNS numeric
LANGUAGE sql IMMUTABLE
AS $$
  WITH escolhido AS (
    SELECT
      CASE WHEN p_origem = 'ifood' THEN COALESCE(p_ifood_ativo, false) ELSE COALESCE(p_loja_ativo, false) END AS ativo,
      CASE WHEN p_origem = 'ifood' THEN COALESCE(p_ifood_valor, 0)     ELSE COALESCE(p_loja_valor, 0)     END AS valor,
      CASE WHEN p_origem = 'ifood' THEN p_ifood_tipo                   ELSE p_loja_tipo                   END AS tipo
  )
  SELECT CASE
    WHEN NOT ativo OR valor <= 0 THEN 0
    WHEN tipo = 'percentual' THEN round(COALESCE(p_taxa, 0) * LEAST(valor, 100) / 100, 2)
    ELSE valor
  END
  FROM escolhido;
$$;

GRANT EXECUTE ON FUNCTION public.desconto_entrega(text, numeric, boolean, numeric, text, boolean, numeric, text) TO authenticated;

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
        pd.origem, pd.taxa_entrega,
        pr.entregador_desconto_ativo,      pr.entregador_desconto_valor,      pr.entregador_desconto_tipo,
        pr.entregador_desconto_loja_ativo, pr.entregador_desconto_loja_valor, pr.entregador_desconto_loja_tipo)) AS ganho,
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
      pd.origem, pd.taxa_entrega,
      pr.entregador_desconto_ativo,      pr.entregador_desconto_valor,      pr.entregador_desconto_tipo,
      pr.entregador_desconto_loja_ativo, pr.entregador_desconto_loja_valor, pr.entregador_desconto_loja_tipo))), 0),
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

-- A versão antiga (só valor fixo) não é mais chamada por ninguém.
DROP FUNCTION IF EXISTS public.desconto_entrega(text, boolean, numeric, boolean, numeric);
