-- =========================================================
-- 0213: quem falou — o robô ou a loja?
-- =========================================================
-- A conversa do WhatsApp guarda 'user' (o cliente) e 'assistant' (a loja). Até
-- hoje só o robô escrevia como 'assistant', então não fazia falta separar.
--
-- Agora o atendente responde pelo gestor, e a resposta dele sai pelo mesmo
-- número, como 'assistant' também. Na tela as duas ficariam idênticas: quem
-- abre a conversa não saberia se aquilo foi o robô ou o colega do balcão — e
-- essa é justamente a informação que decide se ele responde ou não.
--
-- NULL = robô (é o caso de tudo o que já existe). 'loja' = pessoa escrevendo
-- pelo gestor.
-- =========================================================

ALTER TABLE public.whatsapp_conversas
  ADD COLUMN IF NOT EXISTS origem text;

COMMENT ON COLUMN public.whatsapp_conversas.origem IS
  'Quem escreveu a mensagem do assistant: NULL = robô, ''loja'' = atendente pelo gestor.';
