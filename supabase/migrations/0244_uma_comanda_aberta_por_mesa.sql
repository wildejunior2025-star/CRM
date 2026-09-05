-- 0244_uma_comanda_aberta_por_mesa.sql
-- Uma mesa só pode ter UMA comanda aberta.
--
-- Saidera, madrugada de 05/09. A internet do salão engasgou e a garçonete tocou
-- de novo em "abrir mesa". O sistema criou DUAS comandas pra mesma mesa — 0,1
-- segundo de diferença num caso, 3 segundos em outro. Quatro vezes na mesma
-- noite.
--
-- Daí saem as duas queixas da dona, que pareciam coisas diferentes:
--   * "fecho a conta e de vez em quando a mesa volta": ela fechava uma comanda,
--     a mesa ficava livre por um instante e voltava ocupada — porque a OUTRA
--     comanda daquela mesa continuava aberta;
--   * comandas fantasma, com zero itens, canceladas na mão depois.
--
-- A tela conferia se a mesa já tinha comanda ANTES de criar — mas conferia na
-- memória dela. No segundo toque a resposta do primeiro ainda não tinha
-- chegado, e pra tela a mesa continuava vazia. Verificação que mora no cliente
-- não resolve corrida: quem tem que dizer não é o banco.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_comanda_aberta_por_mesa
  ON public.comandas (mesa_id)
  WHERE mesa_id IS NOT NULL AND status IN ('aberta', 'aguardando_conferencia');

COMMENT ON INDEX public.uniq_comanda_aberta_por_mesa IS
  'Uma comanda aberta por mesa. O segundo toque em "abrir mesa" (internet lenta) criava uma comanda gêmea, e a mesa "voltava" depois de fechada porque a gêmea seguia aberta (mig 0244).';
