-- O retrato do dia fechado precisa guardar o custo do cashback também.
--
-- Sem esta coluna o "fechar o dia" salvaria o lucro já com o cashback
-- descontado, mas a quebra por linha não teria de onde tirar o valor — e o dia
-- reaberto mostraria custos que não somam o lucro salvo.
ALTER TABLE public.historico_dia
  ADD COLUMN IF NOT EXISTS custo_cashback numeric NOT NULL DEFAULT 0;
