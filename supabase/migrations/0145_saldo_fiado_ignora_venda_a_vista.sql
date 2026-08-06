-- 0145_saldo_fiado_ignora_venda_a_vista.sql
-- A dívida do cliente sumia quando ele TAMBÉM comprava pagando na hora.
--
-- Caso real (Estação do Sabor, 06/08/2026): a Dorinha aparecia no histórico do dia
-- mas não na lista do fiado. O que ela tem:
--   04/08  R$ 93,50  venda À VISTA, paga no PIX
--   05/08  R$ 10,00  fiado
--   06/08  R$ 11,00  fiado
-- Devia R$ 21,00. Mas a view fazia "vendas fiadas − TODOS os pagamentos", e o PIX
-- de R$ 93,50 da mesa dela entrava como se fosse abatimento de dívida:
--   21,00 − 93,50 = −72,50  →  saldo negativo  →  sumia da lista (a `alertas_fiado`
-- só mostra saldo > 0).
--
-- Ou seja: todo cliente que fia E também compra pagando na hora tinha a dívida
-- apagada pelo próprio dinheiro que ele já pagou. Quanto mais ele consome pagando,
-- mais invisível fica o que ele deve. É dinheiro que a loja deixa de cobrar.
--
-- A regra certa: só abate a dívida o pagamento que NÃO é de uma venda à vista.
--   • pagamento ligado a uma venda 'a_vista'  → é o pagamento daquela mesa, não abate
--   • pagamento antigo, sem venda ligada, com observação "Presencial · ..."
--     → é mesa fechada antes da migração 0141 (que passou a gravar venda_id), não abate
--   • o resto (o "Recebimento de fiado" lançado na tela do fiado) → abate, como sempre
--
-- Conferido no banco antes de mexer: hoje só existem esses três tipos de linha em
-- `pagamentos`, então nenhum recebimento de verdade deixa de ser contado.

CREATE OR REPLACE VIEW public.clientes_saldo_fiado
WITH (security_invoker = on) AS
SELECT cliente_id,
       COALESCE(sum(valor), 0::numeric) AS saldo_fiado
FROM (
  -- O que o cliente levou fiado
  SELECT v.cliente_id, v.total AS valor
  FROM vendas v
  WHERE v.forma_pagamento <> 'a_vista' AND v.status <> 'cancelado'

  UNION ALL

  -- O que ele pagou da dívida (só isso abate)
  SELECT p.cliente_id, - p.valor AS valor
  FROM pagamentos p
  LEFT JOIN vendas v ON v.id = p.venda_id
  WHERE COALESCE(v.forma_pagamento, '') <> 'a_vista'
    AND COALESCE(p.observacao, '') NOT LIKE 'Presencial ·%'
) t
GROUP BY cliente_id;
