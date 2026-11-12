-- =========================================================
-- 0449: chave "Vendo sob encomenda" (agenda com vagas), por loja
-- =========================================================
-- Confeitaria (e, depois, serviço de eventos) vende com DATA e VAGAS limitadas:
-- o cliente escolhe o dia num calendário e o dia lotado fecha.
--
-- Isso só existe pra quem tem esse tipo de serviço. Por isso é uma chave por
-- loja, DESLIGADA em todas: em `empresas.modulos` "ausente = liberado", o
-- contrário do que se quer aqui, então a chave é uma coluna própria.
--
-- Este passo é só a chave. Nenhuma tela do cliente muda ainda: o calendário, a
-- antecedência e o checkout vêm nos próximos passos e só rodam com a chave ligada.
-- =========================================================

ALTER TABLE public.empresas
  ADD COLUMN IF NOT EXISTS encomenda_ativa boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.empresas.encomenda_ativa IS
  'Loja vende sob encomenda (data + vagas por dia). Desligada por padrao; so o Super Admin liga.';
