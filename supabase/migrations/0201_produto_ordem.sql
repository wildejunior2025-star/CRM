-- =========================================================
-- 0201: ordem dos produtos DENTRO da categoria
-- =========================================================
-- Dava pra arrastar as categorias, mas os produtos dentro de cada uma saíam
-- sempre em ordem alfabética. Quem monta cardápio não pensa em ordem
-- alfabética: quer o carro-chefe em cima e o que sai pouco embaixo. Na CD Bom o
-- "Açaí + Creme de Amendoim" abria a categoria Açaí só porque começa com A.
--
-- NULL = nunca foi ordenado, e cai no fim em ordem alfabética. Assim ninguém
-- precisa arrastar as 78 linhas pra começar a usar: mexeu numa categoria, ela
-- inteira ganha a ordem 1..n; as outras seguem como estavam.
--
-- Vale na tela de Produtos, na Loja Online e no cardápio do QR da mesa — os
-- três leem a mesma coluna.
-- =========================================================

ALTER TABLE public.produtos
  ADD COLUMN IF NOT EXISTS ordem integer;

COMMENT ON COLUMN public.produtos.ordem IS
  'Posição do produto dentro da categoria (1..n). NULL = sem ordem definida, vai pro fim em ordem alfabética.';

-- A lista sempre filtra por empresa e ordena por categoria + ordem.
CREATE INDEX IF NOT EXISTS produtos_empresa_categoria_ordem_idx
  ON public.produtos (empresa_id, categoria, ordem);
