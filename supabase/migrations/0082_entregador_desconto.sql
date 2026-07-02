-- =========================================================
-- 0082: Desconto opcional da loja por entrega do motoqueiro
-- =========================================================
-- E5 — no cadastro do entregador a loja liga um desconto e define o valor
-- que será descontado dele por CADA entrega concluída (acerto).
-- =========================================================

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS entregador_desconto_ativo boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS entregador_desconto_valor numeric(10,2) NOT NULL DEFAULT 0;
