-- =========================================================
-- 0222: pedido agendado na Loja Online
-- =========================================================
-- Quem quer almoçar 11h decide isso às 8h, e às 8h a loja está fechada — o
-- cardápio simplesmente não deixava pedir. O pedido ia pro concorrente que
-- aceita agendamento, ou virava mensagem solta no WhatsApp ("me guarda duas
-- quentinhas"), que ninguém anota direito.
--
-- Agora o cliente escolhe dia e hora dentro da grade de funcionamento da loja
-- (mig 0097 + exceções da 0142) e o pedido fica guardado. No painel ele entra
-- numa aba própria — não toca, não imprime — e só cai na fila da cozinha perto
-- da hora combinada.
--
-- `agendado_para` NULL = pedido pra agora, do jeito que sempre foi.
-- =========================================================

ALTER TABLE public.empresas
  -- A loja liga o agendamento. Desligado por padrão: quem não quer, nada muda.
  ADD COLUMN IF NOT EXISTS agendamento_ativo boolean NOT NULL DEFAULT false,
  -- Até quantos dias à frente dá pra agendar (hoje = 0).
  ADD COLUMN IF NOT EXISTS agendamento_dias integer NOT NULL DEFAULT 2,
  -- Antecedência mínima: ninguém agenda pra daqui 5 minutos.
  ADD COLUMN IF NOT EXISTS agendamento_antecedencia_min integer NOT NULL DEFAULT 60,
  -- Quantos minutos antes da hora combinada o pedido cai na fila da cozinha.
  ADD COLUMN IF NOT EXISTS agendamento_libera_min integer NOT NULL DEFAULT 45;

COMMENT ON COLUMN public.empresas.agendamento_ativo IS
  'Loja Online aceita pedido agendado (com a loja aberta ou fechada).';
COMMENT ON COLUMN public.empresas.agendamento_libera_min IS
  'Minutos antes do horario agendado em que o pedido sai da aba Agendados e entra na fila da cozinha.';

ALTER TABLE public.pedidos_delivery
  ADD COLUMN IF NOT EXISTS agendado_para timestamptz;

COMMENT ON COLUMN public.pedidos_delivery.agendado_para IS
  'Hora combinada com o cliente. NULL = pedido pra agora.';

-- O painel pergunta "o que está agendado pra frente?" o tempo todo.
CREATE INDEX IF NOT EXISTS pedidos_delivery_agendado_idx
  ON public.pedidos_delivery (empresa_id, agendado_para)
  WHERE agendado_para IS NOT NULL;
