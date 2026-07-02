-- =========================================================
-- 0085: Código de confirmação de entrega do iFood (verifyDeliveryCode)
-- =========================================================
-- F1 — alguns pedidos de entrega própria do iFood exigem que o entregador
-- digite o CÓDIGO que o cliente informa (evento DELIVERY_DROP_CODE_REQUESTED /
-- code "DDCR"). A gente marca esse pedido e, no app do motoqueiro, o "Entreguei"
-- valida o código via POST /orders/{id}/verifyDeliveryCode -> iFood conclui.
-- =========================================================

ALTER TABLE pedidos_delivery
  ADD COLUMN IF NOT EXISTS ifood_requer_codigo boolean NOT NULL DEFAULT false;
