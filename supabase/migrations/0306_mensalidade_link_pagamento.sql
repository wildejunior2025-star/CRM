-- Link de pagamento da mensalidade (enviado pelo WhatsApp da FWC).
-- Cada loja tem um token fixo: gestor.fwcinter.com/pagar/{token} abre uma página
-- pública com o PIX (reaproveita o pendente ou gera um novo). O token só dá
-- acesso a pagar a mensalidade daquela loja; não mostra mais nada.
ALTER TABLE public.mensalidade_config
  ADD COLUMN IF NOT EXISTS link_token uuid NOT NULL DEFAULT gen_random_uuid();

CREATE UNIQUE INDEX IF NOT EXISTS mensalidade_config_link_token_idx
  ON public.mensalidade_config (link_token);
