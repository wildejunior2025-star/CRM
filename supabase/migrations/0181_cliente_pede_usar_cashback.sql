-- O cliente pede pra usar o crédito ao mandar o pedido pelo link dele.
--
-- O desconto NÃO acontece agora: pelo link ele monta a comanda e paga com a
-- loja depois, e até lá pode pedir mais coisa. Descontar no pedido daria o
-- crédito sobre um total que ainda vai mudar.
--
-- Então aqui é só a INTENÇÃO: fica marcada na comanda e, quando o atendente
-- abre o fechamento, a caixinha do cashback já vem marcada com o aviso de que
-- foi o cliente que pediu. Quem confirma continua sendo a loja, que é quem
-- recebe o dinheiro.
--
-- (Conteúdo aplicado no banco em 22/08/2026 — ver `cliente_pedir` com
--  p_usar_cashback e a função `cliente_saldo_link`.)
ALTER TABLE public.comandas
  ADD COLUMN IF NOT EXISTS usar_cashback boolean NOT NULL DEFAULT false;
