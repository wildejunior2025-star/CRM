-- =========================================================
-- 0111: Histórico diário guarda a quebra da receita (próprios x iFood)
-- =========================================================
-- Pra tela detalhada do dia (setinha no histórico) mostrar a mesma quebra do
-- card "Lucro real de hoje": próprios e iFood separados.
-- =========================================================

ALTER TABLE public.historico_dia ADD COLUMN IF NOT EXISTS receita_proprios numeric NOT NULL DEFAULT 0;
ALTER TABLE public.historico_dia ADD COLUMN IF NOT EXISTS receita_ifood    numeric NOT NULL DEFAULT 0;
