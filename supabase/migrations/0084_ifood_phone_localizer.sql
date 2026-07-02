-- =========================================================
-- 0084: Guardar o ID/Localizador do telefone do iFood
-- =========================================================
-- F2 — o iFood não passa o número real do cliente (privacidade). Ele dá um 0800
-- (phone.number) + um ID (phone.localizer) que o entregador digita ao ligar.
-- Guardamos o localizer pra mostrar no app do motoqueiro.
-- =========================================================

ALTER TABLE pedidos_delivery
  ADD COLUMN IF NOT EXISTS ifood_phone_localizer text;
