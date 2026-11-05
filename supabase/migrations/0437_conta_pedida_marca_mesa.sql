-- 0437_conta_pedida_marca_mesa.sql
-- A mesa que JÁ PEDIU A CONTA (clicou na impressora da pré-conta) fica roxa no
-- quadro de mesas, pra equipe dar mais atenção a ela.
--
-- Não dá pra reaproveitar preconta_pedida_em (mig 0186): aquele carimbo é um
-- PEDIDO de impressão — a estação da loja imprime toda vez que o vê. Gravar ele
-- também quando a pré-conta já saiu no aparelho de quem clicou faria sair o
-- papel duas vezes. Esta coluna é só a marca visual, não dispara nada.

ALTER TABLE public.comandas
  ADD COLUMN IF NOT EXISTS conta_pedida_em timestamptz;

COMMENT ON COLUMN public.comandas.conta_pedida_em IS
  'Quando alguém tocou na pré-conta desta comanda. Só pinta a mesa de roxo; não imprime nada (mig 0437).';

NOTIFY pgrst, 'reload schema';
