-- 0283_codigo_barras_produto.sql
-- Código de barras do produto: bipar na venda em vez de procurar pelo nome.
--
-- O leitor de código de barras é um TECLADO pro computador: ele digita os
-- números e dá Enter. Então o sistema não precisa de driver nem de aparelho
-- ligado nele — precisa só saber de quem é aquele número. É o que falta aqui.
--
-- Texto, não número: código de barras tem zero à esquerda (0790012...), e
-- guardar como número comeria esse zero. Alguns códigos internos de balança
-- também levam letra.
ALTER TABLE public.produtos
  ADD COLUMN IF NOT EXISTS codigo_barras text;

COMMENT ON COLUMN public.produtos.codigo_barras IS
  'Código de barras (EAN/UPC ou código interno da loja). Bipado na Nova venda e no Salão (mig 0283).';

-- Um código aponta pra UM produto dentro da loja — senão bipar viraria escolha
-- de qual dos dois, que é justamente o que a bipada existe pra evitar. Entre
-- lojas diferentes pode repetir (a mesma Coca-Cola está em todas).
-- Produto arquivado fica de fora: o código dele pode ser reaproveitado.
CREATE UNIQUE INDEX IF NOT EXISTS produtos_codigo_barras_unico
  ON public.produtos (empresa_id, codigo_barras)
  WHERE codigo_barras IS NOT NULL AND arquivado_em IS NULL;

NOTIFY pgrst, 'reload schema';
