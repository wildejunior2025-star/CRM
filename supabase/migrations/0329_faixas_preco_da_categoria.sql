-- Preço por quantidade DA CATEGORIA (ex.: espetos 3 por R$ 3,33).
-- Até aqui a faixa era do produto e contava só as unidades dele; quem pedia um
-- espeto de carne, um de frango e um de queijo pagava R$ 4,00 em cada. Com a
-- faixa na categoria a quantidade é a SOMA de tudo que o cliente levou dela, e o
-- estoque e o custo continuam por produto. Formato igual ao do produto:
-- [{ "qtd_min": 3, "preco": 3.33 }]. Vazio = a categoria não tem faixa própria
-- e cada produto segue a dele (mig 0329).
ALTER TABLE public.categorias
  ADD COLUMN IF NOT EXISTS faixas_preco jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN public.categorias.faixas_preco IS
  'Faixas de preço por quantidade somada da categoria: [{qtd_min, preco}]. Se tiver faixa aqui, ela vale no lugar da faixa de cada produto (mig 0329).';

UPDATE public.categorias
   SET faixas_preco = '[{"qtd_min":3,"preco":3.33}]'::jsonb
 WHERE empresa_id = '609edeac-5f43-4555-83ec-9b748238c438' AND nome ILIKE 'churrasco';
