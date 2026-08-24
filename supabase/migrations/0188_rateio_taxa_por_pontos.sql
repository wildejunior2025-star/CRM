-- 0188_rateio_taxa_por_pontos.sql
-- Rateio da taxa de serviço por pontos.
--
-- A comissão anterior era um % por garçom sobre o que ele entregou: sem teto e
-- sem relação com o que a loja arrecadou. A loja podia pagar mais comissão do
-- que recebeu de taxa e só descobrir no fim do mês.
--
-- Modelo novo (desenhado pelo Wilde): a loja separa uma fatia da TAXA DE SERVIÇO
-- arrecadada e essa fatia é o BOLO do dia. Os pontos não criam dinheiro — eles
-- só decidem como o bolo é dividido:
--
--   bolo         = taxa arrecadada × rateio_taxa_pct
--   valor/ponto  = bolo / pontos de TODOS os garçons
--   ganho de um  = pontos dele × valor/ponto
--
-- Ex.: loja cobra 10% e repassa 20% da taxa. Vendeu 1.000 → taxa 100 → bolo 20.
-- 200 pontos no total → R$ 0,10 por ponto. Quem fez 78 pontos leva R$ 7,80.
--
-- O bolo nunca estoura: se todo mundo trabalhar mais, o ponto vale menos e a
-- loja paga o mesmo. E dia fraco paga menos, automaticamente.

ALTER TABLE public.empresas
  ADD COLUMN IF NOT EXISTS rateio_taxa_pct numeric NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.empresas.rateio_taxa_pct IS
  'Quanto da taxa de serviço arrecadada vira o bolo dos garçons, em % (0 = não usa). Dividido entre eles por pontos (mig 0188).';
