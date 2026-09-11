-- =========================================================
-- 0258: produto em destaque na Loja Online
-- =========================================================
-- A loja quer vitrine: os mais vendidos, a promoção do dia, lá em cima do
-- cardápio. Quem escolhe é a loja — estrela no cadastro do produto e na aba
-- Catálogo do painel. Na Loja Online eles viram uma faixa que rola pro LADO,
-- no topo: fica à vista sem empurrar o cardápio pra baixo.
--
-- false = fora da faixa (é o caso de todo produto que já existe).
-- =========================================================

ALTER TABLE public.produtos
  ADD COLUMN IF NOT EXISTS destaque boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.produtos.destaque IS
  'Aparece na faixa "Destaques" do topo da Loja Online (rola pro lado). Marcado pela loja.';
