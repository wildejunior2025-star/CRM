-- Resumo por entregador (tela Entregadores).
--
-- A tela puxava TODOS os pedidos entregues (.limit(2000)) e contava no navegador.
-- O PostgREST corta em 1000 linhas por request, então lojas movimentadas viam
-- números MENORES que o real (ex.: DANIEL aparecia com 366 corridas tendo 406) e,
-- pior, corridas antigas ainda não acertadas sumiam do "a pagar".
--
-- Aqui a conta é feita no banco, uma linha por entregador:
--   - ganho da corrida = taxa_entrega menos o desconto de iFood do entregador
--   - a repassar = dinheiro que o entregador recebeu do cliente na entrega e ainda
--     não acertou com a loja, quebrado por forma de pagamento.
--     PIX confirmado e pedido pago online (iFood) NÃO entram: já caíram na conta.
--
-- Inclui entregador inativo que ainda tenha corrida no período (senão some da tela
-- gente com valor pendente).

CREATE OR REPLACE FUNCTION public.entregadores_resumo(
  p_empresa_id uuid,
  p_desde timestamptz DEFAULT NULL
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
      AND pd.status = 'entregue'
      AND pd.entregador_id IS NOT NULL
      AND (p_desde IS NULL OR pd.created_at >= p_desde)
  )
  SELECT
    pr.id,
    pr.nome,
    COALESCE(pr.ativo, false),
    count(p.entregador_id),
    count(p.entregador_id) FILTER (WHERE NOT p.pago),
    COALESCE(sum(p.ganho) FILTER (WHERE NOT p.pago), 0),
    COALESCE(sum(p.ganho) FILTER (WHERE p.pago), 0),
    COALESCE(sum(p.total) FILTER (WHERE NOT p.pago AND p.cobranca = 'dinheiro'), 0),
    COALESCE(sum(p.total) FILTER (WHERE NOT p.pago AND p.cobranca = 'cartao'), 0),
    COALESCE(sum(p.total) FILTER (WHERE NOT p.pago AND p.cobranca = 'pix'), 0),
    COALESCE(sum(p.total) FILTER (WHERE p.cobranca <> 'na_conta'), 0),
    max(p.created_at)
  FROM profiles pr
  LEFT JOIN ped p ON p.entregador_id = pr.id
  WHERE pr.empresa_id = p_empresa_id
    AND pr.perfil = 'entregador'
  GROUP BY pr.id, pr.nome, pr.ativo
  HAVING COALESCE(pr.ativo, false) OR count(p.entregador_id) > 0
  ORDER BY 6 DESC, 4 DESC, pr.nome;
$$;

GRANT EXECUTE ON FUNCTION public.entregadores_resumo(uuid, timestamptz) TO authenticated;
