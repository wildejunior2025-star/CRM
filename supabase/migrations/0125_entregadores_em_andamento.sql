-- A corrida entra na tela de Entregadores assim que o motoqueiro PEGA o pedido,
-- não só quando entrega.
--
-- Como funciona no painel do motoqueiro: aceitar grava entregador_id; desistir
-- devolve entregador_id = null; cancelar muda o status pra 'cancelado'. Então
-- basta trocar o filtro de status = 'entregue' por status <> 'cancelado' e o
-- resto se resolve sozinho — largou, sai da lista; cancelou, sai da lista.
--
-- O que NÃO muda: só corrida concluída conta como "a pagar" e como repasse. Uma
-- corrida em andamento ainda não foi entregue e o dinheiro do cliente pode nem
-- ter sido recebido. Ela aparece à parte (em_andamento / valor_em_andamento) pra
-- loja conferir na hora de acertar.

DROP FUNCTION IF EXISTS public.entregadores_resumo(uuid, timestamptz, timestamptz);

CREATE OR REPLACE FUNCTION public.entregadores_resumo(
  p_empresa_id uuid,
  p_desde timestamptz DEFAULT NULL,
  p_ate timestamptz DEFAULT NULL
)
RETURNS TABLE (
  entregador_id       uuid,
  nome                text,
  ativo               boolean,
  corridas            bigint,
  corridas_pendentes  bigint,
  valor_pendente      numeric,
  valor_pago          numeric,
  repasse_dinheiro    numeric,
  repasse_cartao      numeric,
  repasse_pix         numeric,
  recebido_periodo    numeric,
  em_andamento        bigint,
  valor_em_andamento  numeric,
  ultima_corrida      timestamptz
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH ped AS (
    SELECT
      pd.entregador_id,
      COALESCE(pd.entregador_pago, false) AS pago,
      pd.status = 'entregue' AS concluida,
      GREATEST(0, COALESCE(pd.taxa_entrega, 0) - CASE
        WHEN pd.origem = 'ifood'
         AND COALESCE(pr.entregador_desconto_ativo, false)
         AND COALESCE(pr.entregador_desconto_valor, 0) > 0
        THEN pr.entregador_desconto_valor ELSE 0 END) AS ganho,
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
$$;

GRANT EXECUTE ON FUNCTION public.entregadores_resumo(uuid, timestamptz, timestamptz) TO authenticated;

-- O histórico de pagamentos também deixa de exigir status 'entregue': se a loja
-- decidir pagar uma corrida ainda em rota, ela aparece no histórico do mesmo jeito.
CREATE OR REPLACE FUNCTION public.entregadores_acertos(
  p_empresa_id uuid,
  p_desde timestamptz DEFAULT NULL,
  p_ate timestamptz DEFAULT NULL,
  p_entregador uuid DEFAULT NULL
)
RETURNS TABLE (
  entregador_id  uuid,
  nome           text,
  pago_em        timestamptz,
  corridas       bigint,
  valor          numeric,
  primeira       timestamptz,
  ultima         timestamptz
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT
    pd.entregador_id,
    pr.nome,
    date_trunc('minute', pd.entregador_pago_em) AS pago_em,
    count(*),
    COALESCE(sum(GREATEST(0, COALESCE(pd.taxa_entrega, 0) - CASE
      WHEN pd.origem = 'ifood'
       AND COALESCE(pr.entregador_desconto_ativo, false)
       AND COALESCE(pr.entregador_desconto_valor, 0) > 0
      THEN pr.entregador_desconto_valor ELSE 0 END)), 0),
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
$$;
