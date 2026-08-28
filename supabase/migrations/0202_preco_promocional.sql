-- =========================================================
-- 0202: preço promocional (o de antes riscado, o novo em verde)
-- =========================================================
-- A loja já fazia promoção na arte ("TRIO DE CREMES — PROMOÇÃO R$ 15,00 cada",
-- com os potes cadastrados a R$ 18,00), mas o sistema não tinha onde guardar
-- isso. Baixar o preço no campo resolve a cobrança e perde a venda: o cliente
-- não vê que está levando mais barato, e "R$ 15,00" sozinho não convence
-- ninguém. O que vende é o R$ 18,00 riscado do lado.
--
-- NULL = sem promoção (é o caso de todo produto que já existe).
--
-- Convive com as faixas de atacado (faixas_preco, mig 0201/0200): as duas são
-- desconto, então quem manda é o MENOR preço que valer pra quantidade pedida.
-- Um creme em promoção a R$ 15,00 com faixa 10+ a R$ 12,00 sai a 15 na unidade
-- e a 12 pra quem leva dez.
-- =========================================================

ALTER TABLE public.produtos
  ADD COLUMN IF NOT EXISTS preco_promocional numeric(10,2);

COMMENT ON COLUMN public.produtos.preco_promocional IS
  'Preço de promoção. NULL = sem promoção. Menor que preco_venda, que aparece riscado ao lado.';

-- Promoção que não é menor que o preço normal não é promoção — riscaria o valor
-- e mostraria um número igual ou maior do lado, o que só confunde o cliente.
ALTER TABLE public.produtos
  DROP CONSTRAINT IF EXISTS produtos_promocao_menor_que_preco;
ALTER TABLE public.produtos
  ADD CONSTRAINT produtos_promocao_menor_que_preco
  CHECK (preco_promocional IS NULL OR preco_promocional < preco_venda);
