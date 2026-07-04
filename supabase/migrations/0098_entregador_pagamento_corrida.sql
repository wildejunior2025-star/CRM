-- Controle de pagamento da corrida (taxa de entrega) ao entregador.
-- entregador_pago = a loja já acertou essa entrega com o motoqueiro.
ALTER TABLE public.pedidos_delivery
  ADD COLUMN IF NOT EXISTS entregador_pago boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS entregador_pago_em timestamptz;

-- Índice pra separar rápido pago/pendente por entregador.
CREATE INDEX IF NOT EXISTS idx_pedidos_entregador_pago
  ON public.pedidos_delivery (entregador_id, entregador_pago)
  WHERE entregador_id IS NOT NULL;
