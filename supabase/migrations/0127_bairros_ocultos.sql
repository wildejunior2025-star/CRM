-- =========================================================
-- 0127: Bairros escondidos da lista de taxa por bairro
-- =========================================================
-- A lista de bairros é montada a partir dos pedidos antigos, então vem cheia de
-- grafia repetida e bairro que a loja nem atende ("São gonçalo" além de "São
-- Gonçalo do Amarante", "Nossa Sra. da Apresentação" além de "Nossa Senhora da
-- Apresentação"...). Sem um jeito de tirar, a lista só cresce.
--
-- Guarda os nomes JÁ NORMALIZADOS (sem acento, minúsculo) — é assim que o front
-- compara bairro de pedido com bairro configurado.
--
-- Coluna separada de propósito: `taxas_entrega_bairro` é lida pelo checkout e
-- pelo bot, e lá dentro qualquer entrada com entrega != false vira taxa fixa.
-- Um "oculto" ali viraria entrega de graça.
-- =========================================================

ALTER TABLE empresas
  ADD COLUMN IF NOT EXISTS bairros_ocultos jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN empresas.bairros_ocultos IS
  'Bairros (normalizados) que a loja tirou da lista de sugestões da tela Raio de Entrega.';
