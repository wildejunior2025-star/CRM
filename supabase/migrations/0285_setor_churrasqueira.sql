-- 0285_setor_churrasqueira.sql
-- Praça nova: CHURRASQUEIRA.
--
-- A Saidera tem cozinha e tem churrasqueiro, e são duas pessoas diferentes. O
-- churrasco é marcado como "salão" (é assim que o papel dele sai na impressora
-- da frente, e isso continua igual), mas aí ele não aparecia em tela nenhuma: a
-- tela da Cozinha mostra só o que é da cozinha, e o churrasqueiro ficava sem
-- lista — o garçom é que ia até a brasa avisar.
--
-- Com o setor próprio, o aparelho da churrasqueira mostra SÓ churrasco e o da
-- cozinha continua sem ver espetinho.
--
-- A impressão não muda de propósito: tanto o app da impressora (print-agent)
-- quanto a térmica Bluetooth tratam qualquer setor que não seja 'cozinha' como
-- papel da frente. Ou seja, a loja pode marcar a categoria hoje sem risco de o
-- papel parar de sair.
ALTER TABLE public.categorias DROP CONSTRAINT IF EXISTS categorias_setor_ck;

ALTER TABLE public.categorias
  ADD CONSTRAINT categorias_setor_ck
  CHECK (setor = ANY (ARRAY['salao'::text, 'cozinha'::text, 'churrasqueira'::text, 'nenhum'::text]));

COMMENT ON COLUMN public.categorias.setor IS
  'Onde o item é preparado/impresso: salao, cozinha, churrasqueira ou nenhum (migs 0184/0285).';

NOTIFY pgrst, 'reload schema';
