-- Quem quer receber o cardápio do dia, e quem não quer.
--
-- A primeira campanha da Estação vai perguntar "posso te mandar o cardápio por
-- aqui, ou prefere não receber?" com botão pra responder. Perguntar sem anotar
-- a resposta seria pior do que não perguntar: o cliente diz não, recebe de novo
-- na campanha seguinte e aí sim denuncia o número. Aqui fica o registro.
--
-- null  = ainda não foi perguntado
-- true  = deixou mandar
-- false = pediu pra não receber (nunca mais entra em fila de campanha)

ALTER TABLE public.clientes
  ADD COLUMN IF NOT EXISTS aceita_campanha        boolean,
  ADD COLUMN IF NOT EXISTS campanha_respondida_em timestamptz;

COMMENT ON COLUMN public.clientes.aceita_campanha IS
  'Opt-in do cardápio do dia. false = não entra em campanha nenhuma, sem exceção.';

-- Quando o template mistura botão de resposta rápida com botão de link, a Meta
-- exige as respostas rápidas primeiro — então o link deixa de ser o índice 0.
-- Mandar o parâmetro no índice errado volta erro 132000 e trava a campanha.
ALTER TABLE public.campanha_fila
  ADD COLUMN IF NOT EXISTS botao_index text NOT NULL DEFAULT '0';
