-- 0323 — CÓDIGO DE COLETA DO IFOOD
--
-- É o código de 4 dígitos que o entregador do iFood FALA quando chega na loja
-- pra buscar o pedido. A loja digita e valida. Não confundir com o que já
-- existe aqui:
--
--   ifood_codigo_entrega  -> código do CLIENTE, na porta dele (evento DDCR)
--   ifood_codigo_coleta   -> código do ENTREGADOR, no balcão da loja  <-- este
--
-- Digitar não é obrigatório pro iFood: o entregador leva a sacola de todo jeito.
-- Serve de PROVA. Se depois alguém disser que o pedido não foi retirado na loja,
-- a validação registrada no iFood mostra que foi entregue ao entregador certo.
--
-- Só existe quando a entrega é do iFood (deliveredBy = IFOOD). Em entrega com
-- motoboy da própria loja não há código nenhum — quem busca é o funcionário.

alter table pedidos_delivery
  add column if not exists ifood_codigo_coleta text,
  add column if not exists ifood_coleta_validada_at timestamptz;

comment on column pedidos_delivery.ifood_codigo_coleta is
  'Código que o entregador do iFood fala ao buscar o pedido na loja (pickupCode). Só em deliveredBy=IFOOD.';
comment on column pedidos_delivery.ifood_coleta_validada_at is
  'Quando a loja validou o código de coleta no iFood. Null = não validou (não é obrigatório).';
