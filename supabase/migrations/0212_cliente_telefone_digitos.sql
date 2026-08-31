-- =========================================================
-- 0212: buscar cliente pelo TELEFONE, não só pelo nome
-- =========================================================
-- No Vender+ a busca de cliente só olhava o nome. Quem está no balcão com o
-- cliente na frente costuma ter o número na mão (o cliente dita o telefone
-- antes de dizer como está cadastrado), e digitar o número não achava nada.
--
-- Procurar direto na coluna `telefone` não resolve: ela guarda o que foi
-- digitado, e cada cadastro veio de um jeito —
--   (84) 99818-0774 · 84 8620-4148 · 84987749958
-- Buscar "84998" acha o terceiro e perde os outros dois.
--
-- Esta coluna guarda o mesmo telefone só com os dígitos, calculada pelo banco
-- (GENERATED ALWAYS): não tem como ficar desatualizada nem exige mudar quem
-- grava. Ela é o campo que a busca usa; a coluna `telefone` continua sendo a
-- que aparece na tela, formatada como a loja escreveu.
-- =========================================================

ALTER TABLE public.clientes
  ADD COLUMN IF NOT EXISTS telefone_digitos text
  GENERATED ALWAYS AS (regexp_replace(COALESCE(telefone, ''), '\D', '', 'g')) STORED;

COMMENT ON COLUMN public.clientes.telefone_digitos IS
  'Telefone só com dígitos, calculado pelo banco. Serve pra busca — na tela mostre telefone.';

-- A busca é sempre dentro de uma loja e por pedaço do número ("termina em
-- 0774"), então o índice é o de trigrama, não o de igualdade.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS clientes_telefone_digitos_trgm_idx
  ON public.clientes USING gin (telefone_digitos gin_trgm_ops);
