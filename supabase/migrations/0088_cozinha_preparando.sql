-- =========================================================
-- 0088: Cozinha — "Aceitar" trava o pedido/item na pessoa (G1)
-- =========================================================
-- Antes o KDS só tinha "Pronto". Agora quem clica "Aceitar" fica vinculado ao
-- pedido/item (preparando_por), pra 2 cozinheiros não prepararem o mesmo.
-- Só quem aceitou vê o "Pronto".
-- =========================================================

ALTER TABLE pedidos_delivery
  ADD COLUMN IF NOT EXISTS preparando_por  uuid,
  ADD COLUMN IF NOT EXISTS preparando_nome text,
  ADD COLUMN IF NOT EXISTS preparando_em   timestamptz;

ALTER TABLE comanda_itens
  ADD COLUMN IF NOT EXISTS preparando_por  uuid,
  ADD COLUMN IF NOT EXISTS preparando_nome text,
  ADD COLUMN IF NOT EXISTS preparando_em   timestamptz;
