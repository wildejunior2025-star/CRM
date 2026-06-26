-- =========================================================
-- 0058: % de comissão do garçom sobre o valor entregue
-- =========================================================
-- O dono da loja define uma porcentagem; o ranking de entregas calcula
-- quanto pagar a cada garçom sobre o valor que ele entregou.
-- =========================================================
ALTER TABLE empresas ADD COLUMN IF NOT EXISTS comissao_garcom_pct numeric NOT NULL DEFAULT 0;
