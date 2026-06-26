-- =========================================================
-- 0056: Atribuição da ENTREGA por item (não por mesa)
-- =========================================================
-- Em vez de prender um garçom à mesa, cada item registra QUEM o entregou
-- (quem clicou em "Marcar entregue"). Assim qualquer garçom livre pega
-- qualquer prato pronto e leva o crédito da entrega — e dá pra ranquear
-- quem mais entregou.
-- =========================================================
ALTER TABLE comanda_itens ADD COLUMN IF NOT EXISTS entregue_por uuid;
ALTER TABLE comanda_itens ADD COLUMN IF NOT EXISTS entregue_at  timestamptz;
