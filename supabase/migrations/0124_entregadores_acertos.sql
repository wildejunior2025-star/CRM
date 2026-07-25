-- Histórico de pagamentos aos entregadores.
--
-- Não criei tabela nova de propósito: a hora do acerto já fica em
-- pedidos_delivery.entregador_pago_em. Aqui as corridas pagas são agrupadas por
-- entregador + minuto do pagamento, então cada "Acertar tudo" (que grava a mesma
-- hora em todas as corridas) vira uma linha do histórico, e pagamentos avulsos
-- feitos em sequência entram juntos no mesmo acerto.
--
-- Vantagem de derivar em vez de guardar: nunca diverge do que foi realmente pago,
-- e o histórico já nasce com tudo que foi acertado antes desta tela existir.

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
    AND pd.status = 'entregue'
    AND COALESCE(pd.entregador_pago, false)
    AND pd.entregador_pago_em IS NOT NULL
    AND (p_entregador IS NULL OR pd.entregador_id = p_entregador)
    AND (p_desde IS NULL OR pd.entregador_pago_em >= p_desde)
    AND (p_ate IS NULL OR pd.entregador_pago_em <= p_ate)
  GROUP BY pd.entregador_id, pr.nome, date_trunc('minute', pd.entregador_pago_em)
  ORDER BY 3 DESC;
$$;

GRANT EXECUTE ON FUNCTION public.entregadores_acertos(uuid, timestamptz, timestamptz, uuid) TO authenticated;
