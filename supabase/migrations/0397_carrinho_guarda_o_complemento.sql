-- ─────────────────────────────────────────────────────────────────────────────
-- 0397 — A sacola do robô passa a guardar o complemento do endereço
--
-- A Victoria escreveu "Rua monsenhor José Paulino 1061, Tirol Ap 1103" e o
-- pedido saiu com bairro "Tirol Ap 1103" e complemento VAZIO: o apartamento
-- estava escrito, o robô leu, e não tinha onde guardar. `pedidos_delivery` e
-- `clientes` já têm a coluna; só a sacola do WhatsApp não tinha, e é por ela
-- que o endereço passa antes de virar pedido.
--
-- O entregador sobe num prédio sem saber o andar. É um dado que o cliente deu
-- e a casa perdeu.
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.whatsapp_carrinho
  add column if not exists endereco_complemento text;
