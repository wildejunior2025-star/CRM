-- =========================================================
-- 0060: Meta de faturamento mensal da loja
-- =========================================================
-- O dono define uma meta mensal; a Dashboard mostra a barra de progresso.
-- =========================================================
ALTER TABLE empresas ADD COLUMN IF NOT EXISTS meta_faturamento_mensal numeric NOT NULL DEFAULT 0;
