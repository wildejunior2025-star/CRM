-- 0185_setor_nenhum.sql
-- Terceiro setor: 'nenhum' = não sai papel em lugar nenhum.
--
-- Caso real da Saidera (23/08/2026): o garçom atende a mesa, pega a bebida ele
-- mesmo na geladeira e dá baixa no celular. Papel ali não serve pra nada — só
-- gasta bobina e enche a bancada de comanda que ninguém lê. Em outras lojas a
-- bebida é entregue por outra pessoa e o papel faz falta, por isso é escolha
-- da loja e não uma regra fixa.
--
-- O item continua na conta normalmente. 'nenhum' fala só de IMPRESSÃO.

ALTER TABLE public.categorias DROP CONSTRAINT IF EXISTS categorias_setor_ck;
ALTER TABLE public.categorias
  ADD CONSTRAINT categorias_setor_ck CHECK (setor IN ('salao', 'cozinha', 'nenhum'));

COMMENT ON COLUMN public.categorias.setor IS
  'cozinha = sai na térmica da cozinha. salao (padrão) = sai na da frente. nenhum = não imprime comanda em lugar nenhum (mig 0184/0185).';

NOTIFY pgrst, 'reload schema';
