-- Conserta a view caixa_resumo, que inflava sangrias, suprimentos e recebimentos.
--
-- A versão antiga fazia LEFT JOIN de vendas × pagamentos × caixa_movimentos no
-- mesmo FROM e depois SUM. Isso é um PRODUTO CARTESIANO: com 3 vendas, 1 pagamento
-- e 1 sangria, o caixa vira 3 linhas, e cada sangria/pagamento é somada 3×.
-- Ex. real: sangria de R$30 aparecia R$90; cartão de R$14 aparecia R$42.
-- As vendas só não inflavam por sorte (1 pagamento e 1 movimento no caixa) — com
-- 2 pagamentos elas dobrariam também.
--
-- Correção: cada tabela é agregada num LATERAL isolado por caixa, então não há
-- cruzamento entre elas. Mesmas colunas, mesma ordem, mesma security_invoker.

CREATE OR REPLACE VIEW public.caixa_resumo
WITH (security_invoker = on) AS
SELECT c.id AS caixa_id,
    COALESCE(ve.vendas_a_vista, 0)            AS vendas_a_vista,
    COALESCE(ve.vendas_fiado, 0)             AS vendas_fiado,
    COALESCE(ve.vendas_boleto, 0)            AS vendas_boleto,
    COALESCE(pg.recebimentos_dinheiro, 0)     AS recebimentos_dinheiro,
    COALESCE(pg.recebimentos_pix, 0)          AS recebimentos_pix,
    COALESCE(pg.recebimentos_transferencia, 0) AS recebimentos_transferencia,
    COALESCE(pg.recebimentos_cartao, 0)       AS recebimentos_cartao,
    COALESCE(mv.total_sangrias, 0)            AS total_sangrias,
    COALESCE(mv.total_suprimentos, 0)         AS total_suprimentos
FROM caixas c
LEFT JOIN LATERAL (
  SELECT
    sum(total) FILTER (WHERE forma_pagamento = 'a_vista' AND status <> 'cancelado') AS vendas_a_vista,
    sum(total) FILTER (WHERE forma_pagamento = 'fiado'   AND status <> 'cancelado') AS vendas_fiado,
    sum(total) FILTER (WHERE forma_pagamento LIKE 'boleto%' AND status <> 'cancelado') AS vendas_boleto
  FROM vendas WHERE caixa_id = c.id
) ve ON true
LEFT JOIN LATERAL (
  SELECT
    sum(valor) FILTER (WHERE forma_pagamento = 'dinheiro')      AS recebimentos_dinheiro,
    sum(valor) FILTER (WHERE forma_pagamento = 'pix')           AS recebimentos_pix,
    sum(valor) FILTER (WHERE forma_pagamento = 'transferencia') AS recebimentos_transferencia,
    sum(valor) FILTER (WHERE forma_pagamento = 'cartao')        AS recebimentos_cartao
  FROM pagamentos WHERE caixa_id = c.id
) pg ON true
LEFT JOIN LATERAL (
  SELECT
    sum(valor) FILTER (WHERE tipo = 'sangria')    AS total_sangrias,
    sum(valor) FILTER (WHERE tipo = 'suprimento') AS total_suprimentos
  FROM caixa_movimentos WHERE caixa_id = c.id
) mv ON true
WHERE c.empresa_id = current_empresa_id();
