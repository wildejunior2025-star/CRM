-- =========================================================
-- 0153: taxa da maquineta (cartão) por loja
-- =========================================================
-- O que a maquineta desconta (ex.: 2%) não aparecia em lugar nenhum: o Caixa
-- mostrava o cartão bruto e o dono só descobria o valor real quando o dinheiro
-- caía na conta (Wilde, 10/08/2026).
--
-- Guarda só a porcentagem; o líquido é calculado na hora (bruto − %). Fica em
-- empresas porque é uma configuração da loja, igual às taxas do iFood.
-- =========================================================

ALTER TABLE empresas
  ADD COLUMN IF NOT EXISTS taxa_cartao_pct numeric NOT NULL DEFAULT 0;

COMMENT ON COLUMN empresas.taxa_cartao_pct IS 'Taxa da maquineta em % sobre o que é recebido em cartão (ex.: 2 = 2%).';
