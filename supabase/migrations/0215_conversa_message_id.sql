-- =========================================================
-- 0215: guardar o id da mensagem da Meta, pra saber se ENTREGOU
-- =========================================================
-- A Meta responde 200 na hora e só depois, por webhook, diz se entregou ou
-- falhou. Sem guardar o id da mensagem, esse aviso chega e não tem onde
-- encaixar: o histórico continua dizendo "enviado" pra mensagem que morreu no
-- caminho.
--
-- Foi o que aconteceu no teste do fiado da Estação (31/08/2026): a comanda saiu
-- às 14:07, o banco gravou falhou=false, e um minuto depois a Meta avisou
-- "131047 — mais de 24h desde a última resposta do cliente". A loja ficaria
-- achando que o cliente foi avisado. É o pior tipo de erro: o que se disfarça
-- de sucesso.
--
-- whatsapp_envios (campanhas) já casava o status por aqui. Esta coluna estende
-- o mesmo casamento para a conversa normal.
-- =========================================================

ALTER TABLE public.whatsapp_conversas
  ADD COLUMN IF NOT EXISTS message_id text;

COMMENT ON COLUMN public.whatsapp_conversas.message_id IS
  'id da mensagem na Meta (wamid). Serve pro webhook de status marcar falhou/erro depois.';

CREATE INDEX IF NOT EXISTS whatsapp_conversas_message_id_idx
  ON public.whatsapp_conversas (message_id)
  WHERE message_id IS NOT NULL;
