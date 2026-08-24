-- Disparo por template oficial da Meta (Cloud API).
--
-- A fila nasceu mandando texto livre pela Evolution, porque em 21/08/2026 o
-- número da própria Estação estava restringido. Hoje ela tem WABA aprovada, e
-- o caminho legítimo pra puxar conversa com quem não fala com a loja há mais
-- de 24h é o TEMPLATE — a Meta recusa texto livre nesse caso (erro 131047).
--
-- Aqui a linha da fila passa a poder carregar o template em vez do texto:
-- nome, idioma, as variáveis do corpo e o parâmetro do botão de URL (o token
-- do cliente). A coluna `mensagem` continua guardando o texto montado, só que
-- agora como REGISTRO do que o cliente leu — não é mais o que vai no cano.

ALTER TABLE public.campanha_fila
  ADD COLUMN IF NOT EXISTS template_nome   text,
  ADD COLUMN IF NOT EXISTS template_lang   text NOT NULL DEFAULT 'pt_BR',
  ADD COLUMN IF NOT EXISTS template_params jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS botao_param     text,
  ADD COLUMN IF NOT EXISTS message_id      text;

-- O wamid é o que liga o envio ao recibo de entrega/leitura que chega depois
-- no whatsapp-webhook. Sem ele a campanha só sabe "a Meta aceitou".
CREATE INDEX IF NOT EXISTS campanha_fila_message_id_idx
  ON public.campanha_fila (message_id) WHERE message_id IS NOT NULL;

COMMENT ON COLUMN public.campanha_fila.template_nome IS
  'Nome do template aprovado na WABA. Preenchido = manda por template na Cloud API; vazio = texto livre pela Evolution.';
